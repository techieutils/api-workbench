import { randomUUID, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  normalizeHostPattern,
  validHostPattern,
  type ClientCertificate,
} from '@techieutils/api-workbench-common/client-certificates';
import type { CredentialInput } from '@techieutils/api-workbench-common/types';
import { certificateOrigin } from '@techieutils/api-workbench-electron/credentials';
import { prepareCertificateCredential } from '@techieutils/api-workbench-electron/vault-certificates';
import { UsageError, suggest } from './args';
import {
  confirm,
  json,
  one,
  positionals,
  printable,
  table,
  type CommandContext,
  type Parsed,
} from './command-kit';
import type { Target } from './target';
import { openVault, terminalPassword } from './vault';

/**
 * Client certificates for mutual TLS and the CA certificates a workspace trusts, as the app's
 * Settings → Certificates keeps them. A client certificate's key goes into the credential vault,
 * read from files once, with its passphrase from an environment variable — never an argument; the
 * workspace lists which hosts it is presented to, and whether it is on. Nothing printed is secret.
 */

/** A certificate's public details: who it names, who signed it, and until when. */
export interface CertificateRow {
  id: string;
  host: string;
  port?: number;
  type: 'pem' | 'pfx';
  enabled: boolean;
  subject?: string;
  issuer?: string;
  validTo?: string;
  /** Kept in the vault, or still read from files saved before certificates moved there. */
  inVault: boolean;
}

