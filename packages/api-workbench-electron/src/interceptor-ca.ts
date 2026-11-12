import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The Interceptor's certificate authority: a local CA the user chooses to trust, and the
 * short-lived host certificates it issues so HTTPS traffic can be decrypted and inspected.
 * Certificates are encoded directly in DER (ECDSA P-256 with SHA-256), so no X.509 library is needed.
 */

export interface CertificateAuthority {
  /**
   * The domains it may vouch for (with their subdomains), besides this computer, written into
   * the certificate as name constraints; empty or absent, it can vouch for any site.
   */
  domains?: string[];
  certPem: string;
  keyPem: string;
}
export interface IssuedCertificate {
  cert: string;
  key: string;
}

// DER encoding: just the types an X.509 certificate needs.
function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (tag: number, content: Buffer) => tlv(0xa0 | tag, content);
const octets = (content: Buffer) => tlv(0x04, content);
const bits = (content: Buffer, unused = 0) =>
  tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, 'utf8'));
const boolean = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === 'number' ? Buffer.from([value]) : value;
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes = bytes.subarray(1);
  return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}
function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let rem = part >> 7; rem > 0; rem >>= 7) chunk.unshift((rem & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(iso.slice(2)))
    : tlv(0x18, Buffer.from(iso));
}

const OID = {
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extendedKeyUsage: '2.5.29.37',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};
export const CA_NAME = 'API Workbench Interceptor CA';
const ORGANIZATION = 'API Workbench';
const DAY = 86_400_000;

const name = (commonName: string) =>
  sequence(
    set(sequence(oid(OID.commonName), utf8(commonName))),
    set(sequence(oid(OID.organization), utf8(ORGANIZATION))),
  );
const extension = (id: string, value: Buffer, critical = false) =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octets(value));
/** The key identifier: a SHA-1 of the public key's bits (RFC 5280 method 1). */
function keyId(key: KeyObject): Buffer {
  const spki = key.export({ type: 'spki', format: 'der' });
  // The SubjectPublicKeyInfo ends with the public key BIT STRING; its last 65 bytes are an uncompressed P-256 point.
  return createHash('sha1')
    .update(spki.subarray(spki.length - 65))
    .digest();
}
/** A positive 128-bit serial number. */
function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes;
}
function subjectAltName(host: string): Buffer {
  if (isIP(host) === 4) return tlv(0x87, Buffer.from(host.split('.').map(Number)));
  if (isIP(host) === 6) {
    const groups = host.includes('::')
      ? (() => {
          const [head, tail] = host.split('::');
          const left = head ? head.split(':') : [];
          const right = tail ? tail.split(':') : [];
          return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
        })()
      : host.split(':');
    return tlv(
      0x87,
      Buffer.concat(groups.map((group) => Buffer.from(group.padStart(4, '0'), 'hex'))),
    );
  }
  return tlv(0x82, Buffer.from(host, 'ascii'));
}

function certificate(options: {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  issuerKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}): string {
  const algorithm = sequence(oid(OID.ecdsaWithSHA256));
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial()),
    algorithm,
    name(options.issuer),
    sequence(time(options.notBefore), time(options.notAfter)),
    name(options.subject),
    options.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      sequence(
        ...options.extensions,
        extension(OID.subjectKeyIdentifier, octets(keyId(options.publicKey))),
        extension(OID.authorityKeyIdentifier, sequence(tlv(0x80, keyId(options.issuerKey)))),
      ),
    ),
  );
  const der = sequence(tbs, algorithm, bits(sign('sha256', tbs, options.signingKey)));
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/**
 * How long a CA lasts. It can sign a certificate for any site, so a copied key would let someone
 * read this computer's HTTPS traffic for as long as it is valid: a month, renewed as it runs out
 * (`needsRenewal`), keeps that window short. Older versions made CAs for ten years.
 */
export const AUTHORITY_DAYS = 30;
/** A CA is replaced once it has fewer than this many days left. */
export const RENEW_WITHIN_DAYS = 2;

const validity = (certPem: string) => {
  const parsed = new X509Certificate(certPem);
  return { from: new Date(parsed.validFrom).getTime(), to: new Date(parsed.validTo).getTime() };
};
/** Whether a CA runs out within `RENEW_WITHIN_DAYS`, or already has. */
export const needsRenewal = (certPem: string, now = Date.now()): boolean =>
  validity(certPem).to - now < RENEW_WITHIN_DAYS * DAY;
/** Whether a CA was made to last far longer than `AUTHORITY_DAYS`, as older versions made them. */
export const isLongLived = (certPem: string): boolean => {
  const { from, to } = validity(certPem);
  return to - from > (AUTHORITY_DAYS + 2) * DAY;
};

