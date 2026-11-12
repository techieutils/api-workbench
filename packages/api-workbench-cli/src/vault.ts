import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CredentialVault,
  type SecretStorage,
} from '@techieutils/api-workbench-electron/credentials';
import {
  WorkbenchVault,
  isWorkbenchVaultData,
} from '@techieutils/api-workbench-electron/workbench-vault';
import { UsageError } from './args';

/**
 * The app's credential vault, opened from the command line. Only the API Workbench vault — the
 * app's own encryption under a vault password — can be opened here: a vault the desktop app
 * encrypted with the system's credential store (the macOS Keychain, Windows DPAPI, or a Linux
 * keyring) can be read only by the app itself, so the command line says so instead.
 */

export const KEYCHAIN_VAULT =
  'This workspace’s credentials are encrypted with the system’s credential store, which only the desktop app can open. To use them here, choose Use the API Workbench vault in the app’s Credentials screen.';

/** The vault password: from API_WORKBENCH_VAULT_PASSWORD, or typed at a terminal without echo. */
export type PasswordSource = () => Promise<string>;

export function terminalPassword(
  env: Record<string, string | undefined>,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): PasswordSource {
  return async () => {
    if (env.API_WORKBENCH_VAULT_PASSWORD) return env.API_WORKBENCH_VAULT_PASSWORD;
    if (!input.isTTY || !input.setRawMode)
      throw new UsageError(
        'The vault is locked. Set API_WORKBENCH_VAULT_PASSWORD, or run in a terminal to type the password.',
      );
    output.write('Vault password: ');
    input.setRawMode(true);
    input.resume();
    try {
      return await new Promise<string>((resolve, reject) => {
        let typed = '';
        const onData = (chunk: Buffer) => {
          for (const character of chunk.toString('utf8')) {
            if (character === '\r' || character === '\n') {
              input.off('data', onData);
              output.write('\n');
              return resolve(typed);
            }
            if (character === '\u0003') {
              input.off('data', onData);
              output.write('\n');
              return reject(new UsageError('Cancelled.'));
            }
            if (character === '\u007f' || character === '\b') typed = typed.slice(0, -1);
            else typed += character;
          }
        };
        input.on('data', onData);
      });
    } finally {
      input.setRawMode(false);
      input.pause();
    }
  };
}

/**
 * A workspace's vault, opened only when a request needs one of its credentials, and closed (locked)
 * with `close` once the run is over. Team folders and collection files have none.
 */
export function vaultAccess(
  target: { vaultPath?: string; dataDir?: string; vaultDir?: string },
  password: PasswordSource,
): {
  credentials?: {
    get(id: string): Promise<import('@techieutils/api-workbench-common/types').CredentialRecord>;
  };
  close(): Promise<void>;
} {
  const { vaultPath } = target;
  // A team folder open in the app reads the app's vault; its own data folder is temporary.
  const dataDir = target.vaultDir ?? target.dataDir;
  if (!vaultPath || !dataDir) return { close: async () => undefined };
  let opened: ReturnType<typeof openVault> | undefined;
  return {
    credentials: {
      get: async (id) => (await (opened ??= openVault(vaultPath, dataDir, password))).vault.get(id),
    },
    close: async () => {
      await opened?.then(
        (vault) => vault.close(),
        () => undefined,
      );
    },
  };
}

export async function openVault(
  vaultPath: string | undefined,
  dataDir: string,
  password: PasswordSource,
): Promise<{ vault: CredentialVault; close(): void }> {
  if (!vaultPath)
    throw new UsageError(
      'This team folder keeps no credentials of its own: each teammate’s are in their own vault. Open the folder in the API Workbench app on this computer, so its saved credentials are used here, or use --workspace for one of the app’s workspaces.',
    );
  const existing = await fs.readFile(vaultPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && !isWorkbenchVaultData(existing)) throw new UsageError(KEYCHAIN_VAULT);
  const workbench = new WorkbenchVault(path.join(dataDir, 'vault-key.json'));
  if (!(await workbench.state()).setUp)
    throw new UsageError(
      existing
        ? KEYCHAIN_VAULT
        : 'This device has no API Workbench vault: the desktop app keeps credentials in the system’s credential store, which only the app can open. To use them here, choose Use the API Workbench vault in the app’s Credentials screen.',
    );
  try {
    await workbench.unlock(await password());
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError((error as Error).message);
  }
  const storage: SecretStorage = {
    isAsyncEncryptionAvailable: async () => workbench.unlocked,
    encryptStringAsync: async (value) => workbench.encrypt(value),
    decryptStringAsync: async (value) => {
      if (!isWorkbenchVaultData(value)) throw new UsageError(KEYCHAIN_VAULT);
      return { result: workbench.decrypt(value), shouldReEncrypt: false };
    },
    getSelectedStorageBackend: () => 'API Workbench vault',
    vaultState: async () => ({ kind: 'workbench', setUp: true, locked: !workbench.unlocked }),
  };
  return {
    vault: new CredentialVault(vaultPath, storage),
    close: () => workbench.lock(),
  };
}
