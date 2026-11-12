import { validateProxy, validateProxyURL } from './proxy';
export { proxyForURL, redactProxySettings } from './proxy';
export type HTTPVersion = '1.1' | 'auto' | '2';
export type TLSVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
/** A header carrying a hash of the request body, so the server can check it arrived intact. */
export type IntegrityHeader =
  | 'none'
  | 'content-digest-sha256'
  | 'content-digest-sha512'
  | 'digest-sha256'
  | 'content-md5'
  | 'amz-checksum-sha256'
  | 'amz-checksum-sha1'
  | 'custom-header';
/** The hash a custom integrity header carries. */
export type IntegrityAlgorithm =
  'crc32' | 'crc32c' | 'sha1' | 'sha256' | 'md5' | 'xxhash64' | 'xxhash3' | 'xxhash128' | 'sha512';
export const integrityAlgorithms: [IntegrityAlgorithm, string][] = [
  ['crc32', 'CRC-32 (CRC32)'],
  ['crc32c', 'CRC-32C (CRC32C)'],
  ['sha1', 'SHA-1 (SHA1)'],
  ['sha256', 'SHA-256 (SHA256)'],
  ['md5', 'MD5 (MD5)'],
  ['xxhash64', 'XXHash64 (XXHASH64)'],
  ['xxhash3', 'XXHash3 (XXHASH3)'],
  ['xxhash128', 'XXHash128 (XXHASH128)'],
  ['sha512', 'SHA-512 (SHA512)'],
];
/**
 * Headers a custom integrity header may not replace: they frame, route, or authorize the request,
 * or are set by the HTTP client itself.
 */
