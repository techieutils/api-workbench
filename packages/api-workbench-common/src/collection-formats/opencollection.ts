import {
  applyAuth,
  array,
  body,
  mergeDefaults,
  object,
  request,
  rows,
  text,
  warnScripts,
} from './common';
import type { CollectionData, Obj } from './common';
export function openCollection(
  doc: Obj,
  warnings: string[],
  fileName = '',
  readFile?: (path: string) => string,
): CollectionData {
  const root = text(object(doc.info).name) || 'OpenCollection';
  const data: CollectionData = {
    requests: [],
    environments: array(object(doc.config).environments).map((e) => ({
      name: text(e.name),
      variables: rows(e.variables),
    })),
  };
  const walk = (items: unknown, folder: string, defaults: Obj, depth = 0): void => {
    if (depth > 25) throw new Error('OpenCollection folders exceed the supported depth.');
    for (const item of array(items)) {
      if (item.file)
        throw new Error(
          `OpenCollection references “${text(item.file)}”. Import the collection folder or a bundled export.`,
        );
      const info = object(item.info);
      const inherited = mergeDefaults(defaults, object(item.request));
      if (item.items) {
        walk(item.items, `${folder}/${text(info.name) || 'Folder'}`, inherited, depth + 1);
        continue;
      }
      const type =
        text(info.type) ||
        (item.http
          ? 'http'
          : item.graphql
            ? 'graphql'
            : item.grpc
              ? 'grpc'
              : item.websocket
                ? 'websocket'
                : '');
      if (!['http', 'graphql', 'grpc', 'websocket'].includes(type)) {
        warnings.push(
          `Skipped OpenCollection item ${text(info.name) || fileName}: unsupported ${type || 'item'} type.`,
        );
        continue;
      }
      const source = object(item[type]);
      const r = request(
        {
          ...source,
          method: type === 'graphql' || type === 'grpc' ? 'POST' : source.method || 'GET',
        },
        text(info.name) || fileName || 'Imported request',
        folder,
      );
      r.headers = [
        ...rows(defaults.headers || defaults.metadata),
        ...rows(source.headers || source.metadata),
      ];
      r.params = rows(array(source.params).filter((p) => !p.type || p.type === 'query'));
      for (const p of array(source.params).filter((p) => p.type === 'path'))
        r.url = r.url!.replace(`{${text(p.name)}}`, text(p.value) || `{{${text(p.name)}}}`);
      const rawBody = Array.isArray(source.body) ? source.body[0] : source.body;
      if (type === 'graphql')
        body(
          r,
          {
            ...object(rawBody),
            type: 'graphql',
            data: object(rawBody).query ?? object(rawBody).data,
          },
          'open',
        );
      else if (type === 'websocket') {
        r.protocol = 'websocket';
        r.body = text(
          object(Array.isArray(source.message) ? object(source.message[0]).message : source.message)
            .data,
        );
      } else if (type === 'grpc') {
        r.protocol = 'grpc';
        r.body =
          typeof source.message === 'string'
            ? source.message
            : text(object(array(source.message)[0]).message ?? object(source.message).data);
        r.grpc = {
          proto: source.protoFilePath && readFile ? readFile(text(source.protoFilePath)) : '',
          method: text(source.method),
          tls: text(source.url).startsWith('https'),
        };
        if (!r.grpc.proto)
          warnings.push(`${r.name}: load the proto definition before sending gRPC requests.`);
      } else body(r, rawBody, 'open');
      const auth = object(source.auth);
      applyAuth(r, !auth.type || auth.type === 'inherit' ? defaults.auth : auth, warnings);
      warnScripts(object(item.runtime), warnings);
      if (object(item.runtime).assertions)
        warnings.push(`${r.name}: source assertions need to be recreated in API Workbench.`);
      data.requests.push(r);
    }
  };
  walk(
    doc.items || [doc],
    doc.items ? root : fileName.split('/').slice(0, -1).join('/') || 'OpenCollection',
    object(doc.request),
  );
  return data;
}
