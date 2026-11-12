import { redactProxySettings } from '../proxy';
import type { ApiRequest, Environment, KeyValue, WorkspaceState } from '../types';
export type Obj = Record<string, unknown>;
export interface CollectionData {
  requests: Partial<ApiRequest>[];
  environments?: Environment[];
  settings?: Partial<WorkspaceState['settings']>;
  collectionHttpSettings?: WorkspaceState['collectionHttpSettings'];
  /** Collection and folder scripts, from API Workbench's own format only. */
  collectionScripts?: WorkspaceState['collectionScripts'];
  workspaceScripts?: WorkspaceState['workspaceScripts'];
  scriptLibrary?: WorkspaceState['scriptLibrary'];
  scriptSnippets?: WorkspaceState['scriptSnippets'];
  collectionTags?: WorkspaceState['collectionTags'];
}
export interface ImportResult {
  data: CollectionData;
  format: string;
  warnings: string[];
  files: number;
}
export interface TransferFile {
  name: string;
  data: Uint8Array;
}
export const object = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
export const array = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(object) : []);
export const text = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
export const rows = (v: unknown): KeyValue[] =>
  array(v).map((r) => ({
    key: text(r.key ?? r.name),
    value: text(r.value),
    enabled: r.enabled !== false && r.disabled !== true,
    description: text(r.description),
  }));
export const variables = (v: unknown): KeyValue[] =>
  Object.entries(object(v)).map(([key, value]) => ({ key, value: text(value), enabled: true }));
