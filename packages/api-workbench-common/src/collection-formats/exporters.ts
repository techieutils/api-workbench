import { stringify } from 'yaml';
import { strToU8, zipSync } from 'fflate';
import type { ApiRequest, WorkspaceState } from '../types';
import type { Obj, TransferFile } from './common';
import { cleanExport } from './common';
import { exportBru, exportBruEnvironment } from './bruno';
import { xml } from './wsdl';
export const exportFormats = [
  {
    id: 'workbench',
    label: 'API Workbench',
    extension: 'json',
    detail: 'Complete workspace with every request protocol and environment.',
  },
  {
    id: 'postman',
    label: 'Postman v2.1',
    extension: 'json',
    detail: 'HTTP collections with folders, auth templates, variables, and bodies.',
  },
  {
    id: 'bruno',
    label: 'Bruno',
    extension: 'zip',
    detail: 'Native .bru request files, environments, and bruno.json in a ZIP.',
  },
  {
    id: 'opencollection',
    label: 'OpenCollection',
    extension: 'yaml',
    detail: 'Bundled YAML with folders and environments; ZIP includes gRPC proto files.',
  },
  {
    id: 'insomnia',
    label: 'Insomnia v5',
    extension: 'yaml',
    detail: 'HTTP collection in the native Insomnia YAML format.',
  },
  {
    id: 'insomnia-v4',
    label: 'Insomnia v4 JSON',
    extension: 'json',
    detail: 'Legacy HTTP collection and environments.',
  },
  {
    id: 'openapi-json',
    label: 'OpenAPI 3.1 JSON',
    extension: 'json',
    detail: 'HTTP operations, parameters, and request examples.',
  },
  {
    id: 'openapi-yaml',
    label: 'OpenAPI 3.1 YAML',
    extension: 'yaml',
    detail: 'HTTP operations, parameters, and request examples.',
  },
  {
    id: 'swagger',
    label: 'Swagger 2.0',
    extension: 'json',
    detail: 'HTTP API specification for older tooling.',
  },
  {
    id: 'wsdl',
    label: 'WSDL 1.1 / SOAP',
    extension: 'wsdl',
    detail: 'SOAP operations only; generates a basic service contract.',
  },
  {
    id: 'har',
    label: 'HAR 1.2',
    extension: 'har',
    detail: 'HTTP requests for browser and proxy tooling.',
  },
  {
    id: 'http',
    label: 'HTTP / REST Client',
    extension: 'http',
    detail: 'Plain text requests separated by ###.',
  },
  { id: 'curl', label: 'cURL', extension: 'sh', detail: 'Shell-quoted HTTP commands.' },
] as const;
export type ExportFormat = (typeof exportFormats)[number]['id'];
export interface ExportResult {
  name: string;
  type: string;
  data: Uint8Array;
  warnings: string[];
}
const named = (r: ApiRequest['headers']): Obj[] =>
  r.map((v) => ({ name: v.key, value: v.value, disabled: !v.enabled, description: v.description }));
const envData = (variables: ApiRequest['headers']): Record<string, string> =>
  Object.fromEntries(variables.filter((v) => v.enabled).map((v) => [v.key, v.value]));
