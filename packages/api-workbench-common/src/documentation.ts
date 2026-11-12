import { redactProxySettings } from './proxy';
import { stringify } from 'yaml';
import type { ApiRequest, KeyValue } from './types';
type ObjectValue = Record<string, unknown>;
const sensitive = /authorization|cookie|token|secret|password|api[-_]?key|credential/i;
function redact(value: unknown, key = ''): unknown {
  if (sensitive.test(key)) return '<REDACTED>';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  return value;
}
function rows(values: KeyValue[]): KeyValue[] {
  return values.map((row) => ({
    ...row,
    value: sensitive.test(row.key) ? '<REDACTED>' : row.value,
  }));
}
export function collectionRequests(requests: ApiRequest[]): ApiRequest[] {
  return requests.map((request) => {
    const copy = structuredClone(request);
    copy.httpSettings = redactProxySettings(copy.httpSettings);
    copy.token = '';
    copy.password = '';
    copy.credentialId = undefined;
    copy.response = null;
    copy.headers = rows(copy.headers);
    copy.params = rows(copy.params);
    copy.bodyFields = copy.bodyFields ? rows(copy.bodyFields) : undefined;
    const hash = copy.url.indexOf('#');
    const source = hash < 0 ? copy.url : copy.url.slice(0, hash);
    const query = source.indexOf('?');
    if (query >= 0) {
      const params = new URLSearchParams(source.slice(query + 1));
      for (const key of [...params.keys()]) if (sensitive.test(key)) params.set(key, '<REDACTED>');
      copy.url =
        source.slice(0, query) +
        '?' +
        params.toString().replace(/%7B%7B.*?%7D%7D/gi, (value) => decodeURIComponent(value));
    }
    copy.url = copy.url.replace(/((?:https?|wss?):\/\/)[^/@\s]+:[^/@\s]+@/g, '$1');
    try {
      copy.body = JSON.stringify(redact(JSON.parse(copy.body)), null, 2);
    } catch {
      /* Non-JSON examples retain their source text. */
    }
    return copy;
  });
}
function endpoint(request: ApiRequest): { server: string; path: string; query: KeyValue[] } {
  const source = request.url.split('#')[0];
  const index = source.indexOf('?');
  const base = index < 0 ? source : source.slice(0, index);
  const match = base.match(/^(https?:\/\/[^/]+|\{\{[^}]+\}\})(.*)$/);
  const server = match?.[1] || 'https://example.com';
  const path =
    (match?.[2] || (base.startsWith('/') ? base : '/')).replace(/\{\{([^}]+)\}\}/g, '{$1}') || '/';
  const managed = new Set(request.params.map((row) => row.key));
  const query = Array.from(
    new URLSearchParams(index < 0 ? '' : source.slice(index + 1)),
    ([key, value]) => ({ key, value, enabled: true }),
  ).filter((row) => !managed.has(row.key));
  return {
    server,
    path,
    query: [...query, ...request.params.filter((row) => row.enabled && row.key)],
  };
}
function serverObject(source: string): ObjectValue {
  const variables: Record<string, { default: string }> = Object.create(null);
  const url = source.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    variables[key] = { default: source === '{{' + key + '}}' ? 'https://example.com' : 'example' };
    return '{' + key + '}';
  });
  return { url, ...(Object.keys(variables).length ? { variables } : {}) };
}
/**
 * An OpenAPI document for a collection's requests. Each operation is tagged with the collection's
 * name, then with the request's own tags (`tagsOf`, such as its tags with its folders'), which
 * Swagger UI and other tools group operations by.
 */
