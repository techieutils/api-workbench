import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';

/**
 * Which store encrypts saved credentials: the system's (macOS Keychain, Windows DPAPI, the Linux
 * Secret Service) when it has one, or the API Workbench vault — always, when the person chose it,
 * so that the command line and the VS Code extension, which cannot open the system's store, can
 * read credentials with the vault's password. The choice is kept in a small file in the app's
 * data folder, and switching moves each workspace's credentials from one store to the other.
 */

export type VaultBackend = 'system' | 'workbench';

/** The choice saved in `file`: `workbench` when the API Workbench vault was chosen. */
export function readBackendChoice(file: string): VaultBackend {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { backend?: unknown };
    return saved.backend === 'workbench' ? 'workbench' : 'system';
  } catch {
    return 'system';
  }
}

export async function writeBackendChoice(file: string, backend: VaultBackend): Promise<void> {
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ backend })}\n`, { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Encrypts each file again with the other store: those `needs` picks are decrypted and encrypted
 * anew, and replaced at once (a temporary file, then a rename), so a file is never half written.
 * Files that are missing or already moved are left alone. Answers how many moved.
 */
export async function moveVaultFiles(
  files: readonly string[],
  store: {
    needs(data: Buffer): boolean;
    decrypt(data: Buffer): Promise<string>;
    encrypt(text: string): Promise<Buffer>;
  },
): Promise<number> {
  let moved = 0;
  for (const file of files) {
    const data = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!data || !store.needs(data)) continue;
    const text = await store.decrypt(data);
    const encrypted = await store.encrypt(text);
    await fs.writeFile(`${file}.tmp`, encrypted, { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    moved++;
  }
  return moved;
}