const RESERVED_INTEGRITY_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Why a custom integrity header name cannot be used, or undefined when it can. */
export function integrityHeaderNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a header name for the custom integrity header.';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimmed))
    return 'The integrity header name can use letters, digits, and - only (no spaces or colons).';
  if (RESERVED_INTEGRITY_HEADERS.has(trimmed.toLowerCase()))
    return `${trimmed} cannot carry the body hash; choose another header name.`;
  return undefined;
}
export interface HTTPSettings {
  proxyMode: 'direct' | 'custom';
  proxyUrl: string;
  proxyUsername: string;
  proxyPassword: string;
  proxyBypass: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  httpVersion: HTTPVersion;
  tlsMinVersion: TLSVersion;
  tlsMaxVersion: TLSVersion;
  tlsCiphers: string;
  caCertificates: string;
  verifyTLS: boolean;
  keepAlive: boolean;
  keepAliveTimeoutMs: number;
  maxResponseSizeMB: number;
  maxHeaderSizeKB: number;
  addressFamily: 'auto' | 'ipv4' | 'ipv6';
  autoSelectFamily: boolean;
  autoSelectFamilyAttemptTimeoutMs: number;
  maxConnections: number;
  pipelining: number;
  maxRequestsPerConnection: number;
  maxConcurrentStreams: number;
  integrityHeader: IntegrityHeader;
  integrityHeaderName: string;
  integrityAlgorithm: IntegrityAlgorithm;
  integrityEncoding: 'base64' | 'hex';
}
export const defaults: HTTPSettings = {
  proxyMode: 'direct',
  proxyUrl: '',
  proxyUsername: '',
  proxyPassword: '',
  proxyBypass: '',
  timeoutMs: 60000,
  connectTimeoutMs: 10000,
  headersTimeoutMs: 60000,
  bodyTimeoutMs: 60000,
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: '1.1',
  tlsMinVersion: 'TLSv1.2',
  tlsMaxVersion: 'TLSv1.3',
  tlsCiphers: '',
  caCertificates: '',
  verifyTLS: true,
  keepAlive: true,
  keepAliveTimeoutMs: 4000,
  maxResponseSizeMB: 50,
  maxHeaderSizeKB: 16,
  addressFamily: 'auto',
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeoutMs: 250,
  maxConnections: 0,
  pipelining: 1,
  maxRequestsPerConnection: 0,
  maxConcurrentStreams: 100,
  integrityHeader: 'none',
  integrityHeaderName: 'x-checksum',
  integrityAlgorithm: 'sha256',
  integrityEncoding: 'base64',
};
export interface HTTPField {
  key: keyof HTTPSettings;
  label: string;
  help: string;
  group: 'Execution' | 'Connection' | 'TLS' | 'Proxy';
  min?: number;
  max?: number;
  options?: [string, string][];
}
const tlsVersions: [string, string][] = [
  ['TLSv1', 'TLS 1.0'],
  ['TLSv1.1', 'TLS 1.1'],
  ['TLSv1.2', 'TLS 1.2'],
  ['TLSv1.3', 'TLS 1.3'],
];
export const fields: HTTPField[] = [
  {
    key: 'proxyMode',
    label: 'Proxy mode',
    help: 'Direct connects without a proxy. HTTP(S) proxy uses the URL and bypass list below. Each field follows workspace → collection → folder → request inheritance.',
    group: 'Proxy',
    options: [
      ['direct', 'Direct connection'],
      ['custom', 'HTTP(S) proxy'],
    ],
  },
  {
    key: 'proxyUrl',
    label: 'Proxy URL',
    help: 'HTTP or HTTPS proxy, for example http://localhost:8080. Enter authentication separately.',
    group: 'Proxy',
  },
  {
    key: 'proxyUsername',
    label: 'Proxy username',
    help: 'Optional Basic authentication username, sent only to the proxy.',
    group: 'Proxy',
  },
  {
    key: 'proxyPassword',
    label: 'Proxy password',
    help: 'Stored locally with workspace settings. Proxy credentials are excluded from exports.',
    group: 'Proxy',
  },
  {
    key: 'proxyBypass',
    label: 'Bypass proxy for',
    help: 'Comma-separated hosts, domain suffixes, or host:port pairs. Example: localhost, 127.0.0.1, .internal.example, [::1]. Use * to bypass all hosts.',
    group: 'Proxy',
  },

  {
    key: 'timeoutMs',
    label: 'Total request timeout (ms)',
    help: 'Includes credential lookup, connection, redirects, and response download.',
    group: 'Execution',
    min: 100,
    max: 300000,
  },
  {
    key: 'followRedirects',
    label: 'Follow redirects',
    help: 'Redirects stay within the same API origin.',
    group: 'Execution',
  },
  {
    key: 'maxRedirects',
    label: 'Maximum redirects',
    help: 'Maximum redirect hops when redirect following is enabled.',
    group: 'Execution',
    min: 0,
    max: 30,
  },
  {
    key: 'maxResponseSizeMB',
    label: 'Maximum response size (MiB)',
    help: 'Limits the decoded response body stored in the app.',
    group: 'Execution',
    min: 1,
    max: 500,
  },
  {
    key: 'maxHeaderSizeKB',
    label: 'Maximum response headers (KiB)',
    help: 'Limits response headers: parser size for HTTP/1.1 and normalized header size for HTTP/2.',
    group: 'Execution',
    min: 1,
    max: 1024,
  },
  {
    key: 'integrityHeader',
    label: 'Body integrity header',
    help: 'Adds a hash of the final request body, computed just before sending (and before signing), so the server can verify it arrived intact. Requests without a body get none.',
    group: 'Execution',
    options: [
      ['none', 'None'],
      ['content-digest-sha256', 'Content-Digest · SHA-256 (RFC 9530)'],
      ['content-digest-sha512', 'Content-Digest · SHA-512 (RFC 9530)'],
      ['digest-sha256', 'Digest · SHA-256 (RFC 3230, legacy)'],
      ['content-md5', 'Content-MD5'],
      ['amz-checksum-sha256', 'x-amz-checksum-sha256 (S3)'],
      ['amz-checksum-sha1', 'x-amz-checksum-sha1 (S3)'],
      ['custom-header', 'Custom header and algorithm'],
    ],
  },
  {
    key: 'integrityHeaderName',
    label: 'Custom integrity header name',
    help: 'The header that carries the hash when the body integrity header is Custom, for example x-amz-checksum-crc32c or x-checksum-xxhash64.',
    group: 'Execution',
  },
  {
    key: 'integrityAlgorithm',
    label: 'Custom integrity algorithm',
    help: 'The hash of the final request body that the custom header carries.',
    group: 'Execution',
    options: integrityAlgorithms,
  },
  {
    key: 'integrityEncoding',
    label: 'Custom integrity encoding',
    help: 'How the hash is written: Base64 of its bytes, as S3 checksums are, or lowercase hex.',
    group: 'Execution',
    options: [
      ['base64', 'Base64'],
      ['hex', 'Hex'],
    ],
  },
  {
    key: 'httpVersion',
    label: 'HTTP version',
    help: 'Auto negotiates HTTP/2 over HTTPS with HTTP/1.1 fallback. HTTP/2 only requires HTTPS and h2 support.',
    group: 'Connection',
    options: [
      ['1.1', 'HTTP/1.1'],
      ['auto', 'Auto (HTTP/2 preferred)'],
      ['2', 'HTTP/2 only (HTTPS)'],
    ],
  },
  {
    key: 'connectTimeoutMs',
    label: 'Connection timeout (ms)',
    help: 'Time allowed to establish a new TCP/TLS connection.',
    group: 'Connection',
    min: 100,
    max: 300000,
  },
  {
    key: 'headersTimeoutMs',
    label: 'Response headers timeout (ms)',
    help: 'Time allowed to receive response headers.',
    group: 'Connection',
    min: 100,
    max: 300000,
  },
  {
    key: 'bodyTimeoutMs',
    label: 'Response body idle timeout (ms)',
    help: 'Maximum wait between response body chunks.',
    group: 'Connection',
    min: 100,
    max: 300000,
  },
  {
    key: 'keepAlive',
    label: 'Reuse connections',
    help: 'Reuse connections between requests with the same transport settings.',
    group: 'Connection',
  },
  {
    key: 'keepAliveTimeoutMs',
    label: 'Keep-alive idle timeout (ms)',
    help: 'Idle lifetime for pooled connections, subject to server hints.',
    group: 'Connection',
    min: 1000,
    max: 600000,
  },
  {
    key: 'addressFamily',
    label: 'IP address family',
    help: 'Choose which DNS address family to connect to. IP-literal URLs keep their explicit address.',
    group: 'Connection',
    options: [
      ['auto', 'Automatic (IPv4 / IPv6)'],
      ['ipv4', 'IPv4 only'],
      ['ipv6', 'IPv6 only'],
    ],
  },
  {
    key: 'autoSelectFamily',
    label: 'Dual-stack connection attempts',
    help: 'Try alternate IPv4/IPv6 addresses when a connection stalls. Applies to Automatic address family.',
    group: 'Connection',
  },
  {
    key: 'autoSelectFamilyAttemptTimeoutMs',
    label: 'Alternate address delay (ms)',
    help: 'Wait before trying the next address when dual-stack connection attempts are enabled.',
    group: 'Connection',
    min: 10,
    max: 10000,
  },
  {
    key: 'maxConnections',
    label: 'Maximum connections per origin',
    help: 'Connection pool limit for requests sharing these settings. Zero leaves the pool unlimited. With reuse disabled, each request uses its own connection.',
    group: 'Connection',
    min: 0,
    max: 256,
  },
  {
    key: 'pipelining',
    label: 'HTTP/1.1 pipelining depth',
    help: 'Maximum eligible requests in flight per HTTP/1.1 connection. One disables pipelining. Increase only for compatible servers; HTTP/2 uses streams instead.',
    group: 'Connection',
    min: 1,
    max: 32,
  },
  {
    key: 'maxRequestsPerConnection',
    label: 'HTTP/1.1 connection request threshold',
    help: 'Close an HTTP/1.1 connection once it has served this many requests. Zero disables request-count rotation.',
    group: 'Connection',
    min: 0,
    max: 100000,
  },
  {
    key: 'maxConcurrentStreams',
    label: 'Initial HTTP/2 stream limit',
    help: 'Assumed peer stream limit before the server sends its HTTP/2 settings. The server’s advertised limit replaces this value.',
    group: 'Connection',
    min: 1,
    max: 1000,
  },
  {
    key: 'verifyTLS',
    label: 'Verify SSL/TLS certificates',
    help: 'Validate the server certificate chain and hostname.',
    group: 'TLS',
  },
  {
    key: 'tlsMinVersion',
    label: 'Minimum TLS version',
    help: 'Lowest TLS protocol accepted for HTTPS.',
    group: 'TLS',
    options: tlsVersions,
  },
  {
    key: 'tlsMaxVersion',
    label: 'Maximum TLS version',
    help: 'Highest TLS protocol accepted for HTTPS.',
    group: 'TLS',
    options: tlsVersions,
  },
  {
    key: 'caCertificates',
    label: 'Custom CA certificates (PEM)',
    help: 'Optional public CA bundle. Replaces the default trust roots for this scope.',
    group: 'TLS',
  },
  {
    key: 'tlsCiphers',
    label: 'TLS cipher suites',
    help: 'OpenSSL cipher names separated by colons. Blank uses runtime defaults. Legacy TLS also depends on runtime security policy.',
    group: 'TLS',
  },
];
export function overrides(input: unknown): Partial<HTTPSettings> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('HTTP settings must be an object.');
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field.key)) continue;
    const value = (input as Record<string, unknown>)[field.key];
    if (field.min !== undefined) {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < field.min ||
        value > field.max!
      )
        throw new Error(`${field.label} must be an integer between ${field.min} and ${field.max}.`);
    } else if (field.options) {
      if (typeof value !== 'string' || !field.options.some(([id]) => id === value))
        throw new Error(`Choose a valid ${field.label}.`);
    } else if (typeof defaults[field.key] === 'boolean') {
      if (typeof value !== 'boolean')
        throw new Error(`${field.label} must be enabled or disabled.`);
    } else if (
      typeof value !== 'string' ||
      value.length > (field.key === 'caCertificates' ? 131072 : 4096) ||
      (field.key !== 'caCertificates' &&
        [...value].some((character) => character.charCodeAt(0) < 32))
    )
      throw new Error(`Enter a valid ${field.label}.`);
    if (field.key === 'proxyUrl' && value) validateProxyURL(value as string);
    if (field.key === 'integrityHeaderName') {
      const problem = integrityHeaderNameProblem(value as string);
      if (problem) throw new Error(problem);
    }
    result[field.key] = value;
  }
  return result as Partial<HTTPSettings>;
}
export function inherit(...layers: unknown[]): HTTPSettings {
  return Object.assign({}, defaults, ...layers.map(overrides));
}
export function resolve(...layers: unknown[]): HTTPSettings {
  const result = inherit(...layers);
  if (
    tlsVersions.findIndex(([value]) => value === result.tlsMinVersion) >
    tlsVersions.findIndex(([value]) => value === result.tlsMaxVersion)
  )
    throw new Error('Minimum TLS version must not exceed maximum TLS version.');
  validateProxy(result);
  return result;
}
export function workspaceDefaults(settings: {
  timeoutMs?: number;
  followRedirects?: boolean;
  httpSettings?: Partial<HTTPSettings>;
}): HTTPSettings {
  return resolve(settings.httpSettings, {
    timeoutMs: settings.timeoutMs ?? defaults.timeoutMs,
    followRedirects: settings.followRedirects ?? defaults.followRedirects,
  });
}
export function payloadSettings(payload: {
  timeoutMs?: number;
  followRedirects?: boolean;
  httpSettings?: Partial<HTTPSettings>;
}): HTTPSettings {
  return resolve(payload.httpSettings, {
    ...(payload.timeoutMs !== undefined ? { timeoutMs: payload.timeoutMs } : {}),
    ...(payload.followRedirects !== undefined ? { followRedirects: payload.followRedirects } : {}),
  });
}
export function collectionOverrides(input: unknown): Record<string, Partial<HTTPSettings>> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid collection HTTP settings.');
  return Object.fromEntries(
    Object.entries(input).map(([folder, settings]) => [folder, overrides(settings)]),
  );
}
