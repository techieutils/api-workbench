import {
  checkedCertificatePayload,
  hostMatches,
  type FileCertificatePayload,
} from '@techieutils/api-workbench-common/client-certificates';
import type { CredentialInput, CredentialRecord } from '@techieutils/api-workbench-common/types';
import {
  loadCertificateMaterial,
  readCertificateFile,
  type LoadedClientCertificate,
} from './client-certificates';
import { certificateOrigin } from './credentials';

/** Client certificates kept in the credential vault: preparing them to save, and loading them to send. */

/** A vault client certificate's material, as the TLS stack takes it. */
export function vaultMaterial(record: CredentialRecord): {
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
} {
  return record.clientCertificate?.type === 'pfx'
    ? { pfx: Buffer.from(record.secret || '', 'base64') }
    : {
        cert: Buffer.from(record.clientCertificate?.certPem || ''),
        key: Buffer.from(record.secret || ''),
      };
}

/**
 * Prepares a client certificate credential for the vault: files chosen in the dialog are read
 * once and validated with the passphrase; editing without new files keeps the stored material.
 * Other kinds pass through without certificate fields.
 */
export async function prepareCertificateCredential(
  input: CredentialInput,
  previous?: CredentialRecord,
): Promise<CredentialInput> {
  if (input?.kind !== 'client-certificate')
    return { ...input, certificateFiles: undefined, clientCertificate: undefined };
  const profile = input.clientCertificate;
  if (!profile || !['pem', 'pfx'].includes(profile.type))
    throw new Error('Choose a PEM certificate and key, or a PFX/P12 bundle.');
  const files = input.certificateFiles;
  let material: { cert?: Buffer; key?: Buffer; pfx?: Buffer };
  if (files?.certPath || files?.keyPath || files?.pfxPath) {
    const checked = checkedCertificatePayload({
      type: profile.type,
      ...files,
    }) as FileCertificatePayload;
    material =
      checked.type === 'pfx'
        ? { pfx: await readCertificateFile(checked.pfxPath!, 'PFX/P12') }
        : {
            cert: await readCertificateFile(checked.certPath!, 'certificate'),
            key: await readCertificateFile(checked.keyPath!, 'private key'),
          };
  } else if (
    previous?.kind === 'client-certificate' &&
    previous.clientCertificate?.type === profile.type &&
    previous.secret
  ) {
    material = vaultMaterial(previous);
  } else
    throw new Error(
      profile.type === 'pfx'
        ? 'Choose a PFX/P12 bundle.'
        : 'Choose a certificate and its private key.',
    );
  const passphrase =
    input.extraSecret ||
    (previous?.kind === 'client-certificate' ? previous.extraSecret : undefined);
  // Validates the pair (or bundle) and passphrase before anything is stored.
  const loaded = loadCertificateMaterial(material, passphrase);
  return {
    ...input,
    certificateFiles: undefined,
    secret: material.pfx ? material.pfx.toString('base64') : material.key!.toString('utf8'),
    extraSecret: passphrase,
    clientCertificate: {
      type: profile.type,
      host: profile.host,
      ...(profile.port ? { port: profile.port } : {}),
      certPem: material.cert?.toString('utf8'),
      subject: loaded.subject,
      issuer: loaded.issuer,
      validTo: loaded.validTo,
    } as CredentialInput['clientCertificate'],
  };
}

/** Loads a vault client certificate for a request, after checking it is allowed for its host. */
export function vaultCertificate(record: CredentialRecord, url: string): LoadedClientCertificate {
  const profile = record.clientCertificate;
  if (record.kind !== 'client-certificate' || !profile)
    throw new Error('The client certificate is no longer in the vault. Check Credentials.');
  const target = new URL(url);
  if (
    !hostMatches(profile.host, target.hostname) ||
    (profile.port !== undefined && profile.port !== Number(target.port || 443))
  )
    throw new Error(
      `Client certificate "${record.name}" is restricted to ${certificateOrigin(profile)}.`,
    );
  return loadCertificateMaterial(vaultMaterial(record), record.extraSecret);
}