function auth(r: ApiRequest): Obj {
  if (r.auth === 'Basic auth') return { type: 'basic', username: r.username, password: '' };
  if (r.auth === 'Bearer token') return { type: 'bearer', token: '' };
  if (r.auth === 'Digest auth') return { type: 'digest', username: r.username, password: '' };
  if (r.auth === 'AWS Signature')
    return {
      type: 'awsv4',
      accessKey: '',
      secretKey: '',
      region: r.authOptions?.awsRegion || '',
      service: r.authOptions?.awsService || '',
    };
  if (r.auth === 'OAuth 1.0')
    return {
      type: 'oauth1',
      consumerKey: '',
      consumerSecret: '',
      token: '',
      tokenSecret: '',
      signatureMethod: r.authOptions?.oauth1SignatureMethod || 'HMAC-SHA1',
      realm: r.authOptions?.oauth1Realm || '',
    };
  if (r.auth === 'NTLM')
    return {
      type: 'ntlm',
      username: r.username,
      password: '',
      domain: r.authOptions?.ntlmDomain || '',
      workstation: r.authOptions?.ntlmWorkstation || '',
    };
  if (r.auth === 'Akamai EdgeGrid')
    return {
      type: 'edgegrid',
      accessToken: '',
      clientToken: '',
      clientSecret: '',
      headersToSign: r.authOptions?.edgegridHeadersToSign || '',
    };
  if (r.auth === 'Hawk')
    return {
      type: 'hawk',
      authId: '',
      authKey: '',
      algorithm: r.authOptions?.hawkAlgorithm || 'sha256',
      extraData: r.authOptions?.hawkExt || '',
      app: r.authOptions?.hawkApp || '',
      delegation: r.authOptions?.hawkDlg || '',
      includePayloadHash: r.authOptions?.hawkPayloadHash === true,
    };
  if (r.auth === 'OAuth 2.0 (request)') {
    const grant = r.authOptions?.oauth2GrantType || 'authorization_code';
    return {
      type: 'oauth2',
      grant_type:
        grant === 'password'
          ? 'password_credentials'
          : grant === 'authorization_code'
            ? 'authorization_code_with_pkce'
            : grant,
      authUrl: r.authOptions?.oauth2AuthorizationUrl || '',
      accessTokenUrl: r.authOptions?.oauth2TokenUrl || '',
      clientId: r.authOptions?.oauth2ClientId || '',
      clientSecret: '',
      scope: r.authOptions?.oauth2Scope || '',
      client_authentication: r.authOptions?.oauth2ClientAuth === 'body' ? 'body' : 'header',
      accessToken: '',
    };
  }
  if (r.auth === 'JWT bearer')
    return {
      type: 'jwt',
      algorithm: r.authOptions?.jwtAlgorithm || 'HS256',
      secret: '',
      payload: r.authOptions?.jwtPayload || '{}',
      headerPrefix: r.authOptions?.jwtPrefix ?? 'Bearer',
    };
  return { type: 'none' };
}
function contentType(r: ApiRequest): string {
  return (
    r.headers.find((h) => h.enabled && h.key.toLowerCase() === 'content-type')?.value ||
    r.rawContentType ||
    'text/plain'
  );
}
function postmanBody(r: ApiRequest): Obj {
  if (r.bodyType === 'form-data' || r.bodyType === 'x-www-form-urlencoded') {
    const mode = r.bodyType === 'form-data' ? 'formdata' : 'urlencoded';
    return {
      mode,
      [mode]: (r.bodyFields || []).map((v) => ({
        key: v.key,
        value: v.value,
        type: v.kind === 'file' ? 'file' : 'text',
        src: v.kind === 'file' ? v.fileName : undefined,
        disabled: !v.enabled,
        description: v.description,
      })),
    };
  }
  if (r.bodyType === 'binary') return { mode: 'file', file: { src: r.binaryName || '' } };
  return {
    mode: 'raw',
    raw: r.body,
    options: {
      raw: {
        language: contentType(r).includes('json')
          ? 'json'
          : contentType(r).includes('xml')
            ? 'xml'
            : 'text',
      },
    },
  };
}
function textBody(r: ApiRequest): { body: string; headers: ApiRequest['headers'] } {
  const headers = r.headers
    .filter((h) => h.enabled && h.key.toLowerCase() !== 'content-length')
    .map((h) => ({ ...h }));
  const setContentType = (value: string): void => {
    const existing = headers.find((h) => h.key.toLowerCase() === 'content-type');
    if (existing) existing.value = value;
    else headers.push({ key: 'Content-Type', value, enabled: true });
  };
  if (r.bodyType === 'x-www-form-urlencoded') {
    setContentType('application/x-www-form-urlencoded');
    return {
      body: new URLSearchParams(
        (r.bodyFields || []).filter((f) => f.enabled).map((f) => [f.key, f.value]),
      ).toString(),
      headers,
    };
  }
  if (r.bodyType === 'form-data') {
    const boundary = 'APIWorkbenchExportBoundary';
    setContentType(`multipart/form-data; boundary=${boundary}`);
    const body =
      (r.bodyFields || [])
        .filter((f) => f.enabled)
        .map(
          (f) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${f.key.replace(/["\r\n]/g, '')}"${f.kind === 'file' ? `; filename="${(f.fileName || 'attachment').replace(/["\r\n]/g, '')}"` : ''}\r\n\r\n${f.kind === 'file' ? '' : f.value}\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    return { body, headers };
  }
  return { body: r.body, headers };
}
function insomniaBody(r: ApiRequest): Obj {
  if (r.bodyType === 'binary')
    return { mimeType: 'application/octet-stream', fileName: r.binaryName || '' };
  if (r.bodyType === 'form-data' || r.bodyType === 'x-www-form-urlencoded')
    return {
      mimeType:
        r.bodyType === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
      params: (r.bodyFields || []).map((v) => ({
        name: v.key,
        value: v.value,
        disabled: !v.enabled,
        type: v.kind || 'text',
        fileName: v.fileName,
      })),
    };
  return { mimeType: contentType(r), text: r.body };
}
function tree(
  requests: ApiRequest[],
  item: (r: ApiRequest) => Obj,
  folder: (name: string, children: Obj[]) => Obj,
): Obj[] {
  interface Node {
    children: Map<string, Node>;
    requests: ApiRequest[];
  }
  const root: Node = { children: new Map(), requests: [] };
  for (const r of requests) {
    let node = root;
    if ((r.folder || '').split('/').length > 25)
      throw new Error('Export folders exceed the supported depth.');
    for (const name of (r.folder || 'Imported').split('/').filter(Boolean)) {
      if (!node.children.has(name)) node.children.set(name, { children: new Map(), requests: [] });
      node = node.children.get(name)!;
    }
    node.requests.push(r);
  }
  const build = (node: Node): Obj[] =>
    [...node.children]
      .map(([name, child]) => folder(name, build(child)))
      .concat(node.requests.map(item));
  return build(root);
}
function urlParts(url: string): { base: string; path: string; query: string } {
  const match = url.match(/^((?:[a-z]+:\/\/[^/?#]+)|(?:\{\{[^{}]+\}\}))([^?#]*)?(?:\?([^#]*))?/i);
  if (!match)
    throw new Error(
      `Cannot export URL “${url}” to a specification. Use an absolute URL or {{base_url}}.`,
    );
  return {
    base: match[1],
    path: (match[2] || '/').replace(/\{\{([^{}]+)\}\}/g, '{$1}'),
    query: match[3] || '',
  };
}
function requestURL(r: ApiRequest): string {
  const beforeHash = r.url.split('#')[0];
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? '' : beforeHash.slice(queryAt + 1));
  const active = r.params.filter((p) => p.enabled);
  for (const key of new Set(r.params.map((p) => p.key))) params.delete(key);
  for (const p of active) params.append(p.key, p.value);
  return (
    base + (params.size ? '?' + params.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}') : '')
  );
}
function spec(
  requests: ApiRequest[],
  state: WorkspaceState,
  swagger: boolean,
  warnings: string[],
): Obj {
  if (!requests.length) throw new Error('No HTTP requests available for specification export.');
  const paths: Record<string, Obj> = {},
    first = urlParts(requests[0].url);
  const server = (base: string): Obj => {
    const variables: Obj = {};
    const url = base.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => {
      const value = state.environments
        .flatMap((e) => e.variables)
        .find((v) => v.key === name && v.enabled)?.value;
      variables[name] = { default: value || 'https://api.example.com' };
      return `{${name}}`;
    });
    return { url, ...(Object.keys(variables).length ? { variables } : {}) };
  };
  for (const r of requests) {
    const parts = urlParts(r.url),
      method = r.method.toLowerCase();
    if (
      !['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method) ||
      (swagger && method === 'trace')
    ) {
      warnings.push(`Skipped ${r.name}: ${r.method} is not supported by this specification.`);
      continue;
    }
    if (swagger && parts.base !== first.base) {
      warnings.push(`Skipped ${r.name}: Swagger 2.0 supports one server per document.`);
      continue;
    }
    const path = (paths[parts.path] ||= {});
    if (path[method]) {
      warnings.push(
        `Skipped duplicate operation ${r.method} ${parts.path}: specifications allow one example operation per method and path.`,
      );
      continue;
    }
    const params = [...r.params];
    for (const [key, value] of new URLSearchParams(parts.query))
      if (!params.some((p) => p.key === key)) params.push({ key, value, enabled: true });
    const parameter = (
      key: string,
      value: string,
      location: string,
      description?: string,
    ): Obj => ({
      name: key,
      in: location,
      required: location === 'path',
      description: description || '',
      ...(swagger
        ? { type: 'string', ...(location === 'path' && !value ? {} : { default: value }) }
        : {
            schema: { type: 'string' },
            ...(location === 'path' && !value ? {} : { example: value }),
          }),
    });
    const parameters = [
      ...params
        .filter((p) => p.enabled)
        .map((p) => parameter(p.key, p.value, 'query', p.description)),
      ...r.headers
        .filter((h) => h.enabled && !['content-type', 'accept'].includes(h.key.toLowerCase()))
        .map((h) => parameter(h.key, h.value, 'header', h.description)),
      ...[...parts.path.matchAll(/\{([^{}]+)\}/g)].map((m) => parameter(m[1], '', 'path')),
    ];
    let example: unknown = r.body;
    if (contentType(r).includes('json')) {
      try {
        example = JSON.parse(r.body);
      } catch {
        /* Keep the exact body as a string example. */
      }
    }
    const operation: Obj = {
      summary: r.name,
      tags: [r.folder],
      parameters,
      responses: { '200': { description: 'Successful response' } },
    };
    if (r.bodyType === 'form-data' || r.bodyType === 'x-www-form-urlencoded') {
      const fields = (r.bodyFields || []).filter((f) => f.enabled);
      if (swagger) {
        operation.consumes = [
          r.bodyType === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
        ];
        parameters.push(
          ...fields.map((f) => ({
            name: f.key,
            in: 'formData',
            type: f.kind === 'file' ? 'file' : 'string',
            default: f.value,
            description: f.description,
          })),
        );
      } else
        operation.requestBody = {
          content: {
            [r.bodyType === 'form-data'
              ? 'multipart/form-data'
              : 'application/x-www-form-urlencoded']: {
              schema: {
                type: 'object',
                properties: Object.fromEntries(
                  fields.map((f) => [
                    f.key,
                    {
                      type: 'string',
                      ...(f.kind === 'file' ? { format: 'binary' } : { example: f.value }),
                    },
                  ]),
                ),
              },
            },
          },
        };
    } else if (r.body) {
      if (swagger) {
        operation.consumes = [contentType(r)];
        parameters.push({ name: 'body', in: 'body', schema: { example } });
      } else operation.requestBody = { content: { [contentType(r)]: { example } } };
    }
    if (!swagger) operation.servers = [server(parts.base)];
    path[method] = operation;
  }
  if (!Object.keys(paths).length)
    throw new Error('No operations can be represented in this specification.');
  warnings.push(
    'Specifications describe example operations; original schemas, response contracts, and scripts cannot be inferred from saved requests.',
  );
  const info = { title: state.settings?.workspaceName || 'API Workbench', version: '1.0.0' };
  if (!swagger) return { openapi: '3.1.0', info, servers: [server(first.base)], paths };
  const match = first.base.match(/^(https?):\/\/(.+)$/);
  return {
    swagger: '2.0',
    info,
    schemes: [match?.[1] || 'https'],
    host: match?.[2] || '{{host}}',
    basePath: '/',
    paths,
  };
}
function wsdlExport(requests: ApiRequest[], warnings: string[]): string {
  const soap = requests.filter(
    (r) =>
      /Envelope/.test(r.body) ||
      r.headers.some((h) => h.key.toLowerCase() === 'soapaction') ||
      contentType(r).includes('soap'),
  );
  if (!soap.length)
    throw new Error(
      'WSDL export requires SOAP requests with an Envelope, SOAPAction header, or SOAP content type.',
    );
  if (soap.length !== requests.length)
    warnings.push('WSDL exports SOAP requests only. Other HTTP requests were omitted.');
  warnings.push(
    'Generated WSDL uses generic message schemas. Review the service contract against your original WSDL before publishing.',
  );
  const ops = soap.map((r, i) => ({ r, name: `Operation${i + 1}` }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:api-workbench" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" targetNamespace="urn:api-workbench" name="APIWorkbench">\n<types><xsd:schema targetNamespace="urn:api-workbench">${ops.map((o) => `<xsd:element name="${o.name}" type="xsd:anyType"/>`).join('')}</xsd:schema></types>\n${ops.map((o) => `<message name="${o.name}Input"><part name="parameters" element="tns:${o.name}"/></message>`).join('\n')}\n<portType name="APIWorkbenchPortType">${ops.map((o) => `<operation name="${o.name}"><documentation>${xml(o.r.name)}</documentation><input message="tns:${o.name}Input"/></operation>`).join('')}</portType>\n${ops.map((o) => `<binding name="Binding${o.name}" type="tns:APIWorkbenchPortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/><operation name="${o.name}"><soap:operation soapAction="${xml(o.r.headers.find((h) => h.key.toLowerCase() === 'soapaction')?.value.replace(/^"|"$/g, '') || o.name)}"/><input><soap:body use="literal"/></input></operation></binding>`).join('\n')}\n<service name="APIWorkbenchService">${ops.map((o) => `<port name="Port${o.name}" binding="tns:Binding${o.name}"><soap:address location="${xml(o.r.url)}"/></port>`).join('')}</service>\n</definitions>`;
}
const safeName = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\p{Cc}/gu, '-')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100) || 'Untitled';
export function exportCollection(
  source: WorkspaceState,
  format: string,
  archive = false,
): ExportResult {
  const option = exportFormats.find((f) => f.id === format);
  if (!option) throw new Error('Choose a supported export format.');
  const state = cleanExport(source),
    warnings: string[] = [];
  const native = ['workbench', 'bruno', 'opencollection'].includes(format);
  const requests = native
    ? state.requests
    : state.requests.filter((r) => !r.protocol || ['http', 'sse', 'ndjson'].includes(r.protocol));
  if (requests.length !== state.requests.length)
    warnings.push(
      'WebSocket and gRPC requests were omitted because this export format supports HTTP requests only. Use API Workbench, Bruno, or OpenCollection to include them.',
    );
  if (format !== 'workbench' && state.requests.some((r) => r.scripts?.pre || r.scripts?.post))
    warnings.push(
      'Request scripts use API Workbench’s aw API and are left out of this format. Export as API Workbench to keep them.',
    );
  if (format !== 'workbench' && state.requests.some((r) => r.tests))
    warnings.push(
      'API Workbench test assertions are not translated into other tools’ script languages.',
    );
  if (
    format !== 'workbench' &&
    requests.some((r) => r.protocol === 'sse' || r.protocol === 'ndjson')
  )
    warnings.push(
      'SSE and NDJSON are exported as HTTP requests; select the streaming protocol after importing into another tool.',
    );
  if (
    format !== 'workbench' &&
    requests.some((r) =>
      [
        'Saved credential',
        'API key',
        'Digest auth',
        'AWS Signature',
        'OAuth 1.0',
        'NTLM',
        'WSSE',
        'Akamai EdgeGrid',
        'Hawk',
        'JWT bearer',
        'OAuth 2.0 (request)',
        'Inherit from collection',
      ].includes(r.auth),
    )
  )
    warnings.push(
      'Credential links and authentication secrets are excluded. Configure authentication in the receiving app.',
    );
  if (
    ['curl', 'http', 'har'].includes(format) &&
    requests.some((r) => r.auth === 'Basic auth' || r.auth === 'Bearer token')
  )
    warnings.push(
      'Inline authentication templates are not included in text/HAR exports. Configure authentication or an Authorization header in the receiving tool.',
    );
  if (requests.some((r) => r.bodyType === 'binary' || r.bodyFields?.some((f) => f.kind === 'file')))
    warnings.push('Uploaded file bytes are not included. Reattach files in the receiving app.');
  if (
    !requests.length &&
    !['workbench', 'bruno', 'opencollection', 'insomnia', 'insomnia-v4'].includes(format)
  )
    throw new Error('No compatible requests available for this export format.');
  const title = state.settings?.workspaceName || 'API Workbench';
  const files: TransferFile[] = [];
  let result: unknown;
  if (format === 'workbench') result = state;
  else if (format === 'postman') {
    result = {
      info: {
        name: title,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: (archive ? [] : state.environments[0]?.variables || []).map((v) => ({
        key: v.key,
        value: v.value,
        disabled: !v.enabled,
      })),
      item: tree(
        requests,
        (r) => {
          const a = auth(r),
            type = a.type === 'none' ? 'noauth' : String(a.type);
          return {
            name: r.name,
            request: {
              method: r.method,
              url: {
                raw: r.url,
                query: r.params.map((p) => ({
                  key: p.key,
                  value: p.value,
                  disabled: !p.enabled,
                  description: p.description,
                })),
              },
              header: r.headers.map((h) => ({
                key: h.key,
                value: h.value,
                disabled: !h.enabled,
                description: h.description,
              })),
              body: postmanBody(r),
              auth: {
                type,
                ...(type === 'noauth'
                  ? {}
                  : {
                      [type]: Object.entries(a)
                        .filter(([k]) => k !== 'type')
                        .map(([key, value]) => ({ key, value, type: 'string' })),
                    }),
              },
            },
          };
        },
        (name, item) => ({ name, item }),
      ),
    };
    if (state.environments.length > 1 && !archive)
      warnings.push(
        'Postman collection variables use the first environment. Choose ZIP to include all Postman environments.',
      );
    if (archive)
      state.environments.forEach((e, i) =>
        files.push({
          name: `environments/${i + 1}-${safeName(e.name)}.postman_environment.json`,
          data: strToU8(
            JSON.stringify(
              {
                name: e.name,
                _postman_variable_scope: 'environment',
                values: e.variables.map((v) => ({
                  key: v.key,
                  value: v.value,
                  enabled: v.enabled,
                })),
              },
              null,
              2,
            ),
          ),
        }),
      );
  } else if (format === 'bruno') {
    files.push({
      name: 'bruno.json',
      data: strToU8(
        JSON.stringify(
          { version: '1', name: title, type: 'collection', ignore: ['node_modules', '.git'] },
          null,
          2,
        ),
      ),
    });
    requests.forEach((r, i) => {
      files.push({
        name: `${(r.folder || 'Requests').split('/').map(safeName).join('/')}/${i + 1}-${safeName(r.name)}.bru`,
        data: strToU8(exportBru(r, i)),
      });
      if (r.protocol === 'grpc' && r.grpc?.proto)
        files.push({ name: `protobuf/request-${i + 1}.proto`, data: strToU8(r.grpc.proto) });
    });
    state.environments.forEach((e, i) =>
      files.push({
        name: `environments/${state.environments.slice(0, i).some((previous) => safeName(previous.name).toLowerCase() === safeName(e.name).toLowerCase()) ? `${i + 1}-` : ''}${safeName(e.name)}.bru`,
        data: strToU8(exportBruEnvironment(e)),
      }),
    );
  } else if (format === 'opencollection') {
    result = {
      opencollection: '1.0.0',
      info: { name: title },
      bundled: true,
      config: {
        environments: state.environments.map((e) => ({
          name: e.name,
          variables: named(e.variables),
        })),
      },
      items: tree(
        requests,
        (r) => {
          const type =
            r.protocol === 'grpc' ? 'grpc' : r.protocol === 'websocket' ? 'websocket' : 'http';
          const details: Obj = {
            url: r.url,
            ...(auth(r).type === 'none' ? {} : { auth: auth(r) }),
          };
          if (type === 'http') {
            details.method = r.method;
            details.headers = named(r.headers);
            details.params = named(r.params).map((p) => ({ ...p, type: 'query' }));
            details.body = {
              type:
                r.bodyType === 'form-data'
                  ? 'multipart-form'
                  : r.bodyType === 'x-www-form-urlencoded'
                    ? 'form-urlencoded'
                    : contentType(r).includes('json')
                      ? 'json'
                      : contentType(r).includes('xml')
                        ? 'xml'
                        : 'text',
              data:
                r.bodyType === 'form-data' || r.bodyType === 'x-www-form-urlencoded'
                  ? named(r.bodyFields || []).map((f, i) => ({
                      ...f,
                      ...(r.bodyType === 'form-data'
                        ? {
                            type: r.bodyFields![i].kind || 'text',
                            value:
                              r.bodyFields![i].kind === 'file'
                                ? r.bodyFields![i].fileName || ''
                                : f.value,
                          }
                        : {}),
                    }))
                  : r.body,
            };
            if (r.bodyType === 'binary')
              details.body = {
                type: 'file',
                data: [
                  { filePath: r.binaryName || '', contentType: contentType(r), selected: true },
                ],
              };
          } else if (type === 'websocket') {
            details.headers = named(r.headers);
            details.message = { type: 'text', data: r.body };
          } else {
            details.method = r.grpc?.method || '';
            details.metadata = named(r.headers);
            details.message = r.body;
            if (r.grpc?.proto) {
              const protoFilePath = `protobuf/request-${requests.indexOf(r) + 1}.proto`;
              details.protoFilePath = protoFilePath;
              files.push({ name: protoFilePath, data: strToU8(r.grpc.proto) });
            }
          }
          return { info: { name: r.name, type }, [type]: details };
        },
        (name, items) => ({ info: { name, type: 'folder' }, items }),
      ),
    };
  } else if (format === 'insomnia')
    result = {
      type: 'collection.insomnia.rest/5.0',
      name: title,
      meta: { id: 'wrk_apiworkbench' },
      collection: tree(
        requests,
        (r) => ({
          name: r.name,
          url: r.url,
          method: r.method,
          headers: named(r.headers),
          parameters: named(r.params),
          body: insomniaBody(r),
          authentication: auth(r),
        }),
        (name, children) => ({ name, children }),
      ),
      environments: {
        name: state.environments[0]?.name || 'Base Environment',
        data: envData(state.environments[0]?.variables || []),
        subEnvironments: state.environments
          .slice(1)
          .map((e) => ({ name: e.name, data: envData(e.variables) })),
      },
    };
  else if (format === 'insomnia-v4') {
    const resources: Obj[] = [
      { _id: '__WORKSPACE_ID__', _type: 'workspace', name: title, scope: 'collection' },
    ];
    const folders = new Map<string, string>();
    const getFolder = (path: string): string => {
      if (!path) return '__WORKSPACE_ID__';
      if (folders.has(path)) return folders.get(path)!;
      const parts = path.split('/'),
        name = parts.pop()!,
        parentId = getFolder(parts.join('/')),
        id = `__folder_${folders.size + 1}__`;
      folders.set(path, id);
      resources.push({ _id: id, _type: 'request_group', parentId, name });
      return id;
    };
    requests.forEach((r, i) =>
      resources.push({
        _type: 'request',
        _id: `__request_${i + 1}__`,
        parentId: getFolder(r.folder),
        name: r.name,
        url: r.url,
        method: r.method,
        headers: named(r.headers),
        parameters: named(r.params),
        body: insomniaBody(r),
        authentication: auth(r),
      }),
    );
    state.environments.forEach((e, i) =>
      resources.push({
        _type: 'environment',
        _id: i === 0 ? '__BASE_ENVIRONMENT_ID__' : `__env_${i}__`,
        parentId: i === 0 ? '__WORKSPACE_ID__' : '__BASE_ENVIRONMENT_ID__',
        name: e.name,
        data: envData(e.variables),
      }),
    );
    result = { _type: 'export', __export_format: 4, __export_source: 'api-workbench', resources };
  } else if (format.startsWith('openapi') || format === 'swagger')
    result = spec(requests, state, format === 'swagger', warnings);
  else if (format === 'wsdl') result = wsdlExport(requests, warnings);
  else if (format === 'har')
    result = {
      log: {
        version: '1.2',
        creator: { name: 'API Workbench', version: '1.0.0' },
        entries: requests.map((r) => ({
          startedDateTime: new Date(0).toISOString(),
          time: 0,
          comment: r.name,
          request: {
            method: r.method,
            url: requestURL(r),
            httpVersion: 'HTTP/1.1',
            headers: named(r.headers.filter((h) => h.enabled)),
            queryString: [...new URLSearchParams(requestURL(r).split('?')[1] || '')].map(
              ([name, value]) => ({ name, value }),
            ),
            cookies: [],
            headersSize: -1,
            bodySize: strToU8(r.body).length,
            ...(r.bodyType === 'form-data' || r.bodyType === 'x-www-form-urlencoded'
              ? {
                  postData: {
                    mimeType:
                      r.bodyType === 'form-data'
                        ? 'multipart/form-data'
                        : 'application/x-www-form-urlencoded',
                    params: (r.bodyFields || [])
                      .filter((f) => f.enabled)
                      .map((f) => ({ name: f.key, value: f.value, fileName: f.fileName })),
                  },
                }
              : r.body
                ? { postData: { mimeType: contentType(r), text: r.body } }
                : {}),
          },
          response: {
            status: 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        })),
      },
    };
  else if (format === 'http')
    result = requests
      .map((r) => {
        const { body, headers } = textBody(r);
        return `### ${r.name.replace(/[\r\n]/g, ' ')}\n${r.method} ${requestURL(r)}\n${headers.map((h) => `${h.key}: ${h.value}`).join('\n')}\n\n${body}\n`;
      })
      .join('\n');
  else if (format === 'curl') {
    const quote = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'";
    result =
      requests
        .map((r) => {
          const headers = r.headers.filter(
            (h) =>
              h.enabled &&
              h.key.toLowerCase() !== 'content-length' &&
              !(r.bodyType === 'form-data' && h.key.toLowerCase() === 'content-type'),
          );
          const payload =
            r.bodyType === 'form-data'
              ? (r.bodyFields || [])
                  .filter((f) => f.enabled)
                  .map(
                    (f) =>
                      ` --form-string ${quote(`${f.key}=${f.kind === 'file' ? '' : f.value}`)}`,
                  )
                  .join('')
              : r.bodyType === 'x-www-form-urlencoded'
                ? (r.bodyFields || [])
                    .filter((f) => f.enabled)
                    .map((f) => ` --data-urlencode ${quote(`${f.key}=${f.value}`)}`)
                    .join('')
                : r.body
                  ? ` --data-raw ${quote(r.body)}`
                  : '';
          return `curl --request ${quote(r.method)} --url ${quote(requestURL(r))}${headers.map((h) => ` --header ${quote(`${h.key}: ${h.value}`)}`).join('')}${payload}`;
        })
        .join('\n\n') + '\n';
  }
  if (result !== undefined)
    files.unshift({
      name: `api-workbench.${option.extension}`,
      data: strToU8(
        typeof result === 'string'
          ? result
          : option.extension === 'yaml'
            ? stringify(result)
            : JSON.stringify(result, null, 2),
      ),
    });
  if (!files.length) throw new Error('Nothing to export.');
  if (archive || files.length > 1 || option.extension === 'zip')
    return {
      name: `api-workbench-${format}.zip`,
      type: 'application/zip',
      data: zipSync(Object.fromEntries(files.map((f) => [f.name, f.data])), { level: 6 }),
      warnings: [...new Set(warnings)],
    };
  return {
    name: files[0].name,
    type:
      option.extension === 'json' || option.extension === 'har'
        ? 'application/json'
        : option.extension === 'wsdl'
          ? 'application/xml'
          : 'text/plain',
    data: files[0].data,
    warnings: [...new Set(warnings)],
  };
}
