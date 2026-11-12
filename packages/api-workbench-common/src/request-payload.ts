import * as http from './http-settings';
import type { HTTPSettings } from './http-settings';
import type { SigningAuth } from './auth-signing';
import type { ClientCertificatePayload } from './client-certificates';
import type { StoredCookie } from './cookies';
import { folderChain } from './folders';
import type { ApiRequest, AuthConfig, RequestPayload, UploadData, WorkspaceState } from './types';

/**
 * Turning a saved request into what is sent: its auth (following "Inherit from collection"),
 * HTTP settings (workspace, collection, folder, request), query, automatic headers, and body.
 * The desktop app and the command line both use these, so a request sends the same from either.
 * Variables are resolved by the caller's `resolve`, which knows the environment in use.
 */

type Resolve = (value: string) => string;
/** The parts of a workspace that shape what a request sends. */
export type PayloadWorkspace = Pick<
  WorkspaceState,
  'collectionAuth' | 'collectionHttpSettings' | 'settings'
>;
export interface PayloadContext {
  workspace: PayloadWorkspace;
  resolve: Resolve;
  /** A chosen file, by request id (binary bodies) or a form field's file id. */
  upload?: (id: string) => UploadData | undefined;
  /** The cookies to send from, when the cookie jar is on. */
  cookieJar?: StoredCookie[];
  /** The client certificate for the request's final URL, if one matches. */
  clientCertificate?: (url: string) => ClientCertificatePayload | undefined;
}
const NO_AUTH: AuthConfig = { auth: 'None', token: '', username: '', password: '' };

/** The default auth saved on exactly this collection or folder. */
export function collectionAuthOf(
  workspace: PayloadWorkspace,
  folder: string,
): AuthConfig | undefined {
  return workspace.collectionAuth && Object.hasOwn(workspace.collectionAuth, folder)
    ? workspace.collectionAuth[folder]
    : undefined;
}
/**
 * The default a request in `folder` inherits, and the level it comes from: the nearest folder
 * (or the collection) whose default is not itself "Inherit from collection".
 */
export function inheritedAuth(
  workspace: PayloadWorkspace,
  folder: string,
): { config: AuthConfig; folder: string } | undefined {
  for (const path of folderChain(folder).reverse()) {
    const config = collectionAuthOf(workspace, path);
    if (config && config.auth !== 'Inherit from collection') return { config, folder: path };
  }
  return undefined;
}
/** The auth a request actually sends, following Inherit through its folders to the collection. */
export function effectiveAuth(workspace: PayloadWorkspace, request: ApiRequest): AuthConfig {
  if (request.auth !== 'Inherit from collection') return request;
  return inheritedAuth(workspace, request.folder)?.config ?? NO_AUTH;
}

