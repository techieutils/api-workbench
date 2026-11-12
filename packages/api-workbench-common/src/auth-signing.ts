import { createHash, createHmac, randomBytes, randomUUID, sign as signData } from 'node:crypto';

/** Authentication that is computed per request in the main process, from the final URL and body. */
export type SigningAuth =
  | { type: 'digest'; username: string; password: string }
  | {
      type: 'aws';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      region: string;
      service: string;
    }
  | {
      type: 'oauth1';
      consumerKey: string;
      consumerSecret: string;
      token?: string;
      tokenSecret?: string;
      signatureMethod: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
      realm?: string;
    }
  | {
      type: 'jwt';
      algorithm: JWTAlgorithm;
      secret: string;
      secretBase64?: boolean;
      payload: Record<string, unknown>;
      header?: Record<string, unknown>;
      prefix: string;
      expiresInSeconds?: number;
    }
  | { type: 'ntlm'; username: string; password: string; domain?: string; workstation?: string }
  | { type: 'wsse'; username: string; password: string }
  | {
      type: 'edgegrid';
      clientToken: string;
      clientSecret: string;
      accessToken: string;
      /** Request headers included in the signature, in order. */
      headersToSign?: string[];
      /** How much of a POST body is hashed; Akamai's default is 131072 bytes. */
      maxBody?: number;
    }
  | {
      type: 'hawk';
      id: string;
      key: string;
      algorithm: HawkAlgorithm;
      ext?: string;
      app?: string;
      dlg?: string;
      /** Also signs a hash of the body and its content type. */
      includePayloadHash?: boolean;
    };
export const HAWK_ALGORITHMS = ['sha256', 'sha1'] as const;
export type HawkAlgorithm = (typeof HAWK_ALGORITHMS)[number];
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
] as const;
export type JWTAlgorithm = (typeof JWT_ALGORITHMS)[number];

/** RFC 3986 unreserved-only encoding, as required by AWS SigV4 and OAuth 1.0a. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (algorithm: string, key: string | Buffer, data: string) =>
  createHmac(algorithm, key).update(data).digest();
const decodeSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * The header methods signing uses, so either the global Headers or undici's (which the main process
 * sends with) can be signed.
 */
export type SigningHeaders = Pick<Headers, 'get' | 'set' | 'has' | 'delete'> & {
  forEach(callback: (value: string, name: string) => void): void;
};

// AWS Signature Version 4

