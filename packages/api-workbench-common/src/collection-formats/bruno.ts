import parseBru from '@usebruno/lang/v2/src/bruToJson';
import parseEnvironment from '@usebruno/lang/v2/src/envToJson';
import parseDefaults from '@usebruno/lang/v2/src/collectionBruToJson';
import serializeBru from '@usebruno/lang/v2/src/jsonToBru';
import serializeEnvironment from '@usebruno/lang/v2/src/jsonToEnv';
import { applyAuth, array, body, object, request, rows, text, warnScripts } from './common';
import type { CollectionData, Obj } from './common';
import type { ApiRequest, Environment } from '../types';
export { parseDefaults };
export function brunoRequest(
  doc: Obj,
  name: string,
  folder: string,
  warnings: string[],
  defaults: Obj = {},
): Partial<ApiRequest> {
  const native = Boolean(doc.http || doc.grpc || doc.ws);
  const source = native ? object(doc.http || doc.grpc || doc.ws) : object(doc.request);
  const r = request(
    { ...source, method: doc.grpc ? 'POST' : source.method || 'GET' },
    text(object(doc.meta).name || doc.name) || name,
    folder,
  );
  r.headers = [
    ...rows(defaults.headers),
    ...rows(native ? doc.headers || doc.metadata : source.headers),
  ];
  const params = array(native ? doc.params : source.params);
  r.params = rows(params.filter((p) => !p.type || p.type === 'query'));
  for (const p of params.filter((p) => p.type === 'path'))
    r.url = r.url!.replace(`:${text(p.name)}`, text(p.value) || `{{${text(p.name)}}}`);
  const b = object(native ? doc.body : source.body);
  const mode = text(native ? source.body : b.mode);
  body(r, { ...b, mode }, 'bruno');
  if (mode === 'text') r.body = text(b.text);
  if (mode === 'graphql')
    body(
      r,
      {
        mode,
        graphql: {
          query: object(b.graphql).query ?? b.graphql,
          variables: object(b.graphql).variables || b.graphqlVariables,
        },
      },
      'bruno',
    );
  const auth = object(native ? doc.auth : source.auth);
  const authType = text(native ? source.auth : auth.mode);
  applyAuth(
    r,
    !authType || authType === 'inherit' ? defaults.auth : { ...auth, type: authType },
    warnings,
  );
  if (doc.ws || doc.type === 'ws-request' || mode === 'ws') {
    r.protocol = 'websocket';
    r.body = text(array(b.ws)[0]?.content ?? b.text);
  }
  if (doc.grpc || doc.type === 'grpc-request') {
    r.protocol = 'grpc';
    r.body = text(array(b.grpc)[0]?.content);
    r.grpc = { proto: '', method: text(source.method), tls: text(source.url).startsWith('https') };
  }
  warnScripts(native ? doc : source, warnings);
  return r;
}
export function brunoText(
  source: string,
  name: string,
  warnings: string[],
  defaults: Obj = {},
  readFile?: (path: string) => string,
): CollectionData {
  if (/(^|\/)environments\//.test(name) || /^\s*(?:vars\s*\{|vars:secret\s*\[)/.test(source)) {
    const e = parseEnvironment(source);
    if (e.extends || e.externalSecrets)
      warnings.push(
        `${name}: environment inheritance and external secrets need configuration in API Workbench.`,
      );
    return {
      requests: [],
      environments: [
        {
          name: name
            .split('/')
            .pop()!
            .replace(/\.bru$/i, ''),
          variables: rows(e.variables),
        },
      ],
    };
  }
  const parsed = parseBru(source);
  const r = brunoRequest(
    parsed,
    name,
    name.split('/').slice(0, -1).join('/') || 'Bruno',
    warnings,
    defaults,
  );
  if (r.grpc && object(parsed.grpc).protoPath && readFile)
    r.grpc.proto = readFile(text(object(parsed.grpc).protoPath));
  if (r.grpc && !r.grpc.proto)
    warnings.push(`${r.name}: load its proto definition before sending gRPC requests.`);
  return { requests: [r] };
}
export function brunoJSON(doc: Obj, warnings: string[]): CollectionData {
  const result: CollectionData = {
    requests: [],
    environments: array(doc.environments).map((e) => ({
      name: text(e.name),
      variables: rows(e.variables),
    })),
  };
  const walk = (items: unknown, folder: string, depth = 0): void => {
    if (depth > 25) throw new Error('Bruno folders exceed the supported depth.');
    for (const item of array(items)) {
      if (item.items) walk(item.items, `${folder}/${text(item.name)}`, depth + 1);
      else if (item.request) {
        const r = brunoRequest(
          item,
          text(item.name),
          folder,
          warnings,
          object(object(doc.root).request || doc.root),
        );
        result.requests.push(r);
        if (r.grpc)
          warnings.push(`${r.name}: load its proto definition before sending gRPC requests.`);
      }
    }
  };
  walk(doc.items, text(doc.name) || 'Bruno');
  return result;
}
const namedRows = (r: ApiRequest['headers']): Obj[] =>
  r.map((v) => ({ name: v.key, value: v.value, enabled: v.enabled, description: v.description }));
