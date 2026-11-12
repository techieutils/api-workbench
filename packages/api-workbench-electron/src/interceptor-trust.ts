import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Trusting the Interceptor's certificate authority on this computer, and taking that trust back.
 * A CA the app made trusted is remembered by its fingerprint, so replacing it also removes it from
 * the trusted certificates: a replaced CA whose key had been copied could otherwise still be used to
 * read this computer's HTTPS traffic. The commands are fixed programs with fixed arguments; the
 * operating system asks the person to confirm each change to its trust store.
 */
export interface TrustCommand {
  command: string;
  args: string[];
}

/** The certificate's SHA-1 thumbprint, as `security -Z` and `certutil` name certificates. */
export const thumbprint = (pem: string): string =>
  new X509Certificate(pem).fingerprint.replaceAll(':', '');
/** The fingerprint the app remembers a trusted CA by. */
export const fingerprint256 = (pem: string): string =>
  new X509Certificate(pem).fingerprint256.replaceAll(':', '');

/** Adds the CA to the current user's trusted roots; undefined where there is no single store. */
export function trustCommands(
  platform: NodeJS.Platform,
  certificatePath: string,
  keychain: string,
): TrustCommand[] | undefined {
  if (platform === 'darwin')
    return [
      {
        command: 'security',
        args: ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certificatePath],
      },
    ];
  if (platform === 'win32')
    return [{ command: 'certutil', args: ['-user', '-addstore', 'Root', certificatePath] }];
  return undefined;
}

/**
 * Removes a CA the app trusted. On macOS trust is kept apart from the certificate, by its hash, so
 * the trust setting goes first, then the certificate itself.
 */
export function untrustCommands(
  platform: NodeJS.Platform,
  certificatePath: string,
  pem: string,
  keychain: string,
): TrustCommand[] | undefined {
  const sha1 = thumbprint(pem);
  if (platform === 'darwin')
    return [
      { command: 'security', args: ['remove-trusted-cert', certificatePath] },
      { command: 'security', args: ['delete-certificate', '-Z', sha1, keychain] },
    ];
  if (platform === 'win32')
    return [{ command: 'certutil', args: ['-user', '-delstore', 'Root', sha1] }];
  return undefined;
}

/** The CAs this app made trusted, by SHA-256 fingerprint, kept in the app's data folder. */
export class TrustedAuthorities {
  constructor(private readonly file: string) {}

  private async list(): Promise<string[]> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as { trusted?: unknown };
      return Array.isArray(data.trusted)
        ? data.trusted.filter((item): item is string => /^[0-9A-F]{64}$/.test(String(item)))
        : [];
    } catch {
      return [];
    }
  }
  private async write(list: string[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, trusted: list }), {
      mode: 0o600,
    });
    await rename(`${this.file}.tmp`, this.file);
  }
  async has(pem: string): Promise<boolean> {
    return (await this.list()).includes(fingerprint256(pem));
  }
  async add(pem: string): Promise<void> {
    const list = await this.list();
    const print = fingerprint256(pem);
    if (!list.includes(print)) await this.write([...list, print]);
  }
  async remove(pem: string): Promise<void> {
    const list = await this.list();
    const print = fingerprint256(pem);
    if (list.includes(print)) await this.write(list.filter((item) => item !== print));
  }
}