/**
 * The domains a CA is limited to, as the person wrote them: lower case, without a leading `*.` or
 * dot, each once, in order. Throws, naming it, for one that is not a domain name.
 */
export function normalizeDomains(list: readonly string[]): string[] {
  const domains = list
    .map((item) =>
      item
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, ''),
    )
    .filter(Boolean);
  for (const domain of domains)
    if (
      domain.length > 253 ||
      !/^(?=.{1,63}(\.|$))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
        domain,
      ) ||
      isIP(domain)
    )
      throw new Error(`“${domain}” is not a domain name, such as example.com.`);
  return [...new Set(domains)].sort();
}
/** Whether two lists of domains are the same, as `normalizeDomains` writes them. */
export const sameDomains = (a: readonly string[] = [], b: readonly string[] = []): boolean =>
  a.length === b.length && a.every((domain, index) => domain === b[index]);
/** Whether a CA limited to `domains` vouches for `host`: one of them or a subdomain, or this computer. */
export function coversHost(domains: readonly string[] | undefined, host: string): boolean {
  if (!domains?.length) return true;
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (name === 'localhost' || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name)) return true;
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}
/**
 * X.509 name constraints (RFC 5280 4.2.1.10): DNS names only within `domains` and `localhost`.
 * Addresses are not constrained: BoringSSL, which Electron verifies with, refuses an address
 * certificate under any address constraint, and HTTPS mocks' certificates are for 127.0.0.1 and
 * ::1. So the limit covers names, which is how sites are reached; the Interceptor decrypts only
 * the domains and this computer (`coversHost`).
 */
function nameConstraints(domains: readonly string[]): Buffer {
  return sequence(
    tlv(
      0xa0,
      Buffer.concat(
        [...domains, 'localhost'].map((domain) =>
          sequence(tlv(0x82, Buffer.from(domain, 'ascii'))),
        ),
      ),
    ),
  );
}

/**
 * A new CA, valid for `days` (`AUTHORITY_DAYS`), that can only sign host certificates (path
 * length 0) — and, given `domains`, only for those domains and this computer.
 */
export function createAuthority(
  now = new Date(),
  days = AUTHORITY_DAYS,
  domains: readonly string[] = [],
): CertificateAuthority {
  const { publicKey, privateKey } = keyPair();
  const certPem = certificate({
    subject: CA_NAME,
    issuer: CA_NAME,
    publicKey,
    signingKey: privateKey,
    issuerKey: publicKey,
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + days * DAY),
    extensions: [
      extension(OID.basicConstraints, sequence(boolean(true), integer(0)), true),
      // keyCertSign and cRLSign.
      extension(OID.keyUsage, bits(Buffer.from([0x06]), 1), true),
      ...(domains.length ? [extension(OID.nameConstraints, nameConstraints(domains), true)] : []),
    ],
  });
  return {
    certPem,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ...(domains.length ? { domains: [...domains] } : {}),
  };
}

/**
 * A certificate for a host (or several, such as `localhost` and `127.0.0.1`), signed by the CA and
 * valid for under a year (browsers cap leaf validity), and never longer than the CA.
 */
export function issueCertificate(
  authority: CertificateAuthority,
  hosts: string | readonly string[],
  now = new Date(),
): IssuedCertificate {
  const names = typeof hosts === 'string' ? [hosts] : hosts;
  const host = names[0];
  const { publicKey, privateKey } = keyPair();
  const caKey = createPrivateKey(authority.keyPem);
  const cert = certificate({
    // Clients read the name from subjectAltName. A CN that looks like a host name is also checked
    // against a CA's name constraints, which hold no DNS name for an IP address, so an address
    // gets a CN that is not one.
    subject: isIP(host) ? 'API Workbench Interceptor host' : host.slice(0, 64),
    issuer: CA_NAME,
    publicKey,
    signingKey: caKey,
    issuerKey: createPublicKey(caKey),
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(Math.min(now.getTime() + 365 * DAY, validity(authority.certPem).to)),
    extensions: [
      extension(OID.basicConstraints, sequence(), true),
      // digitalSignature.
      extension(OID.keyUsage, bits(Buffer.from([0x80]), 7), true),
      extension(OID.extendedKeyUsage, sequence(oid(OID.serverAuth))),
      extension(OID.subjectAltName, sequence(...names.map(subjectAltName))),
    ],
  });
  return {
    cert: cert + authority.certPem,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** What the setup screen shows about the CA. */
export function describeAuthority(authority: CertificateAuthority): {
  subject: string;
  validTo: string;
  fingerprint: string;
} {
  const parsed = new X509Certificate(authority.certPem);
  return {
    subject: CA_NAME,
    validTo: new Date(parsed.validTo).toISOString(),
    fingerprint: parsed.fingerprint256,
  };
}
