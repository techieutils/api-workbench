/**
 * Errors about the credential vault, worded once so every screen can recognize them and offer to
 * unlock it where the error appears.
 */

/** The vault has not been unlocked in this session. Messages start with this sentence. */
export const VAULT_LOCKED = 'The credential vault is locked.';
/** Unlocking failed: the system keychain refused access or could not decrypt the vault. */
export const VAULT_DENIED =
  'The credential vault could not be opened. Your system keychain may have denied access.';

/** OS encryption is not available, typically a locked or unreachable keychain; restart once it is unlocked. */
export const VAULT_UNAVAILABLE =
  'OS-backed encryption is unavailable. Unlock your system keychain, then restart API Workbench. No secrets will be saved as plain text.';
/** Linux with no keyring service: Electron falls back to plain-text storage until a restart. */
export const VAULT_NO_KEYRING =
  'No system keyring is available to encrypt secrets. Start a keyring service such as GNOME Keyring or KWallet, then restart API Workbench. No secrets will be saved as plain text.';
/** The unavailable message for the storage backend Electron reports. */
export const vaultUnavailable = (backend?: string): string =>
  backend === 'basic_text' ? VAULT_NO_KEYRING : VAULT_UNAVAILABLE;

/** A vault-locked error for an operation, e.g. `vaultLocked('send this request with its saved credential')`. */
export const vaultLocked = (purpose: string): string => `${VAULT_LOCKED} Unlock it to ${purpose}.`;

/**
 * Whether an error message is about the vault: locked this session, refused by the keychain
 * (which can be tried again), or OS encryption unavailable, which offers a restart.
 */
export function vaultIssue(
  message: string | undefined,
): 'locked' | 'denied' | 'unavailable' | 'restart' | undefined {
  if (!message) return undefined;
  if (message.includes(VAULT_LOCKED)) return 'locked';
  if (message.includes(VAULT_DENIED)) return 'denied';
  if (message.includes(VAULT_UNAVAILABLE)) return 'unavailable';
  if (message.includes(VAULT_NO_KEYRING)) return 'restart';
  return undefined;
}

/** No system credential store, and the API Workbench vault has no password yet. */
export const WORKBENCH_VAULT_NOT_SET_UP =
  'This computer has no system credential store. Set up the API Workbench vault in Credentials to save secrets, encrypted with a password of your own.';