/** A trusted CA certificate's public details. */
export interface AuthorityRow {
  subject: string;
  issuer: string;
  validTo: string;
  fingerprint256: string;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The CA certificates in PEM text, each read; text that is no certificate is refused. */
export function authorities(pem: string): AuthorityRow[] {
  return (pem.match(PEM_BLOCK) ?? []).map((block) => {
    const certificate = new X509Certificate(block);
    return {
      subject: certificate.subject.replace(/\n/g, ', '),
      issuer: certificate.issuer.replace(/\n/g, ', '),
      validTo: new Date(certificate.validTo).toISOString(),
      fingerprint256: certificate.fingerprint256,
    };
  });
}

const rowOf = (entry: ClientCertificate): CertificateRow => ({
  id: entry.id,
  host: entry.host,
  ...(entry.port ? { port: entry.port } : {}),
  type: entry.type,
  enabled: entry.enabled,
  ...(entry.subject ? { subject: entry.subject } : {}),
  ...(entry.issuer ? { issuer: entry.issuer } : {}),
  ...(entry.validTo ? { validTo: entry.validTo } : {}),
  inVault: Boolean(entry.credentialId),
});

const where = (entry: Pick<ClientCertificate, 'host' | 'port'>) =>
  `${entry.host}${entry.port ? `:${entry.port}` : ''}`;

/** A certificate by id, or by its host (with `:port` when it has one). */
function findCertificate(list: ClientCertificate[], wanted: string): ClientCertificate {
  const found =
    list.find((entry) => entry.id === wanted) ??
    list.filter((entry) => where(entry) === wanted.toLowerCase()).at(0);
  if (!found)
    throw new UsageError(
      `No client certificate “${wanted}”.${suggest(wanted, list.map(where))} Certificates: ${
        list.map(where).join(', ') || 'none'
      }.`,
    );
  return found;
}

export async function certificateCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const { state } = target;
  const list = state.clientCertificates ?? [];
  const caText = state.settings?.httpSettings?.caCertificates ?? '';
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const rows = list.map(rowOf);
      let trusted: AuthorityRow[] = [];
      try {
        trusted = authorities(caText);
      } catch {
        // Text the app accepted but that is no certificate is listed as nothing.
      }
      if (parsed.flags.has('--json')) json(output, { certificates: rows, authorities: trusted });
      else {
        if (rows.length)
          table(
            [
              ['HOST', 'TYPE', 'ON', 'VALID UNTIL', 'SUBJECT'],
              ...rows.map((row) => [
                where(row),
                row.type.toUpperCase(),
                row.enabled ? 'yes' : 'no',
                row.validTo?.slice(0, 10) ?? '',
                row.subject ?? '',
              ]),
            ],
            output.out,
          );
        else output.out('No client certificates.');
        output.out(
          trusted.length
            ? `Trusted CA certificates: ${trusted.map((row) => row.subject).join('; ')}`
            : 'No CA certificates of its own: the system’s are trusted.',
        );
      }
      return 0;
    }
    case 'add': {
      positionals(parsed, []);
      const host = normalizeHostPattern(one(parsed, '--host') ?? '');
      if (!host || !validHostPattern(host))
        throw new UsageError('Give --host, a host name such as api.example.com or *.example.com.');
      const portText = one(parsed, '--port');
      const port = portText === undefined ? undefined : Number(portText);
      if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535))
        throw new UsageError('--port must be a whole number from 1 to 65535.');
      const certPath = one(parsed, '--cert');
      const keyPath = one(parsed, '--key');
      const pfxPath = one(parsed, '--pfx');
      if (pfxPath ? certPath || keyPath : !(certPath && keyPath))
        throw new UsageError('Give --cert and --key (PEM files), or --pfx (a PFX/P12 bundle).');
      const fromEnv = one(parsed, '--passphrase-from-env');
      const passphrase = fromEnv ? context.env[fromEnv] : undefined;
      if (fromEnv && passphrase === undefined)
        throw new UsageError(`The environment variable ${fromEnv} is not set.`);
      if (list.some((entry) => entry.host === host && entry.port === port))
        throw new UsageError(
          `${where({ host, port })} already has a client certificate. Remove it first.`,
        );
      const profile = { type: pfxPath ? ('pfx' as const) : ('pem' as const), host, port };
      const { vault, close } = await openVault(
        target.vaultPath,
        target.vaultDir ?? target.dataDir,
        context.password ?? terminalPassword(context.env),
      );
      try {
        // Read and checked with the passphrase before anything is kept.
        const input = await prepareCertificateCredential({
          name: one(parsed, '--name')?.trim() || `Client certificate · ${where(profile)}`,
          kind: 'client-certificate',
          allowedOrigin: certificateOrigin(profile),
          clientCertificate: profile,
          certificateFiles: pfxPath ? { pfxPath } : { certPath, keyPath },
          ...(passphrase ? { extraSecret: passphrase } : {}),
        } as CredentialInput).catch((error: Error) => {
          throw new UsageError(error.message);
        });
        const saved = await vault.save(input).catch((error: Error) => {
          throw new UsageError(error.message);
        });
        const details = input.clientCertificate;
        const entry: ClientCertificate = {
          id: randomUUID(),
          credentialId: saved.id,
          host,
          ...(port ? { port } : {}),
          enabled: true,
          type: profile.type,
          ...(details?.subject ? { subject: details.subject } : {}),
          ...(details?.issuer ? { issuer: details.issuer } : {}),
          ...(details?.validTo ? { validTo: details.validTo } : {}),
        };
        state.clientCertificates = [...list, entry];
        await target.save();
        if (parsed.flags.has('--json')) json(output, rowOf(entry));
        else
          output.out(
            `Added a client certificate for ${where(entry)}${entry.subject ? ` (${printable(entry.subject)})` : ''}.`,
          );
      } finally {
        close();
      }
      return 0;
    }
    case 'enable':
    case 'disable': {
      const [wanted] = positionals(parsed, ['certificate']);
      const entry = findCertificate(list, wanted);
      entry.enabled = sub === 'enable';
      await target.save();
      output.out(
        `${entry.enabled ? 'Switched on' : 'Switched off'} the client certificate for ${where(entry)}.`,
      );
      return 0;
    }
    case 'remove': {
      const [wanted] = positionals(parsed, ['certificate']);
      const entry = findCertificate(list, wanted);
      confirm(parsed, `the client certificate for ${where(entry)}`);
      // Its key leaves the vault too; files it was read from are not touched.
      if (entry.credentialId) {
        const { vault, close } = await openVault(
          target.vaultPath,
          target.vaultDir ?? target.dataDir,
          context.password ?? terminalPassword(context.env),
        );
        try {
          const records = await vault.list();
          if (records.some((record) => record.id === entry.credentialId))
            await vault.delete(entry.credentialId);
        } finally {
          close();
        }
      }
      state.clientCertificates = list.filter((item) => item !== entry);
      await target.save();
      output.out(`Removed the client certificate for ${where(entry)}.`);
      return 0;
    }
    case 'trust': {
      const [file] = positionals(parsed, ['file']);
      const text = await fs.readFile(file, 'utf8').catch(() => {
        throw new UsageError(`Cannot read ${file}.`);
      });
      let added: AuthorityRow[];
      try {
        added = authorities(text);
      } catch {
        throw new UsageError(`${file} holds a certificate that cannot be read.`);
      }
      if (!added.length) throw new UsageError(`${file} holds no PEM certificate.`);
      const blocks = (text.match(PEM_BLOCK) ?? []).filter((block) => !caText.includes(block));
      if (!blocks.length) {
        output.out('These CA certificates are already trusted.');
        return 0;
      }
      const next = [caText.trim(), ...blocks].filter(Boolean).join('\n');
      // The app's limit for the setting.
      if (next.length > 131072) throw new UsageError('The trusted CA certificates exceed 128 KB.');
      state.settings = {
        ...state.settings,
        httpSettings: { ...state.settings?.httpSettings, caCertificates: next },
      } as typeof state.settings;
      await target.save();
      output.out(
        `Trusting ${blocks.length} more CA certificate${blocks.length === 1 ? '' : 's'}: ${added
          .map((row) => printable(row.subject))
          .join('; ')}.`,
      );
      return 0;
    }
    case 'untrust': {
      positionals(parsed, []);
      confirm(parsed, 'the trusted CA certificates');
      state.settings = {
        ...state.settings,
        httpSettings: { ...state.settings?.httpSettings, caCertificates: '' },
      } as typeof state.settings;
      await target.save();
      output.out('Requests now trust only the system’s CA certificates.');
      return 0;
    }
  }
  return 0;
}
