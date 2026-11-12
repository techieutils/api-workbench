import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { CollectionData, Obj } from './common';
import { object, text } from './common';
const many = (value: unknown): Obj[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(object);
const local = (value: unknown): string => text(value).split(':').pop() || '';
export const xml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
export function wsdl(source: string, warnings: string[]): CollectionData {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('WSDL entity declarations and DTDs are not supported.');
  const valid = XMLValidator.validate(source);
  if (valid !== true) throw new Error(`Invalid WSDL XML: ${valid.err.msg}`);
  const namespaceURIs = new Map(
    [...source.matchAll(/xmlns:([\w.-]+)=["']([^"']+)["']/g)].map((m) => [m[1], m[2]]),
  );
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    transformTagName: (tag) => {
      const [prefix, name] = tag.includes(':') ? tag.split(':') : ['', tag];
      const uri = namespaceURIs.get(prefix);
      if (uri === 'http://schemas.xmlsoap.org/wsdl/soap12/') return 'soap12' + name;
      if (uri === 'http://schemas.xmlsoap.org/wsdl/soap/') return 'soap11' + name;
      return name;
    },
  }).parse(source);
  const doc = object(parsed.definitions || parsed.description);
  if (!Object.keys(doc).length)
    throw new Error('Choose a WSDL definitions or description document.');
  const ns = text(doc['@_targetNamespace']) || 'urn:imported';
  const name = text(doc['@_name']) || 'SOAP service';
  const schemas = many(object(doc.types).schema);
  const elements = new Map(
    schemas.flatMap((s) => many(s.element).map((e) => [text(e['@_name']), e] as const)),
  );
  const complexTypes = new Map(
    schemas.flatMap((s) => many(s.complexType).map((e) => [text(e['@_name']), e] as const)),
  );
  const sample = (element: Obj, seen = new Set<string>(), qualified = true): string => {
    const name = local(element['@_name'] || element['@_ref']) || 'value';
    const tag = (qualified || element['@_ref'] ? 'tns:' : '') + name;
    if (seen.has(tag) || seen.size > 8) return `<${tag}>{{${name}}}</${tag}>`;
    const next = new Set(seen).add(tag);
    const definition = elements.get(local(element['@_ref'])) || element;
    const type = object(definition.complexType || complexTypes.get(local(definition['@_type'])));
    const children = many(object(type.sequence || type.all).element);
    return `<${tag}>${children.length ? children.map((e) => sample(e, next, e['@_form'] === 'qualified' || (e['@_form'] !== 'unqualified' && schemas.some((s) => s['@_elementFormDefault'] === 'qualified')))).join('') : xml(text(definition['@_default']) || `{{${name}}}`)}</${tag}>`;
  };
  const messages = new Map(many(doc.message).map((m) => [text(m['@_name']), m]));
  const interfaces = new Map(
    many(doc.portType || doc.interface).map((p) => [text(p['@_name']), p]),
  );
  const bindings = new Map(many(doc.binding).map((b) => [text(b['@_name']), b]));
  const requests: CollectionData['requests'] = [];
  for (const service of many(doc.service)) {
    for (const port of many(service.port || service.endpoint)) {
      const binding = bindings.get(local(port['@_binding'])) || {};
      const iface =
        interfaces.get(
          local(binding['@_type'] || binding['@_interface'] || service['@_interface']),
        ) || {};
      const endpoint =
        text(
          object(port.soap12address || port.soap11address || port.address)['@_location'] ||
            port['@_address'],
        ) || '{{soap_endpoint}}';
      const operations = many(binding.operation).length
        ? many(binding.operation)
        : many(iface.operation);
      for (const operation of operations) {
        const operationName = local(operation['@_name'] || operation['@_ref']);
        const abstract =
          many(iface.operation).find((o) => o['@_name'] === operationName) || operation;
        const input = object(abstract.input);
        const message = messages.get(local(input['@_message'])) || {};
        const parts = many(message.part);
        let content = parts
          .map((part) => {
            const element = elements.get(local(part['@_element']));
            return element
              ? sample(element)
              : `<${local(part['@_name']) || 'value'}>{{${local(part['@_name']) || 'value'}}}</${local(part['@_name']) || 'value'}>`;
          })
          .join('');
        const inputElement = elements.get(local(input['@_element']));
        if (inputElement) content = sample(inputElement);
        if (!content) content = `<tns:${operationName}/>`;
        else if (!inputElement && !parts.some((p) => p['@_element']))
          content = `<tns:${operationName}>${content}</tns:${operationName}>`;
        const action = text(
          object(operation.soap12operation || operation.soap11operation || operation.operation)[
            '@_soapAction'
          ] || operation['@_soapAction'],
        );
        const soap12 = Boolean(
          binding.soap12binding ||
          operation.soap12operation ||
          port.soap12address ||
          text(binding['@_type']).includes('www.w3.org/ns/wsdl/soap'),
        );
        requests.push({
          name: operationName,
          folder: text(service['@_name']) || name,
          method: 'POST',
          url: endpoint,
          params: [],
          headers: [
            {
              key: 'Content-Type',
              value: soap12
                ? `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`
                : 'text/xml; charset=utf-8',
              enabled: true,
            },
            ...(!soap12 && action
              ? [{ key: 'SOAPAction', value: `"${action}"`, enabled: true }]
              : []),
          ],
          bodyType: 'raw',
          rawContentType: soap12 ? 'application/soap+xml' : 'text/xml',
          body: `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:tns="${xml(ns)}" xmlns:soap="${soap12 ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/'}"><soap:Body>${content}</soap:Body></soap:Envelope>`,
        });
      }
    }
  }
  if (!requests.length)
    throw new Error(
      'No bound SOAP operations found. Include service endpoints and bindings in the WSDL.',
    );
  warnings.push(
    'SOAP envelopes are generated templates. Review schema placeholders, namespaces, and required fields before sending.',
  );
  if (doc.import || schemas.some((s) => s.import || s.include))
    warnings.push(
      'External WSDL/XSD imports are not fetched. Inline schemas for complete SOAP templates.',
    );
  return { requests };
}
