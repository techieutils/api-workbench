import {
  applyAuth,
  array,
  body,
  object,
  request,
  rows,
  text,
  variables,
  warnScripts,
} from './common';
import type { CollectionData, Obj } from './common';
export function insomnia(doc: Obj, warnings: string[]): CollectionData {
  doc = JSON.parse(
    JSON.stringify(doc).replace(
      /\{\{\s*_\.([^{}]+)\s*\}\}/g,
      (_, name: string) => '{{' + name.trim() + '}}',
    ),
  ) as Obj;
  const data: CollectionData = { requests: [], environments: [] };
  const root = text(doc.name) || 'Insomnia';
  const add = (source: Obj, folder: string): void => {
    warnScripts(source, warnings);
    const r = request(source, text(source.name) || 'Imported request', folder);
    r.headers = rows(source.headers);
    r.params = rows(source.parameters);
    body(r, source.body, 'insomnia');
    applyAuth(r, source.authentication, warnings);
    if (text(source._type).includes('websocket') || text(source.url).startsWith('ws'))
      r.protocol = 'websocket';
    data.requests.push(r);
  };
  if (Array.isArray(doc.resources)) {
    const resources = array(doc.resources),
      byId = new Map(resources.map((r) => [text(r._id), r]));
    const folder = (id: string, seen = new Set<string>()): string => {
      if (!id || !byId.has(id)) return '';
      if (seen.has(id) || seen.size > 25)
        throw new Error('Circular or deeply nested Insomnia folders.');
      seen.add(id);
      const node = byId.get(id)!;
      return [folder(text(node.parentId), seen), text(node.name)].filter(Boolean).join('/');
    };
    const inheritedAuth = (id: string, seen = new Set<string>()): unknown => {
      const node = byId.get(id);
      if (!node) return undefined;
      if (seen.has(id) || seen.size > 25)
        throw new Error('Circular or deeply nested Insomnia folders.');
      seen.add(id);
      return node.authentication ?? inheritedAuth(text(node.parentId), seen);
    };
    for (const resource of resources) {
      if (resource._type === 'environment')
        data.environments!.push({ name: text(resource.name), variables: variables(resource.data) });
      else if (resource._type === 'request' || resource._type === 'websocket_request')
        add(
          {
            ...resource,
            authentication: resource.authentication ?? inheritedAuth(text(resource.parentId)),
          },
          folder(text(resource.parentId)) || root,
        );
      else if (resource._type === 'grpc_request')
        warnings.push('Insomnia gRPC resources need a proto definition and were skipped.');
    }
  } else {
    const env = object(doc.environments);
    if (env.data)
      data.environments!.push({
        name: text(env.name) || 'Base environment',
        variables: variables(env.data),
      });
    for (const e of array(env.subEnvironments))
      data.environments!.push({ name: text(e.name), variables: variables(e.data) });
    if (text(doc.type).startsWith('environment.')) {
      data.environments!.push({ name: root, variables: variables(doc.data) });
      return data;
    }
    const walk = (items: unknown, path: string, auth: unknown, depth = 0): void => {
      if (depth > 25) throw new Error('Insomnia folders exceed the supported depth.');
      for (const item of array(items)) {
        if (item.children)
          walk(item.children, `${path}/${text(item.name)}`, item.authentication ?? auth, depth + 1);
        else add({ ...item, authentication: item.authentication ?? auth }, path);
      }
    };
    walk(doc.collection, root, doc.authentication);
  }
  return data;
}
