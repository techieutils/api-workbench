import type { NetworkTiming, TLSConnectionInfo } from '@techieutils/api-workbench-common/types';

/**
 * A response's Timing and Certificate tabs, as the app's: where the time went — DNS, connecting,
 * TLS, waiting for the first byte, downloading — for each hop of the exchange (redirects included),
 * on one axis; and the server's TLS connection with its certificate chain. Both come from
 * `request send --json`, which has only public details: no key or passphrase is in them.
 */

export interface TimingPhaseView {
  id: string;
  label: string;
  /** Where it starts and how wide it is, in percent of the whole exchange. */
  left: number;
  width: number;
  duration: string;
}

export interface TimingView {
  total: string;
  /** The axis: 0, half, and the whole. */
  axis: [string, string, string];
  preparation?: string;
  hops: {
    title: string;
    status: string;
    total: string;
    /** Why phases are missing: a reused connection, or plain HTTP. */
    note?: string;
    phases: TimingPhaseView[];
  }[];
}

/** One certificate of the chain, the server's first. */
export interface CertificateEntryView {
  name: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** `Valid for 89 days`, `Expires in 12 days`, or `Expired`. */
  expiry: string;
  expiryTone: 'good' | 'warn' | 'bad';
  serialNumber: string;
  subjectAltName: string;
  fingerprint256: string;
  key: string;
  ca: boolean;
}

export interface CertificateView {
  host: string;
  /** Whether the chain was verified, and why not. */
  verified: boolean;
  verifyError?: string;
  protocol: string;
  cipher: string;
  alpn?: string;
  resumed: boolean;
  /** The client certificate presented for mutual TLS. */
  client?: { subject: string; issuer?: string; validTo?: string };
  chain: CertificateEntryView[];
}

const ms = (value: number) =>
  value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${value < 10 ? value.toFixed(2) : Math.round(value)} ms`;

export function timingView(timing: NetworkTiming | undefined): TimingView | undefined {
  if (!timing?.requests?.length) return undefined;
  const whole = Math.max(timing.totalMs, 1);
  const percent = (value: number) => Math.min(100, Math.max(0, (value / whole) * 100));
  return {
    total: ms(timing.totalMs),
    axis: ['0 ms', ms(timing.totalMs / 2), ms(timing.totalMs)],
    ...(timing.preparationMs > 0 ? { preparation: ms(timing.preparationMs) } : {}),
    hops: timing.requests.map((hop, index) => ({
      title: `${timing.requests.length > 1 ? `#${index + 1} · ` : ''}${hop.method} ${hop.url}`,
      status: hop.status ? String(hop.status) : 'Incomplete',
      total: ms(hop.durationMs),
      ...(hop.connectionReused
        ? { note: 'Reused connection: DNS, TCP, and TLS setup were skipped.' }
        : !hop.url.startsWith('https:')
          ? { note: 'TLS is not used for HTTP.' }
          : {}),
      phases: hop.phases.map((phase) => ({
        id: phase.id,
        label: phase.label,
        left: percent(phase.startMs),
        // Wide enough to see, even for a phase of a fraction of a millisecond.
        width: Math.max(0.5, percent(phase.durationMs)),
        duration: ms(phase.durationMs),
      })),
    })),
  };
}

/** The `CN=` of a distinguished name, or the whole name. */
const commonName = (name: string) => /(?:^|,\s*|\n)CN=([^,\n]+)/.exec(name)?.[1]?.trim() || name;

/** When a certificate stops being valid, and how near that is. */
export function expiry(
  validTo: string,
  now = Date.now(),
): { label: string; tone: CertificateEntryView['expiryTone'] } {
  const end = new Date(validTo).getTime();
  if (!Number.isFinite(end)) return { label: 'Expiry unknown', tone: 'warn' };
  const days = Math.floor((end - now) / 86400000);
  if (end < now) return { label: 'Expired', tone: 'bad' };
  if (days < 30) return { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warn' };
  return { label: `Valid for ${days} days`, tone: 'good' };
}

const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value;
};

export function certificateView(
  tls: TLSConnectionInfo | undefined,
  now = Date.now(),
): CertificateView | undefined {
  if (!tls) return undefined;
  return {
    host: `${tls.host}:${tls.port}`,
    verified: tls.authorized,
    ...(tls.authorizationError ? { verifyError: tls.authorizationError } : {}),
    protocol: tls.protocol,
    cipher: tls.cipher?.standardName || tls.cipher?.name || '',
    ...(tls.alpnProtocol ? { alpn: tls.alpnProtocol } : {}),
    resumed: Boolean(tls.sessionResumed),
    ...(tls.clientCertificate ? { client: tls.clientCertificate } : {}),
    chain: (tls.chain ?? []).map((certificate) => {
      const left = expiry(certificate.validTo, now);
      return {
        name: commonName(certificate.subject),
        subject: certificate.subject,
        issuer: certificate.issuer,
        validFrom: date(certificate.validFrom),
        validTo: date(certificate.validTo),
        expiry: left.label,
        expiryTone: left.tone,
        serialNumber: certificate.serialNumber,
        subjectAltName: certificate.subjectAltName,
        fingerprint256: certificate.fingerprint256,
        key: [
          certificate.publicKeyType?.toUpperCase(),
          certificate.keyBits ? `${certificate.keyBits} bits` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        ca: certificate.ca,
      };
    }),
  };
}