export const basicHeader = (username: string, password: string) =>
  `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`)))}`;
function parsedJSONObject(
  source: string | undefined,
  label: string,
  resolve: Resolve,
): Record<string, unknown> {
  if (!source?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(resolve(source));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
/** Headers, query parameters, and main-process signing for an auth configuration. */
export function applyAuth(
  config: AuthConfig,
  resolve: Resolve,
): { headers: Record<string, string>; query: [string, string][]; signing?: SigningAuth } {
  const options = config.authOptions || {};
  const result: ReturnType<typeof applyAuth> = { headers: {}, query: [] };
  if (config.auth === 'Bearer token')
    result.headers.Authorization = `Bearer ${resolve(config.token)}`;
  else if (config.auth === 'OAuth 2.0 (request)') {
    if (!config.token) throw new Error('Get an OAuth 2.0 access token in the Auth tab first.');
    if (options.oauth2ExpiresAt && options.oauth2ExpiresAt <= Date.now())
      throw new Error(
        'The OAuth 2.0 access token expired. Get a new access token in the Auth tab.',
      );
    result.headers.Authorization = `Bearer ${config.token}`;
  } else if (config.auth === 'Basic auth')
    result.headers.Authorization = basicHeader(resolve(config.username), resolve(config.password));
  else if (config.auth === 'API key' && config.username) {
    if (options.apiKeyIn === 'query') {
      result.query.push([resolve(config.username), resolve(config.token)]);
    } else result.headers[resolve(config.username)] = resolve(config.token);
  } else if (config.auth === 'Digest auth')
    result.signing = {
      type: 'digest',
      username: resolve(config.username),
      password: resolve(config.password),
    };
  else if (config.auth === 'AWS Signature')
    result.signing = {
      type: 'aws',
      accessKeyId: resolve(config.username),
      secretAccessKey: resolve(config.password),
      sessionToken: resolve(options.awsSessionToken || '') || undefined,
      region: resolve(options.awsRegion || '').trim(),
      service: resolve(options.awsService || '').trim(),
    };
  else if (config.auth === 'OAuth 1.0')
    result.signing = {
      type: 'oauth1',
      consumerKey: resolve(config.username),
      consumerSecret: resolve(config.password),
      token: resolve(options.oauth1Token || '') || undefined,
      tokenSecret: resolve(options.oauth1TokenSecret || '') || undefined,
      signatureMethod: options.oauth1SignatureMethod || 'HMAC-SHA1',
      realm: resolve(options.oauth1Realm || '') || undefined,
    };
  else if (config.auth === 'NTLM')
    result.signing = {
      type: 'ntlm',
      username: resolve(config.username),
      password: resolve(config.password),
      domain: resolve(options.ntlmDomain || '').trim() || undefined,
      workstation: resolve(options.ntlmWorkstation || '').trim() || undefined,
    };
  else if (config.auth === 'WSSE')
    result.signing = {
      type: 'wsse',
      username: resolve(config.username),
      password: resolve(config.password),
    };
  else if (config.auth === 'Akamai EdgeGrid') {
    const maxBody = resolve(options.edgegridMaxBody || '').trim();
    if (maxBody && !/^\d+$/.test(maxBody))
      throw new Error('EdgeGrid max body size must be a whole number of bytes.');
    result.signing = {
      type: 'edgegrid',
      clientToken: resolve(config.username).trim(),
      clientSecret: resolve(config.password).trim(),
      accessToken: resolve(config.token).trim(),
      headersToSign: resolve(options.edgegridHeadersToSign || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
      maxBody: maxBody ? Number(maxBody) : undefined,
    };
  } else if (config.auth === 'Hawk')
    result.signing = {
      type: 'hawk',
      id: resolve(config.username),
      key: resolve(config.password),
      algorithm: options.hawkAlgorithm || 'sha256',
      ext: resolve(options.hawkExt || '') || undefined,
      app: resolve(options.hawkApp || '') || undefined,
      dlg: resolve(options.hawkDlg || '') || undefined,
      includePayloadHash: options.hawkPayloadHash === true,
    };
  else if (config.auth === 'JWT bearer') {
    const expires = Number(resolve(options.jwtExpiresIn || '0'));
    if (!Number.isFinite(expires) || expires < 0)
      throw new Error('JWT expiry must be a number of seconds.');
    result.signing = {
      type: 'jwt',
      algorithm: options.jwtAlgorithm || 'HS256',
      secret: resolve(config.password),
      secretBase64: options.jwtSecretBase64 === true,
      payload: parsedJSONObject(options.jwtPayload, 'JWT payload', resolve),
      header: parsedJSONObject(options.jwtHeader, 'JWT header', resolve),
      prefix: resolve(options.jwtPrefix ?? 'Bearer'),
      expiresInSeconds: expires,
    };
  }
  return result;
}

/** The overrides saved on exactly this collection or folder. */
function folderSettings(workspace: PayloadWorkspace, folder: string): Partial<HTTPSettings> {
  const overrides = workspace.collectionHttpSettings;
  return overrides && Object.hasOwn(overrides, folder) ? overrides[folder] : {};
}
/** The overrides a folder passes on: its collection's, then each folder's down to this one. */
export function collectionHTTPSettings(
  workspace: PayloadWorkspace,
  folder: string,
): Partial<HTTPSettings> {
  return Object.assign({}, ...folderChain(folder).map((path) => folderSettings(workspace, path)));
}
/** The settings a request sends with, after workspace, collection, folder, and request overrides. */
export const effectiveHTTPSettings = (
  workspace: PayloadWorkspace,
  request: ApiRequest,
): HTTPSettings =>
  http.inherit(
    http.workspaceDefaults(workspace.settings ?? {}),
    collectionHTTPSettings(workspace, request.folder),
    request.httpSettings,
  );

/** The URL with the enabled Params rows as its query, replacing the rows it had before. */
export function requestQueryURL(request: ApiRequest, previousKeys: string[] = []): string {
  const hashIndex = request.url.indexOf('#');
  const hash = hashIndex >= 0 ? request.url.slice(hashIndex) : '';
  const source = hashIndex >= 0 ? request.url.slice(0, hashIndex) : request.url;
  const queryIndex = source.indexOf('?');
  const base = queryIndex >= 0 ? source.slice(0, queryIndex) : source;
  const query = new URLSearchParams(queryIndex >= 0 ? source.slice(queryIndex + 1) : '');
  const managedKeys = new Set(
    [...previousKeys, ...request.params.map((row) => row.key)].filter(Boolean),
  );
  for (const key of managedKeys) query.delete(key);
  request.params
    .filter((row) => row.enabled && row.key)
    .forEach((row) => query.append(row.key, row.value));
  // Keep variable references readable and available for environment resolution at send time.
  const text = query.toString().replace(/%7B%7B.*?%7D%7D/gi, (value) => decodeURIComponent(value));
  return base + (text ? `?${text}` : '') + hash;
}
/** The headers the client adds to every request unless the request sets its own. */
export function automaticHeaders(
  workspace: PayloadWorkspace,
  request: ApiRequest,
): Record<string, string> {
  const config = effectiveHTTPSettings(workspace, request);
  return {
    Accept: workspace.settings?.defaultAccept || '*/*',
    ...(config.httpVersion === '1.1'
      ? { Connection: config.keepAlive ? 'keep-alive' : 'close' }
      : {}),
    'User-Agent': 'API-Workbench/1.0',
    'Accept-Encoding': 'gzip, deflate, br',
  };
}
/** The body to send, setting or clearing the Content-Type header in `headers` to match. */
export function prepareBody(
  request: ApiRequest,
  headers: Record<string, string>,
  resolve: Resolve,
  upload: (id: string) => UploadData | undefined = () => undefined,
): Pick<RequestPayload, 'body' | 'multipart' | 'binary'> {
  const mode = request.bodyType || 'raw';
  const setType = (value?: string) => {
    Object.keys(headers)
      .filter(
        (key) => key.toLowerCase() === 'content-type' || key.toLowerCase() === 'content-length',
      )
      .forEach((key) => delete headers[key]);
    if (value) headers['Content-Type'] = value;
  };
  if (mode === 'none' || ['GET', 'HEAD'].includes(request.method)) return { body: '' };
  if (mode === 'raw') {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type'))
      setType(request.rawContentType || 'application/json');
    return { body: resolve(request.body) };
  }
  if (mode === 'binary') {
    const file = upload(request.id);
    if (!file) throw new Error('Choose a binary file before sending.');
    setType(file.type || 'application/octet-stream');
    return { body: '', binary: file };
  }
  const fields = (request.bodyFields || []).filter((field) => field.enabled && field.key);
  if (mode === 'x-www-form-urlencoded') {
    setType('application/x-www-form-urlencoded');
    const values = new URLSearchParams();
    fields.forEach((field) => values.append(resolve(field.key), resolve(field.value)));
    return { body: values.toString() };
  }
  setType();
  return {
    body: '',
    multipart: fields.map((field) => {
      if (field.kind !== 'file') return { name: resolve(field.key), value: resolve(field.value) };
      const file = field.fileId ? upload(field.fileId) : undefined;
      if (!file) throw new Error(`Choose a file for ${field.key} before sending.`);
      return { name: resolve(field.key), value: '', file };
    }),
  };
}

/** Everything an HTTP request sends, with variables resolved; live protocols are refused. */
export function preparePayload(request: ApiRequest, context: PayloadContext): RequestPayload {
  if (request.protocol && request.protocol !== 'http')
    throw new Error(
      'Live protocol requests run from their connection editor, rather than the HTTP runner.',
    );
  const { resolve, workspace } = context;
  const settings = http.resolve(effectiveHTTPSettings(workspace, request));
  const composed = requestQueryURL(request);
  const hashIndex = composed.indexOf('#');
  const withoutHash = hashIndex >= 0 ? composed.slice(0, hashIndex) : composed;
  const queryIndex = withoutHash.indexOf('?');
  const url = new URL(resolve(queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash));
  if (queryIndex >= 0)
    new URLSearchParams(withoutHash.slice(queryIndex + 1)).forEach((value, key) =>
      url.searchParams.append(resolve(key), resolve(value)),
    );
  if (hashIndex >= 0) url.hash = resolve(composed.slice(hashIndex + 1));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS URL');
  const authConfig = effectiveAuth(workspace, request);
  const vault = authConfig.auth === 'Saved credential';
  if (vault && !authConfig.credentialId)
    throw new Error(
      request.auth === 'Inherit from collection'
        ? `Select a saved credential in the ${request.folder} collection authentication.`
        : 'Select a saved credential in the Authentication tab.',
    );
  const headers = Object.fromEntries(
    request.headers
      .filter((header) => header.enabled && header.key)
      .map((header) => [resolve(header.key), resolve(header.value)]),
  );
  for (const [key, value] of Object.entries(automaticHeaders(workspace, request)))
    if (!Object.keys(headers).some((name) => name.toLowerCase() === key.toLowerCase()))
      headers[key] = value;
  const applied = applyAuth(authConfig, resolve);
  Object.assign(headers, applied.headers);
  applied.query.forEach(([key, value]) => url.searchParams.set(key, value));
  return {
    id: request.id,
    url: url.toString(),
    method: request.method,
    headers,
    ...prepareBody(request, headers, resolve, context.upload),
    credentialId: vault ? authConfig.credentialId : undefined,
    signing: applied.signing,
    clientCertificate: context.clientCertificate?.(url.toString()),
    cookieJar: context.cookieJar,
    httpSettings: settings,
    timeoutMs: settings.timeoutMs,
    followRedirects: settings.followRedirects,
  };
}