export function buildDocument(
  name: string,
  source: ApiRequest[],
  options: { tagsOf?: (request: ApiRequest) => string[] } = {},
): ObjectValue {
  const requests = collectionRequests(source).filter(
    (request) => !request.protocol || ['http', 'sse', 'ndjson'].includes(request.protocol),
  );
  const paths: Record<string, Record<string, unknown>> = Object.create(null);
  const schemes: ObjectValue = Object.create(null);
  const servers = new Set<string>();
  for (const request of requests) {
    const location = endpoint(request);
    servers.add(location.server);
    const parameters: ObjectValue[] = [];
    const add = (row: KeyValue, where: string) => {
      const found = parameters.find(
        (parameter) => parameter.name === row.key && parameter.in === where,
      );
      if (found) {
        found.example = [
          ...(Array.isArray(found.example) ? found.example : [found.example]),
          row.value,
        ];
        found.schema = { type: 'array', items: { type: 'string' } };
      } else
        parameters.push({
          name: row.key,
          in: where,
          required: where === 'path',
          description: row.description || '',
          schema: { type: 'string' },
          ...(where === 'path' ? {} : { example: row.value }),
        });
    };
    for (const match of location.path.matchAll(/\{([^{}]+)\}/g))
      add({ key: match[1], value: '', enabled: true }, 'path');
    location.query.forEach((row) => add(row, 'query'));
    request.headers
      .filter(
        (row) =>
          row.enabled &&
          row.key &&
          !['accept', 'content-type', 'authorization'].includes(row.key.toLowerCase()),
      )
      .forEach((row) => add(row, 'header'));
    const operation: ObjectValue = {
      summary: request.name,
      operationId: 'request_' + request.id.replace(/[^a-zA-Z0-9_]/g, '_'),
      tags: [
        name,
        ...(options.tagsOf?.(request) ?? []).filter(
          (tag) => tag.toLowerCase() !== name.toLowerCase(),
        ),
      ],
      parameters,
      responses: { default: { description: 'Response is defined by the API server.' } },
      servers: [serverObject(location.server)],
    };
    if (request.auth !== 'None' && request.auth !== 'Inherit from collection') {
      const id = 'auth_' + request.id.replace(/[^a-zA-Z0-9_]/g, '_');
      schemes[id] =
        request.auth === 'Basic auth'
          ? { type: 'http', scheme: 'basic' }
          : request.auth === 'Digest auth'
            ? { type: 'http', scheme: 'digest' }
            : request.auth === 'API key'
              ? {
                  type: 'apiKey',
                  in: request.authOptions?.apiKeyIn === 'query' ? 'query' : 'header',
                  name: request.username || 'X-API-Key',
                }
              : request.auth === 'JWT bearer'
                ? { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
                : [
                      'AWS Signature',
                      'OAuth 1.0',
                      'NTLM',
                      'WSSE',
                      'Akamai EdgeGrid',
                      'Hawk',
                    ].includes(request.auth)
                  ? {
                      type: 'apiKey',
                      in: 'header',
                      name: 'Authorization',
                      description: request.auth,
                    }
                  : { type: 'http', scheme: 'bearer', description: request.auth };
      operation.security = [{ [id]: [] }];
    }
    const mode = request.bodyType || 'raw';
    if (!['GET', 'HEAD'].includes(request.method) && mode !== 'none') {
      let mime =
        request.headers.find((row) => row.enabled && row.key.toLowerCase() === 'content-type')
          ?.value ||
        request.rawContentType ||
        'application/json';
      let media: ObjectValue = { schema: { type: 'string' }, example: request.body };
      if (mode === 'form-data' || mode === 'x-www-form-urlencoded') {
        mime = mode === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
        media = {
          schema: {
            type: 'object',
            properties: Object.fromEntries(
              (request.bodyFields || [])
                .filter((row) => row.enabled && row.key)
                .map((row) => [
                  row.key,
                  row.kind === 'file'
                    ? { type: 'string', format: 'binary' }
                    : { type: 'string', example: row.value },
                ]),
            ),
          },
        };
      } else if (mode === 'binary') {
        mime = 'application/octet-stream';
        media = { schema: { type: 'string', format: 'binary' } };
      } else {
        try {
          const example = JSON.parse(request.body);
          media = { example };
        } catch {
          /* Text examples use a string schema. */
        }
      }
      operation.requestBody = { content: { [mime]: media } };
    }
    const item = (paths[location.path] ||= Object.create(null));
    const method = request.method.toLowerCase();
    // OpenAPI allows one operation per path/method. Preserve alternate saved examples as metadata.
    if (item[method]) {
      const existing = item[method] as ObjectValue;
      existing['x-workbench-variants'] = [
        ...((existing['x-workbench-variants'] as ObjectValue[]) || []),
        operation,
      ];
    } else item[method] = operation;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: name,
      version: '1.0.0',
      description: 'Generated from saved API Workbench requests.',
    },
    servers: [...servers].map(serverObject),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
  };
}
export function swaggerDocument(document: ObjectValue): ObjectValue {
  const paths = structuredClone(document.paths) as Record<string, Record<string, ObjectValue>>;
  for (const item of Object.values(paths))
    for (const operation of Object.values(item)) {
      delete operation.servers;
      operation.parameters = (operation.parameters as ObjectValue[]).map((parameter) => {
        const { schema, example, ...rest } = parameter;
        return {
          ...rest,
          ...(schema as ObjectValue),
          ...(example !== undefined ? { 'x-example': example } : {}),
        };
      });
      if (operation.requestBody) {
        const content = (operation.requestBody as { content: Record<string, ObjectValue> }).content;
        operation.consumes = Object.keys(content);
        const media = Object.values(content)[0];
        const parameters = operation.parameters as ObjectValue[];
        if ('multipart/form-data' in content || 'application/x-www-form-urlencoded' in content) {
          const schema = media.schema as { properties?: Record<string, ObjectValue> };
          Object.entries(schema.properties || {}).forEach(([name, property]) =>
            parameters.push({
              name,
              in: 'formData',
              type: property.format === 'binary' ? 'file' : 'string',
              ...(property.example !== undefined ? { 'x-example': property.example } : {}),
            }),
          );
        } else
          parameters.push({
            name: 'body',
            in: 'body',
            schema: media.schema || {},
            ...(media.example !== undefined ? { 'x-example': media.example } : {}),
          });
        delete operation.requestBody;
      }
    }
  const server = (document.servers as { url: string }[])[0]?.url;
  let address: ObjectValue;
  try {
    const url = new URL(server);
    address = { host: url.host, basePath: url.pathname, schemes: [url.protocol.slice(0, -1)] };
  } catch {
    address = { 'x-workbench-server': server };
  }
  const securityDefinitions = Object.fromEntries(
    Object.entries(
      (document.components as { securitySchemes?: Record<string, ObjectValue> })?.securitySchemes ||
        {},
    ).map(([id, scheme]) => [
      id,
      scheme.type === 'apiKey'
        ? scheme
        : scheme.scheme === 'basic'
          ? { type: 'basic' }
          : { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Bearer token' },
    ]),
  );
  return {
    swagger: '2.0',
    info: document.info,
    ...address,
    paths,
    ...(Object.keys(securityDefinitions).length ? { securityDefinitions } : {}),
  };
}
export function serialize(value: unknown, yaml = false): string {
  return yaml ? stringify(value, { lineWidth: 0 }) : JSON.stringify(value, null, 2);
}
