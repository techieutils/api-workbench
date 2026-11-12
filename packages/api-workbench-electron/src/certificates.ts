import { X509Certificate } from 'node:crypto';
import type { TLSSocket, DetailedPeerCertificate } from 'node:tls';
import type {
  TLSConnectionInfo,
  TLSCertificateInfo,
} from '@techieutils/api-workbench-common/types';
/** Capture only public peer certificates from the request's actual TLS socket. */
export function captureTLSCertificate(
  socket: TLSSocket,
  host: string,
  port: number,
  resumedChain?: TLSCertificateInfo[],
): TLSConnectionInfo | undefined {
  try {
    const chain: TLSCertificateInfo[] = [],
      seen = new Set<string>();
    let peer: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
    while (peer?.raw && chain.length < 10) {
      const certificate = new X509Certificate(peer.raw);
      if (seen.has(certificate.fingerprint256)) break;
      seen.add(certificate.fingerprint256);
      const key = certificate.publicKey;
      chain.push({
        subject: certificate.subject,
        issuer: certificate.issuer,
        validFrom: new Date(certificate.validFrom).toISOString(),
        validTo: new Date(certificate.validTo).toISOString(),
        serialNumber: certificate.serialNumber,
        subjectAltName: certificate.subjectAltName || '',
        fingerprint: certificate.fingerprint,
        fingerprint256: certificate.fingerprint256,
        fingerprint512: certificate.fingerprint512,
        publicKeyType: key.asymmetricKeyType || 'Unknown',
        keyBits: key.asymmetricKeyDetails?.modulusLength || peer.bits,
        ca: certificate.ca,
        pem: certificate.toString(),
      });
      peer = peer.issuerCertificate;
    }
    if (!chain.length && resumedChain) chain.push(...resumedChain);
    if (!chain.length) return undefined;
    const cipher = socket.getCipher();
    return {
      sessionResumed: socket.isSessionReused(),
      host,
      port,
      capturedAt: new Date().toISOString(),
      authorized: socket.authorized,
      authorizationError: socket.authorized
        ? undefined
        : String(
            socket.authorizationError?.message ||
              socket.authorizationError ||
              'Certificate was not verified.',
          ),
      protocol: socket.getProtocol() || 'Unknown',
      cipher: { name: cipher.name, standardName: cipher.standardName, version: cipher.version },
      alpnProtocol: socket.alpnProtocol || undefined,
      chain,
    };
  } catch {
    return undefined;
  }
}