export const methods = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
];
export function request(source: Obj, name: string, folder: string): Partial<ApiRequest> {
  const url = text(source.url).replace(
    /\{\{\s*_\.([^{}]+)\s*\}\}/g,
    (_, name: string) => '{{' + name.trim() + '}}',
  );
  const method = text(source.method || 'GET').toUpperCase();
  if (!url || !methods.includes(method)) throw new Error(`Invalid URL or method in “${name}”.`);
  return {
    name,
    folder,
    url,
    method,
    params: [],
    headers: [],
    body: '',
    tests: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
  };
}
export function applyAuth(target: Partial<ApiRequest>, raw: unknown, warnings: string[]): void {
  const auth = object(raw);
  const type = text(auth.type ?? auth.mode).toLowerCase();
  const details = object(auth[type]);
  const value = (key: string): string =>
    text(auth[key] ?? details[key] ?? array(auth[type]).find((r) => r.key === key)?.value);
  if (!type || ['none', 'noauth', 'inherit'].includes(type)) return;
  if (type === 'bearer') {
    target.auth = 'Bearer token';
    target.token = value('token');
  } else if (type === 'basic') {
    target.auth = 'Basic auth';
    target.username = value('username');
    target.password = value('password');
  } else if (type === 'digest') {
    target.auth = 'Digest auth';
    target.username = value('username');
    target.password = value('password');
  } else if (['awsv4', 'iam'].includes(type)) {
    target.auth = 'AWS Signature';
    target.username = value('accessKey') || value('accessKeyId');
    target.password = value('secretKey') || value('secretAccessKey');
    target.authOptions = {
      awsRegion: value('region'),
      awsService: value('service'),
      awsSessionToken: value('sessionToken'),
    };
  } else if (type === 'oauth1') {
    const method = value('signatureMethod');
    target.auth = 'OAuth 1.0';
    target.username = value('consumerKey');
    target.password = value('consumerSecret');
    target.authOptions = {
      oauth1Token: value('token') || value('tokenKey'),
      oauth1TokenSecret: value('tokenSecret'),
      oauth1SignatureMethod:
        (['HMAC-SHA256', 'PLAINTEXT'] as const).find((m) => m === method) || 'HMAC-SHA1',
      oauth1Realm: value('realm'),
    };
    if (method && !['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'].includes(method))
      warnings.push(
        `${target.name}: OAuth 1.0 ${method} signatures are not supported; HMAC-SHA1 is used.`,
      );
  } else if (type === 'ntlm') {
    target.auth = 'NTLM';
    target.username = value('username');
    target.password = value('password');
    target.authOptions = { ntlmDomain: value('domain'), ntlmWorkstation: value('workstation') };
  } else if (type === 'wsse') {
    target.auth = 'WSSE';
    target.username = value('username');
    target.password = value('password');
  } else if (type === 'edgegrid') {
    target.auth = 'Akamai EdgeGrid';
    target.username = value('clientToken');
    target.password = value('clientSecret');
    target.token = value('accessToken');
    target.authOptions = {
      edgegridHeadersToSign: value('headersToSign'),
      edgegridMaxBody: value('maxBody'),
    };
  } else if (type === 'hawk') {
    const algorithm = value('algorithm').toLowerCase();
    target.auth = 'Hawk';
    target.username = value('authId') || value('id');
    target.password = value('authKey') || value('key');
    target.authOptions = {
      hawkAlgorithm: algorithm === 'sha1' ? 'sha1' : 'sha256',
      hawkExt: value('extraData') || value('ext'),
      hawkApp: value('app'),
      hawkDlg: value('delegation') || value('dlg'),
      hawkPayloadHash: ['true', '1'].includes(value('includePayloadHash')),
    };
    if (algorithm && !['sha1', 'sha256'].includes(algorithm))
      warnings.push(`${target.name}: Hawk ${algorithm} is not supported; sha256 is used.`);
  } else if (type === 'jwt') {
    const algorithm = value('algorithm').toUpperCase();
    const supported = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'];
    target.auth = 'JWT bearer';
    target.password = value('secret') || value('privateKey');
    target.authOptions = {
      jwtAlgorithm: (supported.includes(algorithm) ? algorithm : 'HS256') as NonNullable<
        ApiRequest['authOptions']
      >['jwtAlgorithm'],
      jwtPayload: value('payload'),
      jwtPrefix: value('headerPrefix') || 'Bearer',
      jwtSecretBase64: value('isSecretBase64Encoded') === 'true',
    };
    if (algorithm && !supported.includes(algorithm))
      warnings.push(`${target.name}: JWT ${algorithm} is not supported; HS256 is used.`);
  } else if (type === 'oauth2') {
    const grant = value('grant_type') || value('grantType');
    target.auth = 'OAuth 2.0 (request)';
    target.token = value('accessToken');
    target.username = value('username');
    target.password = value('password');
    target.authOptions = {
      oauth2GrantType:
        grant === 'client_credentials'
          ? 'client_credentials'
          : grant === 'password_credentials' || grant === 'password'
            ? 'password'
            : 'authorization_code',
      oauth2AuthorizationUrl: value('authUrl') || value('authorizationUrl'),
      oauth2TokenUrl: value('accessTokenUrl') || value('tokenUrl'),
      oauth2ClientId: value('clientId'),
      oauth2ClientSecret: value('clientSecret'),
      oauth2ClientAuth:
        value('client_authentication') === 'body'
          ? 'body'
          : value('clientSecret')
            ? 'basic'
            : 'none',
      oauth2Scope: value('scope'),
      oauth2Audience: value('audience'),
    };
    if (grant === 'implicit')
      warnings.push(
        `${target.name}: OAuth 2.0 implicit grant is not supported; authorization code with PKCE is used.`,
      );
  } else if (['apikey', 'api-key'].includes(type)) {
    const row = { key: value('key') || value('name'), value: value('value'), enabled: true };
    if (!row.key) warnings.push(`API key name missing for ${target.name}.`);
    else if ((value('in') || value('placement')) === 'query') target.params!.push(row);
    else target.headers!.push(row);
  } else
    warnings.push(
      `${target.name}: ${type} authentication needs a credential profile configured in API Workbench.`,
    );
}
export function warnScripts(source: Obj, warnings: string[]): void {
  if (
    source.event ||
    source.scripts ||
    source.script ||
    source.tests ||
    source.preRequestScript ||
    source.afterResponseScript
  )
    warnings.push(
      'Source scripts and tests are not executed or translated; recreate them with API Workbench assertions.',
    );
}
export function body(
  target: Partial<ApiRequest>,
  raw: unknown,
  style: 'postman' | 'insomnia' | 'bruno' | 'open',
): void {
  const b = object(raw);
  const mode = text(b.mode || b.mimeType || b.type);
  const json = ['json', 'application/json'].includes(mode);
  const graphql = mode === 'graphql' || mode === 'application/graphql';
  const form = ['formdata', 'multipartForm', 'multipart-form', 'multipart/form-data'].includes(
    mode,
  );
  const encoded = [
    'urlencoded',
    'formUrlEncoded',
    'form-urlencoded',
    'application/x-www-form-urlencoded',
  ].includes(mode);
  if (form || encoded) {
    target.bodyType = form ? 'form-data' : 'x-www-form-urlencoded';
    target.bodyFields = rows(
      b.formdata || b.urlencoded || b.multipartForm || b.formUrlEncoded || b.params || b.data,
    ).map((row, i) => {
      const source =
        array(
          b.formdata || b.urlencoded || b.multipartForm || b.formUrlEncoded || b.params || b.data,
        )[i] || {};
      return {
        ...row,
        kind: source.type === 'file' ? 'file' : 'text',
        fileName:
          source.type === 'file'
            ? text(
                source.src ||
                  source.fileName ||
                  (Array.isArray(source.value) ? source.value[0] : source.value),
              )
            : undefined,
      };
    });
  } else if (
    mode === 'file' ||
    mode === 'binary' ||
    (b.fileName && mode === 'application/octet-stream')
  ) {
    target.bodyType = 'binary';
    target.binaryName = text(
      object(b.file).src || array(b.file)[0]?.filePath || array(b.data)[0]?.filePath || b.fileName,
    );
  } else if (graphql) {
    const g = object(b.graphql);
    const query = text(g.query ?? b.text ?? b.data);
    let vars: unknown = g.variables ?? b.variables ?? {};
    if (typeof vars === 'string') {
      try {
        vars = JSON.parse(vars);
      } catch {
        /* Preserve unparsed variables below. */
      }
    }
    target.body = JSON.stringify({ query, variables: vars }, null, 2);
    target.bodyType = 'raw';
    target.rawContentType = 'application/json';
  } else {
    const data = b.raw ?? b.text ?? b.data ?? b.json ?? b.xml ?? b.sparql;
    target.body = text(data);
    target.bodyType = target.body ? 'raw' : 'none';
    target.rawContentType = json
      ? 'application/json'
      : mode === 'xml'
        ? 'application/xml'
        : mode.includes('/')
          ? mode
          : text(object(object(b.options).raw).language) === 'json'
            ? 'application/json'
            : 'text/plain';
    if (style === 'bruno' && mode === 'json') target.body = text(b.json);
  }
  if (
    target.rawContentType &&
    target.body &&
    !target.headers!.some((h) => h.key.toLowerCase() === 'content-type')
  )
    target.headers!.push({ key: 'Content-Type', value: target.rawContentType, enabled: true });
}
export function cleanExport(state: WorkspaceState): WorkspaceState {
  const copy = structuredClone(state);
  const secret = /authorization|cookie|secret|token|password|api[-_]?key|credential/i;
  for (const r of copy.requests) {
    r.httpSettings = redactProxySettings(r.httpSettings);
    delete r.credentialId;
    r.token = '';
    r.password = '';
    r.response = null;
    r.url = r.url
      .replace(/^(https?:\/\/)[^/@]+@/i, '$1')
      .replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, key: string) => {
        let name = key;
        try {
          name = decodeURIComponent(key);
        } catch {
          /* Keep malformed escapes as text. */
        }
        return secret.test(name) ? separator + key + '=' : match;
      });
    r.params = r.params.map((v) => ({ ...v, value: secret.test(v.key) ? '' : v.value }));
    r.headers = r.headers.map((v) => ({ ...v, value: secret.test(v.key) ? '' : v.value }));
    r.bodyFields = r.bodyFields?.map((v) => ({
      ...v,
      value: secret.test(v.key) ? '' : v.value,
      fileId: undefined,
    }));
  }
  copy.environments = copy.environments.map((e) => ({
    ...e,
    variables: e.variables.map((v) => ({ ...v, value: secret.test(v.key) ? '' : v.value })),
  }));
  if (copy.settings) copy.settings.httpSettings = redactProxySettings(copy.settings.httpSettings);
  copy.collectionHttpSettings = Object.fromEntries(
    Object.entries(copy.collectionHttpSettings || {}).map(([name, config]) => [
      name,
      redactProxySettings(config),
    ]),
  );
  copy.history = [];
  return copy;
}

/** Folder defaults inherit auth and override matching rows without dropping others. */
export function mergeDefaults(parent: Obj, child: Obj): Obj {
  const result = { ...parent, ...child };
  const auth = object(child.auth);
  if (
    child.auth === undefined ||
    child.auth === 'inherit' ||
    auth.type === 'inherit' ||
    auth.mode === 'inherit'
  )
    result.auth = parent.auth;
  for (const key of ['headers', 'metadata', 'variables']) {
    if (!Array.isArray(child[key])) continue;
    const overrides = array(child[key]);
    const names = new Set(overrides.map((r) => text(r.name ?? r.key).toLowerCase()));
    result[key] = [
      ...array(parent[key]).filter((r) => !names.has(text(r.name ?? r.key).toLowerCase())),
      ...overrides,
    ];
  }
  return result;
}
