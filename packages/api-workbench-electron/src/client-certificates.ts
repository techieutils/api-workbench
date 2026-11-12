import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { createSecureContext, type SecureContext } from 'node:tls';
import type { FileCertificatePayload } from '@techieutils/api-workbench-common/client-certificates';

export interface LoadedClientCertificate {
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
  /** Identifies the material for connection pooling without exposing it. */
  fingerprint: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
}
const MAX_FILE_BYTES = 1024 * 1024;
/** Certificate files are copied into the vault when saved; older workspace entries still read them per request. */
export async function readCertificateFile(file: string, label: string): Promise<Buffer> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_FILE_BYTES) throw new Error(`The ${label} file is larger than 1 MiB.`);
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && error.message.includes('1 MiB')) throw error;
    throw new Error(
      `Cannot read the ${label} file ${path.basename(file)}. Choose it again in Credentials.`,
      {
        cause: error,
      },
    );
  }
}
function certificateDetails(
  der: Buffer | string | undefined,
): Pick<LoadedClientCertificate, 'subject' | 'issuer' | 'validTo'> {
  if (!der) return {};
  try {
    const certificate = new X509Certificate(der);
    return {
      subject: certificate.subject.replace(/\n/g, ', '),
      issuer: certificate.issuer.replace(/\n/g, ', '),
      validTo: new Date(certificate.validTo).toISOString(),
    };
  } catch {
    return {};
  }
}
/** Reads and validates a client certificate from files. The passphrase must already be decrypted. */
export async function loadClientCertificate(
  payload: FileCertificatePayload,
): Promise<LoadedClientCertificate> {
  return loadCertificateMaterial(
    payload.type === 'pfx'
      ? { pfx: await readCertificateFile(payload.pfxPath!, 'PFX/P12') }
      : {
          cert: await readCertificateFile(payload.certPath!, 'certificate'),
          key: await readCertificateFile(payload.keyPath!, 'private key'),
        },
    payload.passphrase,
  );
}
/** Validates certificate material (a PEM pair or a PFX bundle) and reads its details. */
export function loadCertificateMaterial(
  material: { cert?: Buffer; key?: Buffer; pfx?: Buffer },
  passphrase?: string,
): LoadedClientCertificate {
  passphrase = passphrase || undefined;
  let context: SecureContext;
  try {
    context = createSecureContext({ ...material, passphrase });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new Error(
      /bad decrypt|mac verify|passphrase|password/i.test(message)
        ? 'The client certificate passphrase is incorrect.'
        : /key[ _]values[ _]mismatch/i.test(message)
          ? 'The private key does not match the client certificate.'
          : 'The client certificate or private key could not be loaded. Use PEM files or a PFX/P12 bundle.',
      { cause: error },
    );
  }
  // PFX bundles expose their leaf certificate through the secure context.
  const leaf = material.pfx
    ? ((context.context as { getCertificate?: () => Buffer | null }).getCertificate?.() ??
      undefined)
    : material.cert;
  const hash = createHash('sha256');
  for (const part of [material.cert, material.key, material.pfx, passphrase])
    hash.update(part ?? '').update('\0');
  return { ...material, passphrase, fingerprint: hash.digest('hex'), ...certificateDetails(leaf) };
}
