/** Where a client certificate is presented, and what it identifies; nothing secret. */
export interface CertificateProfile {
  type: 'pem' | 'pfx';
  /** Host name or `*.example.com` wildcard. */
  host: string;
  /** Matches any port when omitted. */
  port?: number;
  subject?: string;
  issuer?: string;
  validTo?: string;
}
/** A client certificate as the vault stores it; the key or PFX bundle is the record's secret. */
export interface VaultCertificate extends CertificateProfile {
  /** The public certificate, for PEM pairs. */
  certPem?: string;
}
/**
 * A client certificate for mutual TLS, as the workspace lists it for host matching. Entries saved
 * in the credential vault carry only `credentialId`; older entries reference files by path.
 */
export interface ClientCertificate {
  id: string;
  /** The vault credential holding the certificate and key. */
  credentialId?: string;
  /** Host name or `*.example.com` wildcard. */
  host: string;
  /** Matches any port when omitted. */
  port?: number;
  enabled: boolean;
  type: 'pem' | 'pfx';
  certPath?: string;
  keyPath?: string;
  pfxPath?: string;
  /** `enc:` prefixed ciphertext when OS encryption is available, otherwise plain text. */
  passphrase?: string;
  /** Details read from the certificate when it was added. */
  subject?: string;
  issuer?: string;
  validTo?: string;
}
/** The subset sent to the main process for one request: a vault reference, or file paths. */
export type FileCertificatePayload = Pick<
  ClientCertificate,
  'type' | 'certPath' | 'keyPath' | 'pfxPath' | 'passphrase'
>;
export type ClientCertificatePayload = FileCertificatePayload | { credentialId: string };

export function normalizeHostPattern(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '');
}
export function validHostPattern(pattern: string): boolean {
  return /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/.test(pattern) || /^\[?[0-9a-f:.]+\]?$/.test(pattern);
}
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const normalized = pattern.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized.startsWith('*.')
    ? host.endsWith(normalized.slice(1)) && host.length > normalized.length - 1
    : host === normalized;
}
/**
 * Picks the most specific enabled certificate for an HTTPS URL:
 * exact hosts beat wildcards, and port-specific entries beat any-port entries.
 */
export function matchClientCertificate(
  certificates: ClientCertificate[] | undefined,
  url: string,
): ClientCertificate | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (!['https:', 'wss:'].includes(target.protocol)) return undefined;
  const port = Number(target.port || 443);
  const score = (certificate: ClientCertificate) =>
    (certificate.host.startsWith('*.') ? 0 : 2) + (certificate.port === undefined ? 0 : 1);
  return (certificates || [])
    .filter(
      (certificate) =>
        certificate.enabled &&
        hostMatches(certificate.host, target.hostname) &&
        (certificate.port === undefined || certificate.port === port),
    )
    .sort((a, b) => score(b) - score(a))[0];
}
export function certificatePayload(certificate: ClientCertificate): ClientCertificatePayload {
  if (certificate.credentialId) return { credentialId: certificate.credentialId };
  return certificate.type === 'pfx'
    ? { type: 'pfx', pfxPath: certificate.pfxPath, passphrase: certificate.passphrase }
    : {
        type: 'pem',
        certPath: certificate.certPath,
        keyPath: certificate.keyPath,
        passphrase: certificate.passphrase,
      };
}
/** Validates certificate payloads received over IPC before any file is read. */
export function checkedCertificatePayload(value: unknown): ClientCertificatePayload | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object')
    throw new Error('Invalid client certificate configuration.');
  const payload = value as Record<string, unknown>;
  if (payload.credentialId !== undefined) {
    if (typeof payload.credentialId !== 'string' || !/^[\w-]{1,128}$/.test(payload.credentialId))
      throw new Error('Invalid client certificate credential.');
    return { credentialId: payload.credentialId };
  }
  const path = (key: string, required: boolean) => {
    const item = payload[key];
    if (item === undefined && !required) return;
    if (typeof item !== 'string' || !item.trim() || item.length > 4096 || item.includes('\0'))
      throw new Error('Choose the client certificate files again.');
  };
  if (
    payload.passphrase !== undefined &&
    (typeof payload.passphrase !== 'string' || payload.passphrase.length > 8192)
  )
    throw new Error('Invalid client certificate passphrase.');
  if (payload.type === 'pfx') path('pfxPath', true);
  else if (payload.type === 'pem') {
    path('certPath', true);
    path('keyPath', true);
  } else throw new Error('Invalid client certificate type.');
  return payload as ClientCertificatePayload;
}
/** Keeps well-formed entries from a saved or imported workspace. */
export function sanitizeClientCertificates(value: unknown): ClientCertificate[] {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown) =>
    typeof item === 'string' && item.length <= 4096 ? item : undefined;
  return value.flatMap((raw): ClientCertificate[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const host = normalizeHostPattern(String(item.host || ''));
    if (!validHostPattern(host) || !['pem', 'pfx'].includes(item.type as string)) return [];
    const port = Number(item.port);
    return [
      {
        id: text(item.id) || `${host}-${Math.random().toString(36).slice(2)}`,
        host,
        ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
        ...(text(item.credentialId) ? { credentialId: text(item.credentialId) } : {}),
        enabled: item.enabled !== false,
        type: item.type as 'pem' | 'pfx',
        certPath: text(item.certPath),
        keyPath: text(item.keyPath),
        pfxPath: text(item.pfxPath),
        passphrase: text(item.passphrase),
        subject: text(item.subject),
        issuer: text(item.issuer),
        validTo: text(item.validTo),
      },
    ];
  });
}
