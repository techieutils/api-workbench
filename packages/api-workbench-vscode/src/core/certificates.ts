import { expiry } from './network';
import type { CertificateList } from './workbench';

/**
 * The Certificates page, as the app's Settings → Certificates: the workspace's client
 * certificates for mutual TLS — the host each is presented to, PEM or PFX, until when it is
 * valid, and a switch for each — and the CA certificates its requests trust besides the system's.
 * Certificates are added from files chosen in VS Code's own dialog, with a passphrase typed in a
 * hidden box; the page itself holds no key, passphrase, or path to one.
 */
export interface CertificatesView {
  view: 'certificates';
  workspace: string;
  /** A team folder the app does not have open keeps no vault, so certificates cannot be added. */
  canAdd: boolean;
  certificates: {
    id: string;
    /** `api.example.com`, or `api.example.com:8443`. */
    host: string;
    subject: string;
    issuer: string;
    type: 'PEM' | 'PFX';
    enabled: boolean;
    expiry: string;
    expiryTone: 'good' | 'warn' | 'bad';
    /** Saved by file path before certificates moved to the vault: the app moves it there. */
    legacy: boolean;
  }[];
  authorities: {
    name: string;
    issuer: string;
    validTo: string;
    expiry: string;
    expiryTone: 'good' | 'warn' | 'bad';
  }[];
  busy?: boolean;
  error?: string;
}

const commonName = (name: string) => /(?:^|,\s*)CN=([^,]+)/.exec(name)?.[1]?.trim() || name;

export function certificatesView(
  list: CertificateList,
  meta: { workspace: string; canAdd: boolean; busy?: boolean; error?: string },
  now = Date.now(),
): CertificatesView {
  return {
    view: 'certificates',
    workspace: meta.workspace,
    canAdd: meta.canAdd,
    certificates: list.certificates.map((entry) => {
      const left = entry.validTo
        ? expiry(entry.validTo, now)
        : { label: 'Expiry unknown', tone: 'warn' as const };
      return {
        id: entry.id,
        host: `${entry.host}${entry.port ? `:${entry.port}` : ''}`,
        subject: entry.subject ? commonName(entry.subject) : 'Subject not read',
        issuer: entry.issuer ? commonName(entry.issuer) : '',
        type: entry.type === 'pfx' ? 'PFX' : 'PEM',
        enabled: entry.enabled,
        expiry: left.label,
        expiryTone: left.tone,
        legacy: !entry.inVault,
      };
    }),
    authorities: list.authorities.map((authority) => {
      const left = expiry(authority.validTo, now);
      return {
        name: commonName(authority.subject),
        issuer: commonName(authority.issuer),
        validTo: authority.validTo.slice(0, 10),
        expiry: left.label,
        expiryTone: left.tone,
      };
    }),
    ...(meta.busy ? { busy: true } : {}),
    ...(meta.error ? { error: meta.error } : {}),
  };
}

/** A host a certificate can be presented to: a name, `*.example.com`, or an address; or why not. */
export function hostProblem(value: string): string | undefined {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '');
  if (!host) return 'Give the host, such as api.example.com or *.example.com.';
  if (!/^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/.test(host) && !/^\[?[0-9a-f:.]+\]?$/.test(host))
    return `“${value}” is not a host name.`;
  return undefined;
}

/** A port typed for a certificate: empty for any port. */
export function portProblem(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : 'A port is a whole number from 1 to 65535, or empty for any.';
}
