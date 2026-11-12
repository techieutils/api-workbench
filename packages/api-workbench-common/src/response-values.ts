/**
 * Values read from a response besides its body: the cookies it set, its network timing, and its
 * TLS certificate. Captures and test assertions both read them, so they live here, apart from both.
 */
import type { HttpResponse, RequestResponse } from './types';

/**
 * The name and value of each cookie the response set, in order (redirect hops included). Without
 * the separate Set-Cookie headers (an older saved response), the combined header is split where a
 * new `name=` begins, which keeps commas in Expires dates together.
 */
export function responseCookies(
  response: Pick<HttpResponse, 'headers' | 'setCookies'>,
): { name: string; value: string }[] {
  const headers =
    response.setCookies?.map((item) => item.header) ??
    Object.entries(response.headers)
      .filter(([key]) => key.toLowerCase() === 'set-cookie')
      .flatMap(([, value]) => value.split(/,(?=\s*[^;,=\s]+=)/));
  return headers.flatMap((header) => {
    const pair = header.split(';')[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    return separator > 0 && name ? [{ name, value: pair.slice(separator + 1).trim() }] : [];
  });
}
/** What a `certificate` capture reads from the TLS connection. */
export const CERTIFICATE_CONNECTION_FIELDS = [
  'host',
  'port',
  'protocol',
  'cipher',
  'alpn',
  'authorized',
] as const;
/** What a `certificate` capture reads from a certificate of the chain (the leaf by default). */
export const CERTIFICATE_FIELDS = [
  'subject',
  'cn',
  'issuer',
  'valid-from',
  'valid-to',
  'days-left',
  'serial',
  'sha256',
  'sha1',
  'san',
  'public-key',
  'pem',
] as const;
/**
 * A detail of the response's TLS connection, or of certificate `position` of its chain (1, the
 * leaf, by default). `days-left` counts whole days from now until the certificate expires.
 */
export function certificateCapture(
  response: Pick<RequestResponse, 'tls'>,
  field: string,
  position?: string,
  now = Date.now(),
): string {
  const tls = response.tls;
  if (!tls) throw new Error('The response has no TLS certificate (it was not HTTPS, or not kept).');
  switch (field) {
    case 'host':
      return tls.host;
    case 'port':
      return String(tls.port);
    case 'protocol':
      return tls.protocol;
    case 'cipher':
      return tls.cipher.standardName || tls.cipher.name;
    case 'alpn':
      return tls.alpnProtocol ?? '';
    case 'authorized':
      return String(tls.authorized);
  }
  if (!(CERTIFICATE_FIELDS as readonly string[]).includes(field))
    throw new Error(
      `Unknown certificate field "${field}". Use ${[...CERTIFICATE_CONNECTION_FIELDS, ...CERTIFICATE_FIELDS].join(', ')}.`,
    );
  const certificate = tls.chain[(position ? Number(position) : 1) - 1];
  if (!certificate)
    throw new Error(`The chain has ${tls.chain.length} certificate(s), not ${position}.`);
  switch (field) {
    case 'subject':
      return certificate.subject;
    case 'cn':
      return (
        certificate.subject
          .split('\n')
          .find((part) => part.startsWith('CN='))
          ?.slice(3) ?? ''
      );
    case 'issuer':
      return certificate.issuer;
    case 'valid-from':
      return certificate.validFrom;
    case 'valid-to':
      return certificate.validTo;
    case 'days-left':
      return String(Math.floor((Date.parse(certificate.validTo) - now) / 86_400_000));
    case 'serial':
      return certificate.serialNumber;
    case 'sha256':
      return certificate.fingerprint256;
    case 'sha1':
      return certificate.fingerprint;
    case 'san':
      return certificate.subjectAltName;
    case 'public-key':
      return `${certificate.publicKeyType.toUpperCase()}${certificate.keyBits ? ` ${certificate.keyBits}` : ''}`;
    default:
      return certificate.pem;
  }
}

/** Network phases a `timing` capture can read, with the names it also accepts for them. */
export const TIMING_PHASES = [
  'queueing',
  'dns',
  'tcp',
  'tls',
  'stalled',
  'sending',
  'waiting',
  'download',
] as const;
const TIMING_ALIASES: Record<string, string> = { ttfb: 'waiting', connect: 'tcp' };
/**
 * A network timing in milliseconds (two decimals): `total`, `preparation`, or a phase of one
 * request in the exchange, the last (the response's) unless `hop` numbers another, from 1.
 */
export function timingCapture(
  response: Pick<RequestResponse, 'timings'>,
  name: string,
  hop?: string,
): string {
  const timing = response.timings;
  if (!timing) throw new Error('Network timing was not recorded for this response.');
  const ms = (value: number) => String(Math.round(value * 100) / 100);
  if (name === 'total') return ms(timing.totalMs);
  if (name === 'preparation') return ms(timing.preparationMs);
  const id = TIMING_ALIASES[name] ?? name;
  if (!(TIMING_PHASES as readonly string[]).includes(id))
    throw new Error(
      `Unknown timing "${name}". Use total, preparation, ttfb, or ${TIMING_PHASES.join(', ')}.`,
    );
  const request = hop ? timing.requests[Number(hop) - 1] : timing.requests.at(-1);
  if (!request)
    throw new Error(`The exchange has ${timing.requests.length} request(s), not ${hop}.`);
  const phase = request.phases.find((item) => item.id === id);
  if (!phase)
    throw new Error(
      `${id} was not recorded for ${hop ? `request ${hop}` : 'the response'}${request.connectionReused ? ': it reused a connection, which skips DNS, TCP, and TLS' : ''}.`,
    );
  return ms(phase.durationMs);
}