export function exportBru(r: ApiRequest, index: number): string {
  const mode =
    r.bodyType === 'binary'
      ? 'file'
      : r.bodyType === 'form-data'
        ? 'multipart-form'
        : r.bodyType === 'x-www-form-urlencoded'
          ? 'form-urlencoded'
          : r.rawContentType?.includes('json')
            ? 'json'
            : r.rawContentType?.includes('xml')
              ? 'xml'
              : r.body
                ? 'text'
                : 'none';
  const authMode =
    r.auth === 'Basic auth' ? 'basic' : r.auth === 'Bearer token' ? 'bearer' : 'none';
  const auth = { basic: { username: r.username, password: '' }, bearer: { token: '' } };
  const bodyValue: Obj = { [mode]: r.body };
  if (r.bodyType === 'form-data')
    bodyValue.multipartForm = namedRows(r.bodyFields || []).map((f, i) => ({
      ...f,
      type: r.bodyFields![i].kind || 'text',
      value: r.bodyFields![i].kind === 'file' ? [r.bodyFields![i].fileName || ''] : f.value,
    }));
  if (r.bodyType === 'binary') bodyValue.file = [{ filePath: r.binaryName || '', selected: true }];
  if (r.bodyType === 'x-www-form-urlencoded')
    bodyValue.formUrlEncoded = namedRows(r.bodyFields || []);
  if (r.protocol === 'grpc') bodyValue.grpc = [{ name: 'Message', content: r.body }];
  if (r.protocol === 'websocket')
    bodyValue.ws = [{ name: 'Message', type: 'text', content: r.body, selected: true }];
  return serializeBru({
    meta: {
      name: r.name.replace(/[\r\n]/g, ' '),
      type: r.protocol === 'grpc' ? 'grpc' : r.protocol === 'websocket' ? 'ws' : 'http',
      seq: index + 1,
    },
    ...(r.protocol === 'grpc'
      ? {
          grpc: {
            url: r.url,
            method: r.grpc?.method,
            protoPath: r.grpc?.proto
              ? '../'.repeat((r.folder || 'Requests').split('/').length) +
                `protobuf/request-${index + 1}.proto`
              : undefined,
            body: 'grpc',
            auth: authMode,
          },
        }
      : r.protocol === 'websocket'
        ? { ws: { url: r.url, body: 'ws', auth: authMode } }
        : { http: { method: r.method.toLowerCase(), url: r.url, body: mode, auth: authMode } }),
    params: namedRows(r.params).map((p) => ({ ...p, type: 'query' })),
    headers: namedRows(r.headers),
    auth,
    body: bodyValue,
  });
}
export function exportBruEnvironment(e: Environment): string {
  return serializeEnvironment({ variables: namedRows(e.variables) });
}
