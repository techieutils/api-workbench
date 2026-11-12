import { applyAuth, array, body, object, request, rows, text, warnScripts } from './common';
import type { CollectionData, Obj } from './common';
export function postman(document: Obj, warnings: string[]): CollectionData {
  const data: CollectionData = { requests: [], environments: [] };
  if (
    document._postman_variable_scope === 'environment' ||
    (Array.isArray(document.values) && !document.item)
  ) {
    data.environments!.push({
      name: text(document.name) || 'Postman environment',
      variables: rows(document.values),
    });
    return data;
  }
  const root = text(object(document.info).name) || 'Postman';
  if (Array.isArray(document.variable) && document.variable.length)
    data.environments!.push({ name: `${root} variables`, variables: rows(document.variable) });
  const walk = (items: unknown, folder: string, auth: unknown, depth = 0): void => {
    if (depth > 25) throw new Error('Collection folders exceed the supported depth.');
    if (!Array.isArray(items)) throw new Error('Invalid Postman items.');
    for (const item of array(items)) {
      const inherited = item.auth ?? auth;
      warnScripts(item, warnings);
      if (item.item) {
        walk(item.item, `${folder}/${text(item.name)}`, inherited, depth + 1);
        continue;
      }
      if (!item.request) continue;
      const source =
        typeof item.request === 'string' ? { url: item.request } : object(item.request);
      const u = object(source.url);
      let url = typeof source.url === 'string' ? source.url : text(u.raw);
      if (!url && u.host)
        url = `${text(u.protocol) || 'https'}://${Array.isArray(u.host) ? u.host.join('.') : text(u.host)}${u.port ? ':' + text(u.port) : ''}/${Array.isArray(u.path) ? u.path.join('/') : text(u.path)}`;
      // Path variables (/users/:id) become {{id}}; a port (host:8080) is not one, so the name
      // must follow a slash and start with a letter.
      url = url.replace(/(?<=\/):([A-Za-z_]\w*)(?=\/|\?|#|$)/g, '{{$1}}');
      const r = request({ ...source, url }, text(item.name) || 'Imported request', folder);
      r.headers = rows(source.header);
      r.params = rows(u.query);
      body(r, source.body, 'postman');
      applyAuth(r, source.auth ?? inherited, warnings);
      if (Array.isArray(u.variable) && u.variable.length)
        warnings.push(
          `${r.name}: URL variables were imported as placeholders; define their values in an environment.`,
        );
      data.requests.push(r);
    }
  };
  walk(document.item, root, document.auth);
  warnScripts(document, warnings);
  return data;
}