export interface AWSSignInput {
  method: string;
  url: URL;
  headers: SigningHeaders;
  /** Raw body bytes, or undefined to sign an unsigned payload (multipart streams). */
  body: string | Buffer | undefined;
  unsignedPayload?: boolean;
  now?: Date;
}
/** Adds X-Amz-Date, optional security token and content hash, and the Authorization header. */
export function signAWS(auth: Extract<SigningAuth, { type: 'aws' }>, input: AWSSignInput): void {
  if (!auth.accessKeyId || !auth.secretAccessKey)
    throw new Error('AWS Signature requires an access key ID and secret access key.');
  if (!auth.region || !auth.service)
    throw new Error('AWS Signature requires a region and service name.');
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const s3 = auth.service.toLowerCase() === 's3';
  const payloadHash = input.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256Hex(input.body ?? '');
  const headers = input.headers;
  headers.set('x-amz-date', amzDate);
  if (auth.sessionToken) headers.set('x-amz-security-token', auth.sessionToken);
  else headers.delete('x-amz-security-token');
  if (s3 || input.unsignedPayload) headers.set('x-amz-content-sha256', payloadHash);
  const signed = new Map<string, string>([['host', input.url.host]]);
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (key.startsWith('x-amz-') || key === 'content-type' || key === 'content-md5')
      signed.set(key, value.trim().replace(/\s+/g, ' '));
  });
  const names = [...signed.keys()].sort();
  const segments = input.url.pathname.split('/').map((segment) => rfc3986(decodeSafe(segment)));
  const canonicalPath =
    (s3 ? segments : segments.map((segment) => rfc3986(segment))).join('/') || '/';
  const query = [...input.url.searchParams]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    query,
    names.map((name) => `${name}:${signed.get(name)}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${auth.region}/${auth.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let key: Buffer = hmac('sha256', `AWS4${auth.secretAccessKey}`, dateStamp);
  for (const part of [auth.region, auth.service, 'aws4_request']) key = hmac('sha256', key, part);
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${auth.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  );
}

// OAuth 1.0a (RFC 5849)

export interface OAuth1SignInput {
  method: string;
  url: URL;
  /** Decoded application/x-www-form-urlencoded body parameters, when the body uses that type. */
  formParams?: [string, string][];
  nonce?: string;
  timestamp?: number;
}
export function oauth1Header(
  auth: Extract<SigningAuth, { type: 'oauth1' }>,
  input: OAuth1SignInput,
): string {
  if (!auth.consumerKey) throw new Error('OAuth 1.0 requires a consumer key.');
  const oauth: Record<string, string> = {
    oauth_consumer_key: auth.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: auth.signatureMethod,
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(auth.token ? { oauth_token: auth.token } : {}),
  };
  const key = `${rfc3986(auth.consumerSecret || '')}&${rfc3986(auth.tokenSecret || '')}`;
  let signature: string;
  if (auth.signatureMethod === 'PLAINTEXT') signature = key;
  else {
    const params = [
      ...input.url.searchParams,
      ...(input.formParams || []),
      ...Object.entries(oauth),
    ]
      .map(([name, value]) => [rfc3986(name), rfc3986(value)])
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const base = `${input.url.protocol}//${input.url.host.toLowerCase()}${input.url.pathname}`;
    const baseString = [input.method.toUpperCase(), rfc3986(base), rfc3986(params)].join('&');
    signature = hmac(
      auth.signatureMethod === 'HMAC-SHA256' ? 'sha256' : 'sha1',
      key,
      baseString,
    ).toString('base64');
  }
  const fields = { ...oauth, oauth_signature: signature };
  return `OAuth ${[
    ...(auth.realm ? [`realm="${auth.realm.replace(/(["\\])/g, '\\$1')}"`] : []),
    ...Object.entries(fields).map(([name, value]) => `${rfc3986(name)}="${rfc3986(value)}"`),
  ].join(', ')}`;
}

// JSON Web Token generation

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
export function createJWT(auth: Extract<SigningAuth, { type: 'jwt' }>, now = Date.now()): string {
  if (!JWT_ALGORITHMS.includes(auth.algorithm))
    throw new Error('Choose a supported JWT algorithm.');
  if (!auth.secret)
    throw new Error(
      auth.algorithm.startsWith('HS')
        ? 'JWT signing requires a secret.'
        : 'JWT signing requires a PEM private key.',
    );
  const issuedAt = Math.floor(now / 1000);
  const payload = { ...auth.payload };
  if (auth.expiresInSeconds && auth.expiresInSeconds > 0) {
    payload.iat ??= issuedAt;
    payload.exp ??= issuedAt + auth.expiresInSeconds;
  }
  const header = { ...auth.header, alg: auth.algorithm, typ: auth.header?.typ ?? 'JWT' };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const bits = auth.algorithm.slice(2);
  let signature: Buffer;
  if (auth.algorithm.startsWith('HS'))
    signature = hmac(
      `sha${bits}`,
      auth.secretBase64 ? Buffer.from(auth.secret, 'base64') : auth.secret,
      input,
    );
  else
    try {
      signature = signData(`sha${bits}`, Buffer.from(input), {
        key: auth.secret,
        ...(auth.algorithm.startsWith('ES') ? { dsaEncoding: 'ieee-p1363' as const } : {}),
      });
    } catch {
      throw new Error(
        `The private key cannot sign ${auth.algorithm}. Paste a matching PEM private key.`,
      );
    }
  return `${input}.${base64url(signature)}`;
}

/** Signed tokens by configuration, so a JWT is reused until it is about to expire. */
const jwtCache = new Map<string, { token: string; renewAt: number }>();
const JWT_CACHE_LIMIT = 100;
/**
 * A JWT for the configuration, reused until shortly before its `exp`: 10% of its lifetime early,
 * at most 30 seconds, so it does not expire in flight. A token without `exp` never expires, so it
 * is reused for as long as the configuration is unchanged. Any change to the algorithm, key,
 * header, payload (including resolved variables such as `{{$guid}}`), or lifetime signs a new one.
 */
export function cachedJWT(auth: Extract<SigningAuth, { type: 'jwt' }>, now = Date.now()): string {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        auth.algorithm,
        auth.secret,
        auth.secretBase64 === true,
        auth.header ?? {},
        auth.payload,
        auth.expiresInSeconds ?? 0,
      ]),
    )
    .digest('base64');
  const cached = jwtCache.get(key);
  if (cached && now < cached.renewAt) return cached.token;
  const token = createJWT(auth, now);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    exp?: unknown;
    iat?: unknown;
  };
  let renewAt = Number.POSITIVE_INFINITY;
  if (typeof claims.exp === 'number') {
    const expiresAt = claims.exp * 1000;
    const issuedAt = typeof claims.iat === 'number' ? claims.iat * 1000 : now;
    renewAt = expiresAt - Math.min(30_000, Math.max(0, expiresAt - issuedAt) * 0.1);
  }
  // A token that is already due for renewal is used once and not kept.
  if (renewAt > now) {
    jwtCache.delete(key);
    if (jwtCache.size >= JWT_CACHE_LIMIT) jwtCache.delete(jwtCache.keys().next().value!);
    jwtCache.set(key, { token, renewAt });
  }
  return token;
}

// HTTP Digest (RFC 7616 / RFC 2617)

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
}
/** Parses the first Digest challenge in a WWW-Authenticate header. */
export function parseDigestChallenge(header: string | null): DigestChallenge | undefined {
  if (!header) return undefined;
  const start = header.search(/digest\s/i);
  if (start < 0) return undefined;
  const params: Record<string, string> = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  for (const match of header.slice(start + 7).matchAll(pattern))
    params[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
  if (!params.nonce) return undefined;
  return {
    realm: params.realm ?? '',
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm || 'MD5',
  };
}
export function digestAuthorization(
  auth: Extract<SigningAuth, { type: 'digest' }>,
  challenge: DigestChallenge,
  method: string,
  uri: string,
  cnonce = randomBytes(8).toString('hex'),
  nc = 1,
): string {
  const algorithm = challenge.algorithm.toUpperCase();
  const sess = algorithm.endsWith('-SESS');
  const base = algorithm.replace(/-SESS$/, '');
  const hashName =
    base === 'SHA-256'
      ? 'sha256'
      : base === 'SHA-512-256'
        ? 'sha512-256'
        : base === 'MD5'
          ? 'md5'
          : undefined;
  if (!hashName) throw new Error(`Digest algorithm ${challenge.algorithm} is not supported.`);
  const H = (value: string) => createHash(hashName).update(value).digest('hex');
  const qop = challenge.qop
    ?.split(',')
    .map((item) => item.trim())
    .includes('auth')
    ? 'auth'
    : undefined;
  if (challenge.qop && !qop) throw new Error('Only Digest qop="auth" is supported.');
  const count = nc.toString(16).padStart(8, '0');
  let ha1 = H(`${auth.username}:${challenge.realm}:${auth.password}`);
  if (sess) ha1 = H(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = H(`${method.toUpperCase()}:${uri}`);
  const response = qop
    ? H(`${ha1}:${challenge.nonce}:${count}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${challenge.nonce}:${ha2}`);
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return `Digest ${[
    `username=${quote(auth.username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    ...(challenge.algorithm ? [`algorithm=${challenge.algorithm}`] : []),
    `response=${quote(response)}`,
    ...(challenge.opaque !== undefined ? [`opaque=${quote(challenge.opaque)}`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${count}`, `cnonce=${quote(cnonce)}`] : []),
  ].join(', ')}`;
}
// WSSE UsernameToken (the X-WSSE header used by Atom and Symfony-style APIs)

export function wsseHeaders(
  auth: Extract<SigningAuth, { type: 'wsse' }>,
  nonce = randomBytes(16).toString('hex'),
  now = Date.now(),
): { authorization: string; 'x-wsse': string } {
  const created = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = createHash('sha1')
    .update(nonce + created + auth.password)
    .digest('base64');
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return {
    authorization: 'WSSE profile="UsernameToken"',
    'x-wsse': `UsernameToken Username=${quote(auth.username)}, PasswordDigest=${quote(digest)}, Nonce=${quote(Buffer.from(nonce).toString('base64'))}, Created=${quote(created)}`,
  };
}

// Akamai EdgeGrid (EG1-HMAC-SHA256)

export interface EdgeGridSignInput {
  method: string;
  url: URL;
  headers: SigningHeaders;
  body?: string | Buffer;
}
export function edgeGridHeader(
  auth: Extract<SigningAuth, { type: 'edgegrid' }>,
  input: EdgeGridSignInput,
  nonce: string = randomUUID(),
  now = Date.now(),
): string {
  const timestamp = new Date(now)
    .toISOString()
    .replace(/[-]/g, '')
    .replace(/\.\d{3}Z$/, '+0000');
  const prefix = `EG1-HMAC-SHA256 client_token=${auth.clientToken};access_token=${auth.accessToken};timestamp=${timestamp};nonce=${nonce};`;
  const canonicalHeaders = (auth.headersToSign ?? [])
    .map((name) => [name.trim().toLowerCase(), input.headers.get(name)] as const)
    .filter(([name, value]) => name && value !== null)
    .map(([name, value]) => `${name}:${value!.trim().replace(/\s+/g, ' ')}`)
    .join('\t');
  const body =
    typeof input.body === 'string' ? Buffer.from(input.body) : (input.body ?? Buffer.alloc(0));
  const contentHash =
    input.method.toUpperCase() === 'POST' && body.length
      ? createHash('sha256')
          .update(body.subarray(0, auth.maxBody ?? 131072))
          .digest('base64')
      : '';
  const data = [
    input.method.toUpperCase(),
    input.url.protocol.slice(0, -1),
    input.url.host.toLowerCase(),
    input.url.pathname + input.url.search,
    canonicalHeaders,
    contentHash,
    prefix,
  ].join('\t');
  const signingKey = createHmac('sha256', auth.clientSecret).update(timestamp).digest('base64');
  return `${prefix}signature=${createHmac('sha256', signingKey).update(data).digest('base64')}`;
}

// Hawk (hueniverse/hawk, version 1)

export interface HawkSignInput {
  method: string;
  url: URL;
  contentType?: string;
  body?: string | Buffer;
}
export function hawkHeader(
  auth: Extract<SigningAuth, { type: 'hawk' }>,
  input: HawkSignInput,
  nonce = randomBytes(6).toString('base64url'),
  now = Date.now(),
): string {
  const ts = Math.floor(now / 1000).toString();
  const port = input.url.port || (input.url.protocol === 'https:' ? '443' : '80');
  const hash = auth.includePayloadHash
    ? createHash(auth.algorithm)
        .update('hawk.1.payload\n')
        .update(`${(input.contentType ?? '').split(';')[0].trim().toLowerCase()}\n`)
        .update(input.body ?? '')
        .update('\n')
        .digest('base64')
    : undefined;
  const ext = (auth.ext ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  let normalized = [
    'hawk.1.header',
    ts,
    nonce,
    input.method.toUpperCase(),
    input.url.pathname + input.url.search,
    input.url.hostname.toLowerCase(),
    port,
    hash ?? '',
    ext,
  ].join('\n');
  normalized += '\n';
  if (auth.app) normalized += `${auth.app}\n${auth.dlg ?? ''}\n`;
  const mac = createHmac(auth.algorithm, auth.key).update(normalized).digest('base64');
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return `Hawk ${[
    `id=${quote(auth.id)}`,
    `ts=${quote(ts)}`,
    `nonce=${quote(nonce)}`,
    ...(hash ? [`hash=${quote(hash)}`] : []),
    ...(auth.ext ? [`ext=${quote(auth.ext)}`] : []),
    `mac=${quote(mac)}`,
    ...(auth.app ? [`app=${quote(auth.app)}`] : []),
    ...(auth.app && auth.dlg ? [`dlg=${quote(auth.dlg)}`] : []),
  ].join(', ')}`;
}

/** Validates a signing configuration received over IPC. */
export function checkedSigningAuth(value: unknown): SigningAuth | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid authentication configuration.');
  const auth = value as Record<string, unknown>;
  const text = (key: string) => {
    if (auth[key] !== undefined && typeof auth[key] !== 'string')
      throw new Error('Invalid authentication configuration.');
  };
  if (auth.type === 'digest') ['username', 'password'].forEach(text);
  else if (auth.type === 'aws')
    ['accessKeyId', 'secretAccessKey', 'sessionToken', 'region', 'service'].forEach(text);
  else if (auth.type === 'oauth1') {
    ['consumerKey', 'consumerSecret', 'token', 'tokenSecret', 'realm'].forEach(text);
    if (!['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'].includes(auth.signatureMethod as string))
      throw new Error('Choose an OAuth 1.0 signature method.');
  } else if (auth.type === 'jwt') {
    ['secret', 'prefix'].forEach(text);
    if (!JWT_ALGORITHMS.includes(auth.algorithm as JWTAlgorithm))
      throw new Error('Choose a supported JWT algorithm.');
    if (!auth.payload || typeof auth.payload !== 'object' || Array.isArray(auth.payload))
      throw new Error('The JWT payload must be a JSON object.');
  } else if (auth.type === 'ntlm') ['username', 'password', 'domain', 'workstation'].forEach(text);
  else if (auth.type === 'wsse') ['username', 'password'].forEach(text);
  else if (auth.type === 'edgegrid') {
    ['clientToken', 'clientSecret', 'accessToken'].forEach(text);
    if (
      auth.headersToSign !== undefined &&
      (!Array.isArray(auth.headersToSign) ||
        auth.headersToSign.some((name) => typeof name !== 'string'))
    )
      throw new Error('Invalid authentication configuration.');
    if (
      auth.maxBody !== undefined &&
      (typeof auth.maxBody !== 'number' || !Number.isInteger(auth.maxBody) || auth.maxBody < 0)
    )
      throw new Error('EdgeGrid max body must be a whole number of bytes.');
  } else if (auth.type === 'hawk') {
    ['id', 'key', 'ext', 'app', 'dlg'].forEach(text);
    if (!HAWK_ALGORITHMS.includes(auth.algorithm as HawkAlgorithm))
      throw new Error('Choose a Hawk algorithm.');
    if (auth.includePayloadHash !== undefined && typeof auth.includePayloadHash !== 'boolean')
      throw new Error('Invalid authentication configuration.');
  } else throw new Error('Unsupported authentication type.');
  return value as SigningAuth;
}
