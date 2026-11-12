import type { ApiRequest, BodyField, KeyValue } from '../types';
/**
 * Readers for a Swagger 2 / OpenAPI 3 document: values of a given shape, local `$ref`s followed,
 * and an example value built from a schema.
 */
export function openAPIHelpers(document: Record<string, unknown>) {
  type ObjectValue = Record<string, unknown>;
  const object = (value: unknown): ObjectValue =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const text = (value: unknown): string =>
    value === undefined || value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const dereference = (value: unknown): ObjectValue => {
    let result = object(value);
    const seen = new Set<string>();
    while (typeof result.$ref === 'string') {
      const reference = result.$ref;
      if (!reference.startsWith('#/'))
        throw new Error(
          'External OpenAPI references are not supported. Bundle the document first.',
        );
      if (seen.has(reference)) throw new Error(`Circular OpenAPI reference: ${reference}`);
      seen.add(reference);
      let target: unknown = document;
      for (const part of reference.slice(2).split('/'))
        target = object(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (!target) throw new Error(`Missing OpenAPI reference: ${reference}`);
      result = object(target);
    }
    return result;
  };
  const schemaExample = (raw: unknown, depth = 0): unknown => {
    if (depth > 8) return '';
    const schema = dereference(raw);
    const explicit =
      schema.example ?? list(schema.examples)[0] ?? schema.default ?? list(schema.enum)[0];
    if (explicit !== undefined) return explicit;
    if (schema.allOf)
      return Object.assign(
        {},
        ...list(schema.allOf).map((item) => object(schemaExample(item, depth + 1))),
      );
    if (schema.oneOf || schema.anyOf)
      return schemaExample(list(schema.oneOf || schema.anyOf)[0], depth + 1);
    if (schema.properties || schema.type === 'object')
      return Object.fromEntries(
        Object.entries(object(schema.properties)).map(([key, value]) => [
          key,
          schemaExample(value, depth + 1) ?? `{{${key}}}`,
        ]),
      );
    if (schema.type === 'array') return [schemaExample(schema.items, depth + 1) ?? ''];
    if (schema.type === 'boolean') return false;
    if (schema.type === 'number' || schema.type === 'integer') return 0;
    if (schema.type === 'string') return '';
    return undefined;
  };
  return { object, list, text, dereference, schemaExample };
}
type ObjectValue = Record<string, unknown>;
/** Converts Swagger 2 / OpenAPI 3 documents into the existing collection format. */
export function openAPICollection(document: Record<string, unknown>): {
  requests: Partial<ApiRequest>[];
} {
  const { object, list, text, dereference, schemaExample } = openAPIHelpers(document);
  const swagger = document.swagger === '2.0';
  if (!swagger && !/^3\.(0|1|2)(\.|$)/.test(String(document.openapi)))
    throw new Error('Supported specifications: Swagger 2.0 and OpenAPI 3.x.');
  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths))
    throw new Error('The specification must contain a paths object.');
  const serverURL = (servers: unknown): string => {
    const server = object(list(servers)[0]);
    return text(server.url).replace(
      /\{([^{}]+)\}/g,
      (_, name: string) => text(object(object(server.variables)[name]).default) || `{{${name}}}`,
    );
  };
  const rootURL = swagger
    ? `${text(list(document.schemes)[0]) || 'https'}://${text(document.host) || '{{host}}'}${text(document.basePath)}`
    : serverURL(document.servers) || '{{base_url}}';
  const requests: Partial<ApiRequest>[] = [];
  for (const [path, rawPath] of Object.entries(object(document.paths))) {
    if (!path.startsWith('/')) continue;
    const pathItem = dereference(rawPath);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      if (!pathItem[method]) continue;
      const operation = dereference(pathItem[method]);
      const parameters = new Map<string, ObjectValue>();
      for (const raw of [...list(pathItem.parameters), ...list(operation.parameters)]) {
        const parameter = dereference(raw);
        if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string')
          throw new Error(`Invalid parameter in ${method.toUpperCase()} ${path}`);
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      let requestPath = path;
      const params: KeyValue[] = [],
        headers: KeyValue[] = [];
      for (const parameter of parameters.values()) {
        const schema = dereference(parameter.schema);
        const exampleObject = dereference(Object.values(object(parameter.examples))[0]);
        const value =
          parameter.example ??
          exampleObject.value ??
          schema.example ??
          schema.default ??
          parameter.default;
        const row = {
          key: text(parameter.name),
          value: text(value),
          enabled: parameter.required === true || value !== undefined,
          description: text(parameter.description),
        };
        if (parameter.in === 'query') params.push(row);
        if (parameter.in === 'header') headers.push(row);
        if (parameter.in === 'path')
          requestPath = requestPath.replace(
            `{${text(parameter.name)}}`,
            value === undefined ? `{{${text(parameter.name)}}}` : encodeURIComponent(text(value)),
          );
      }
      requestPath = requestPath.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, '{{$1}}');
      const requestBody = dereference(operation.requestBody);
      const content = object(requestBody.content);
      const mediaType =
        Object.keys(content).find((key) => key === 'application/json') || Object.keys(content)[0];
      const media = object(content[mediaType]);
      const bodyParameter = [...parameters.values()].find((parameter) => parameter.in === 'body');
      const schema = dereference(media.schema || bodyParameter?.schema);
      const exampleObject = dereference(Object.values(object(media.examples))[0]);
      const bodyExample = media.example ?? exampleObject.value ?? schemaExample(schema);
      const body =
        bodyExample === undefined
          ? ''
          : typeof bodyExample === 'string'
            ? bodyExample
            : JSON.stringify(bodyExample, null, 2);
      const consumes = text(list(operation.consumes || document.consumes)[0]);
      if (mediaType || consumes)
        headers.push({
          key: 'Content-Type',
          value: mediaType || consumes,
          enabled: true,
          description: 'Request content type',
        });
      const produces = text(list(operation.produces || document.produces)[0]);
      if (produces) headers.push({ key: 'Accept', value: produces, enabled: true });
      const base = swagger
        ? rootURL
        : serverURL(operation.servers) || serverURL(pathItem.servers) || rootURL;
      const bodyFields: BodyField[] = [];
      const formParameters = [...parameters.values()].filter(
        (parameter) => parameter.in === 'formData',
      );
      const kind = mediaType || consumes;
      if (kind === 'application/x-www-form-urlencoded' || kind === 'multipart/form-data') {
        if (swagger)
          for (const p of formParameters)
            bodyFields.push({
              key: text(p.name),
              value: text(p.example ?? p.default),
              enabled: p.required === true || p.default !== undefined,
              description: text(p.description),
              kind: p.type === 'file' ? 'file' : 'text',
            });
        else
          for (const [key, value] of Object.entries(object(schema.properties))) {
            const property = dereference(value);
            bodyFields.push({
              key,
              value: text(object(bodyExample)[key] ?? schemaExample(property)),
              enabled: list(schema.required).includes(key) || property.example !== undefined,
              description: text(property.description),
              kind: property.format === 'binary' ? 'file' : 'text',
            });
          }
      }
      const request: Partial<ApiRequest> = {
        name: text(operation.summary || operation.operationId) || `${method.toUpperCase()} ${path}`,
        folder:
          text(list(operation.tags)[0]) || text(object(document.info).title) || 'Imported API',
        method: method.toUpperCase(),
        url: base.replace(/\/$/, '') + requestPath,
        params,
        headers,
        body,
        ...(kind === 'application/x-www-form-urlencoded' || kind === 'multipart/form-data'
          ? {
              bodyType: kind === 'multipart/form-data' ? 'form-data' : 'x-www-form-urlencoded',
              bodyFields,
            }
          : body
            ? { bodyType: 'raw', rawContentType: kind || 'application/json' }
            : {}),
      };
      const security = list(operation.security ?? document.security);
      const schemes = object(
        swagger ? document.securityDefinitions : object(document.components).securitySchemes,
      );
      for (const name of Object.keys(object(security[0]))) {
        const scheme = dereference(schemes[name]);
        if (scheme.type === 'basic' || (scheme.type === 'http' && scheme.scheme === 'basic')) {
          request.auth = 'Basic auth';
          request.username = '{{username}}';
          request.password = '{{password}}';
        } else if (
          scheme.type === 'oauth2' ||
          scheme.type === 'openIdConnect' ||
          (scheme.type === 'http' && scheme.scheme === 'bearer')
        ) {
          request.auth = 'Bearer token';
          request.token = '{{access_token}}';
        } else if (scheme.type === 'apiKey') {
          const row = { key: text(scheme.name), value: `{{${name}}}`, enabled: true };
          if (scheme.in === 'query') params.push(row);
          else if (scheme.in === 'header') headers.push(row);
          else if (scheme.in === 'cookie')
            headers.push({ key: 'Cookie', value: `${row.key}=${row.value}`, enabled: true });
        }
      }
      requests.push(request);
    }
  }
  if (!requests.length) throw new Error('No supported HTTP operations found in the specification.');
  return { requests };
}
