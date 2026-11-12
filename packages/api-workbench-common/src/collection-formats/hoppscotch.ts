import { applyAuth, array, body, object, request, text, warnScripts } from './common';
import type { CollectionData, Obj } from './common';
import type { KeyValue } from '../types';

/** A Hoppscotch collection export: one collection, or an array of them, with nested folders. */
export const isHoppscotchCollection = (doc: Obj): boolean =>
  Array.isArray(doc.folders) && Array.isArray(doc.requests) && typeof doc.name === 'string';
/** A Hoppscotch environment export: `key` variables with `secret` flags or initial values. */
export const isHoppscotchEnvironment = (doc: Obj): boolean =>
  Array.isArray(doc.variables) &&
  doc.variables.length > 0 &&
  array(doc.variables).every((v) => 'key' in v && ('secret' in v || 'initialValue' in v));

const hoppRows = (v: unknown): KeyValue[] =>
  array(v)
    .filter((r) => text(r.key))
    .map((r) => ({
      key: text(r.key),
      value: text(r.value),
      enabled: r.active !== false,
      description: text(r.description),
    }));

// Hoppscotch stores urlencoded bodies as "key: value" lines; a leading "#" disables a line.
const encodedRows = (source: string): Obj[] =>
  source
    .split('\n')
    .map((line) => /^\s*(#?)\s*([^:]+?)\s*:\s?(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, disabled, key, value]) => ({ key, value, disabled: disabled === '#' }));

function hoppBody(raw: unknown): Obj {
  const b = object(raw);
  const type = text(b.contentType);
  if (!type) return {};
  if (type === 'multipart/form-data')
    return {
      mode: 'formdata',
      formdata: array(b.body).map((field) => ({
        key: field.key,
        value: field.isFile ? '' : field.value,
        type: field.isFile ? 'file' : 'text',
        disabled: field.active === false,
      })),
    };
  if (type === 'application/x-www-form-urlencoded')
    return { mode: 'urlencoded', urlencoded: encodedRows(text(b.body)) };
  if (type === 'application/octet-stream') return { mode: 'binary' };
  return { mode: type, raw: typeof b.body === 'string' ? b.body : '' };
}

function hoppAuth(raw: unknown): Obj | undefined {
  const a = object(raw);
  const type = text(a.authType);
  if (!type || type === 'inherit') return undefined;
  if (a.authActive === false || type === 'none') return { type: 'none' };
  if (type === 'api-key')
    return { ...a, type: 'apikey', in: /query/i.test(text(a.addTo)) ? 'query' : 'header' };
  if (type === 'aws-signature')
    return { ...a, type: 'awsv4', service: a.serviceName, sessionToken: a.serviceToken };
  if (type === 'oauth-2') {
    const g = { ...a, ...object(a.grantTypeInfo) };
    const grant = text(g.grantType);
    return {
      type: 'oauth2',
      grant_type:
        grant === 'CLIENT_CREDENTIALS'
          ? 'client_credentials'
          : grant === 'PASSWORD'
            ? 'password'
            : grant === 'IMPLICIT'
              ? 'implicit'
              : 'authorization_code',
      authUrl: g.authEndpoint ?? g.authURL,
      accessTokenUrl: g.tokenEndpoint ?? g.accessTokenURL,
      clientId: g.clientID,
      clientSecret: g.clientSecret,
      client_authentication: g.clientAuthentication === 'IN_BODY' ? 'body' : '',
      scope: g.scopes ?? g.scope,
      accessToken: g.token,
      username: g.username,
      password: g.password,
    };
  }
  return { ...a, type };
}

export function hoppscotch(raw: unknown, warnings: string[]): CollectionData {
  // Hoppscotch writes variables as <<name>>; API Workbench uses {{name}}.
  const docs = (
    JSON.parse(
      JSON.stringify(raw).replace(/<<\s*([\w.-]+)\s*>>/g, (_, name: string) => `{{${name}}}`),
    ) as unknown[]
  ).map(object);
  const data: CollectionData = { requests: [], environments: [] };
  for (const doc of docs.filter(isHoppscotchEnvironment)) {
    const variables = array(doc.variables).map((v) => ({
      key: text(v.key),
      value: v.secret ? '' : text(v.initialValue ?? v.value ?? v.currentValue),
      enabled: true,
    }));
    if (array(doc.variables).some((v) => v.secret))
      warnings.push(
        `${text(doc.name) || 'Hoppscotch environment'}: secret values are not exported by Hoppscotch; enter them again or use the credential vault.`,
      );
    data.environments!.push({ name: text(doc.name) || 'Hoppscotch globals', variables });
  }
  const walk = (
    collection: Obj,
    path: string,
    auth: Obj | undefined,
    headers: KeyValue[],
    depth = 0,
  ): void => {
    if (depth > 25) throw new Error('Hoppscotch folders exceed the supported depth.');
    const folder = [path, text(collection.name) || 'Hoppscotch'].filter(Boolean).join('/');
    const inheritedAuth = hoppAuth(collection.auth) ?? auth;
    const own = hoppRows(collection.headers);
    const names = new Set(own.map((h) => h.key.toLowerCase()));
    const inheritedHeaders = [...headers.filter((h) => !names.has(h.key.toLowerCase())), ...own];
    if (depth === 0 && hoppRows(collection.variables).length)
      data.environments!.push({
        name: `${folder} variables`,
        variables: hoppRows(collection.variables),
      });
    for (const source of array(collection.requests)) {
      const name = text(source.name) || 'Imported request';
      warnScripts(
        { preRequestScript: source.preRequestScript, tests: source.testScript },
        warnings,
      );
      const graphql = typeof source.query === 'string' && !source.endpoint;
      const r = request(
        { url: source.endpoint ?? source.url, method: graphql ? 'POST' : source.method },
        name,
        folder,
      );
      const ownHeaders = hoppRows(source.headers);
      const overridden = new Set(ownHeaders.map((h) => h.key.toLowerCase()));
      r.headers = [
        ...inheritedHeaders.filter((h) => !overridden.has(h.key.toLowerCase())),
        ...ownHeaders,
      ];
      r.params = hoppRows(source.params);
      body(
        r,
        graphql
          ? { mode: 'graphql', graphql: { query: source.query, variables: source.variables } }
          : hoppBody(source.body),
        'postman',
      );
      applyAuth(r, hoppAuth(source.auth) ?? inheritedAuth, warnings);
      if (hoppRows(source.requestVariables).length)
        warnings.push(
          `${name}: request variables were not imported; define them in an environment.`,
        );
      data.requests.push(r);
    }
    for (const child of array(collection.folders))
      walk(child, folder, inheritedAuth, inheritedHeaders, depth + 1);
  };
  for (const doc of docs.filter(isHoppscotchCollection)) walk(doc, '', undefined, []);
  return data;
}
