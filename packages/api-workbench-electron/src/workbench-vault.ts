import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { vaultPasswordProblem } from '@techieutils/api-workbench-common/vault-password';

/**
 * The API Workbench vault: API Workbench's own encryption for secrets at rest, used when the
 * system's credential store (Keychain, DPAPI, libsecret) is not available. It works like a
 * password manager:
 *
 * - A random 256-bit data key encrypts the vault files (AES-256-GCM, a fresh nonce each time).
 * - The data key is stored only wrapped: once by a key derived from the person's vault password
 *   (scrypt), and once by a key derived from a random recovery key shown to them once, so a
 *   forgotten password can be replaced. Changing the password re-wraps the data key; the files
 *   are not touched.
 * - Unlocked, the data key is kept in memory until the vault is locked, the app quits, or it goes
 *   unused for the auto-lock time. Neither the password nor the key is ever written in the clear,
 *   and neither leaves the main process.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** The first bytes of a file encrypted by this vault, to tell it from one the OS encrypted. */
export const WORKBENCH_VAULT_MAGIC = Buffer.from('AWV1');
/** How long the vault stays unlocked without being used. */
export const AUTO_LOCK_MS = 15 * 60 * 1000;
/** Password attempts allowed before each further attempt is slowed down. */
const FREE_ATTEMPTS = 5;
/** scrypt cost: 2^17 iterations of 128 × r bytes, about 128 MB and a fraction of a second. */
const DEFAULT_COST = { N: 2 ** 17, r: 8, p: 1 };
const KEY_FILE_VERSION = 1;

interface Wrapped {
  salt: string;
  iv: string;
  data: string;
  tag: string;
}
interface KeyFile {
  version: typeof KEY_FILE_VERSION;
  kdf: { name: 'scrypt'; N: number; r: number; p: number };
  /** The data key wrapped by the password's key. */
  password: Wrapped;
  /** The data key wrapped by the recovery key's key. */
  recovery: Wrapped;
  createdAt: string;
  changedAt: string;
}

export interface WorkbenchVaultState {
  /** Whether a vault password has been set. */
  setUp: boolean;
  unlocked: boolean;
  /** When it locks if not used, as an ISO time; absent while locked. */
  locksAt?: string;
  /** Seconds to wait before another password attempt, after several wrong ones. */
  retryAfterSeconds?: number;
}

/** What a password needs, in words; undefined when it is strong enough. */
export const passwordProblem = vaultPasswordProblem;

/** A recovery key as it is shown and typed: 32 random bytes in groups of base32 letters. */
const BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
function encodeRecovery(bytes: Buffer): string {
  let bits = 0,
    value = 0,
    text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) text += BASE32[(value << (5 - bits)) & 31];
  return text.match(/.{1,4}/g)!.join('-');
}
function decodeRecovery(text: string): Buffer {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[OI L]/g, (char) => ({ O: '0', I: '1', L: '1' })[char] ?? char);
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('That is not a recovery key.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bytes.length !== 32) throw new Error('That is not a recovery key.');
  return Buffer.from(bytes);
}

function seal(key: Buffer, data: Buffer): { iv: Buffer; data: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv, data: sealed, tag: cipher.getAuthTag() };
}
function open(key: Buffer, iv: Buffer, data: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
const b64 = (value: Buffer) => value.toString('base64');
const unb64 = (value: string) => Buffer.from(value, 'base64');

export class WorkbenchVault {
  private key?: Buffer;
  private timer?: ReturnType<typeof setTimeout>;
  private locksAt = 0;
  private failures = 0;
  private blockedUntil = 0;
  /** The recovery key from setup, until it has been saved or the setup is finished. */
  private pendingRecovery?: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly options: {
      cost?: { N: number; r: number; p: number };
      autoLockMs?: number;
      now?: () => number;
      onLock?: () => void;
    } = {},
  ) {}
  private get cost() {
    return this.options.cost ?? DEFAULT_COST;
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  /** Runs vault changes one at a time. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  private async readKeyFile(): Promise<KeyFile | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as KeyFile;
      if (value.version !== KEY_FILE_VERSION || value.kdf?.name !== 'scrypt')
        throw new Error('The API Workbench vault key file is from a newer version of the app.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async writeKeyFile(value: KeyFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
  }
  private async derive(secret: string | Buffer, salt: Buffer, kdf = this.cost): Promise<Buffer> {
    return scrypt(secret, salt, 32, { ...kdf, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 });
  }
  /** A recovery key has full entropy, so a fast key derivation is enough for it. */
  private recoveryKey(recovery: Buffer, salt: Buffer): Buffer {
    return Buffer.from(hkdfSync('sha256', recovery, salt, 'api-workbench-vault-recovery', 32));
  }
  private async wrapWithPassword(password: string, dataKey: Buffer): Promise<Wrapped> {
    const salt = randomBytes(16);
    const sealed = seal(await this.derive(password, salt), dataKey);
    return { salt: b64(salt), iv: b64(sealed.iv), data: b64(sealed.data), tag: b64(sealed.tag) };
  }
  private wrapWithRecovery(recovery: Buffer, dataKey: Buffer): Wrapped {
    const salt = randomBytes(16);
    const sealed = seal(this.recoveryKey(recovery, salt), dataKey);
    return { salt: b64(salt), iv: b64(sealed.iv), data: b64(sealed.data), tag: b64(sealed.tag) };
  }
  private unwrap(key: Buffer, wrapped: Wrapped): Buffer | undefined {
    try {
      const dataKey = open(key, unb64(wrapped.iv), unb64(wrapped.data), unb64(wrapped.tag));
      return dataKey.length === 32 ? dataKey : undefined;
    } catch {
      return undefined;
    }
  }

  async state(): Promise<WorkbenchVaultState> {
    const setUp = Boolean(await this.readKeyFile());
    const wait = Math.ceil((this.blockedUntil - this.now()) / 1000);
    return {
      setUp,
      unlocked: Boolean(this.key),
      ...(this.key ? { locksAt: new Date(this.locksAt).toISOString() } : {}),
      ...(wait > 0 ? { retryAfterSeconds: wait } : {}),
    };
  }
  get unlocked(): boolean {
    return Boolean(this.key);
  }

  /** Creates the vault with a password; the recovery key is kept until saveRecovery or finish. */
  setup(password: unknown): Promise<void> {
    return this.serial(async () => {
      if (await this.readKeyFile())
        throw new Error('The API Workbench vault is already set up. Unlock it instead.');
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      const dataKey = randomBytes(32);
      const recovery = randomBytes(32);
      const now = new Date().toISOString();
      await this.writeKeyFile({
        version: KEY_FILE_VERSION,
        kdf: { name: 'scrypt', ...this.cost },
        password: await this.wrapWithPassword(password as string, dataKey),
        recovery: this.wrapWithRecovery(recovery, dataKey),
        createdAt: now,
        changedAt: now,
      });
      this.pendingRecovery = encodeRecovery(recovery);
      this.open(dataKey);
    });
  }
  /** The recovery key made at setup, for saving it once; then forgotten. Main process only. */
  pendingRecoveryKey(): string | undefined {
    return this.pendingRecovery;
  }
  finishSetup(): void {
    this.pendingRecovery = undefined;
  }

  unlock(password: unknown): Promise<void> {
    return this.serial(async () => {
      const keyFile = await this.readKeyFile();
      if (!keyFile) throw new Error('Set up the API Workbench vault first.');
      this.throttle();
      if (typeof password !== 'string' || !password) throw new Error('Enter your vault password.');
      const dataKey = this.unwrap(
        await this.derive(password, unb64(keyFile.password.salt), keyFile.kdf),
        keyFile.password,
      );
      if (!dataKey) {
        this.fail();
        throw new Error(
          'That password is not right. If you have forgotten it, use your recovery key.',
        );
      }
      this.failures = 0;
      this.open(dataKey);
    });
  }
  /** Sets a new password with the recovery key, when the password is forgotten. */
  recover(recoveryKey: unknown, password: unknown): Promise<void> {
    return this.serial(async () => {
      const keyFile = await this.readKeyFile();
      if (!keyFile) throw new Error('Set up the API Workbench vault first.');
      this.throttle();
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      let recovery: Buffer;
      try {
        recovery = decodeRecovery(String(recoveryKey ?? ''));
      } catch (error) {
        this.fail();
        throw error;
      }
      const dataKey = this.unwrap(
        this.recoveryKey(recovery, unb64(keyFile.recovery.salt)),
        keyFile.recovery,
      );
      if (!dataKey) {
        this.fail();
        throw new Error('That recovery key does not open this vault.');
      }
      this.failures = 0;
      await this.writeKeyFile({
        ...keyFile,
        password: await this.wrapWithPassword(password as string, dataKey),
        changedAt: new Date().toISOString(),
      });
      this.open(dataKey);
    });
  }
  changePassword(current: unknown, next: unknown): Promise<void> {
    return this.serial(async () => {
      const keyFile = await this.readKeyFile();
      if (!keyFile) throw new Error('Set up the API Workbench vault first.');
      this.throttle();
      const problem = passwordProblem(next);
      if (problem) throw new Error(problem);
      const dataKey = this.unwrap(
        await this.derive(String(current ?? ''), unb64(keyFile.password.salt), keyFile.kdf),
        keyFile.password,
      );
      if (!dataKey) {
        this.fail();
        throw new Error('Your current password is not right.');
      }
      this.failures = 0;
      await this.writeKeyFile({
        ...keyFile,
        kdf: { name: 'scrypt', ...this.cost },
        password: await this.wrapWithPassword(next as string, dataKey),
        changedAt: new Date().toISOString(),
      });
      this.open(dataKey);
    });
  }
  lock(): void {
    clearTimeout(this.timer);
    this.key?.fill(0);
    const wasUnlocked = Boolean(this.key);
    this.key = undefined;
    this.pendingRecovery = undefined;
    if (wasUnlocked) this.options.onLock?.();
  }
  /** Forgets the vault: its key file goes, so files it encrypted can no longer be read. */
  reset(): Promise<void> {
    return this.serial(async () => {
      this.lock();
      await fs.rm(this.file, { force: true });
      this.failures = 0;
      this.blockedUntil = 0;
    });
  }

  private open(dataKey: Buffer): void {
    this.key?.fill(0);
    this.key = dataKey;
    this.touch();
  }
  /** Each use keeps the vault open for the auto-lock time again. */
  private touch(): void {
    const wait = this.options.autoLockMs ?? AUTO_LOCK_MS;
    this.locksAt = this.now() + wait;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lock(), wait);
    this.timer.unref?.();
  }
  /** After several wrong attempts, each further one waits longer: 2, 4, 8 … up to 60 seconds. */
  private fail(): void {
    this.failures++;
    if (this.failures > FREE_ATTEMPTS)
      this.blockedUntil = this.now() + Math.min(60, 2 ** (this.failures - FREE_ATTEMPTS)) * 1000;
  }
  private throttle(): void {
    const wait = Math.ceil((this.blockedUntil - this.now()) / 1000);
    if (wait > 0) throw new Error(`Too many wrong attempts. Try again in ${wait} seconds.`);
  }

  /** Encrypts with the data key; throws when locked. */
  encrypt(value: string): Buffer {
    if (!this.key) throw new Error(WORKBENCH_VAULT_LOCKED);
    this.touch();
    const sealed = seal(this.key, Buffer.from(value, 'utf8'));
    return Buffer.concat([WORKBENCH_VAULT_MAGIC, sealed.iv, sealed.tag, sealed.data]);
  }
  decrypt(value: Buffer): string {
    if (!this.key) throw new Error(WORKBENCH_VAULT_LOCKED);
    if (!isWorkbenchVaultData(value))
      throw new Error('This was not encrypted by the API Workbench vault.');
    this.touch();
    const body = value.subarray(WORKBENCH_VAULT_MAGIC.length);
    try {
      return open(
        this.key,
        body.subarray(0, 12),
        body.subarray(28),
        body.subarray(12, 28),
      ).toString('utf8');
    } catch (error) {
      throw new Error(
        'This vault file was encrypted with another API Workbench vault (one that was reset) and cannot be read.',
        { cause: error },
      );
    }
  }
}
/** Whether data was encrypted by the API Workbench vault (rather than the OS). */
export const isWorkbenchVaultData = (value: Buffer) =>
  value.length >= WORKBENCH_VAULT_MAGIC.length + 28 &&
  timingSafeEqual(value.subarray(0, WORKBENCH_VAULT_MAGIC.length), WORKBENCH_VAULT_MAGIC);
/** Locked: the person unlocks it with their vault password. */
export const WORKBENCH_VAULT_LOCKED =
  'The API Workbench vault is locked. Unlock it with your vault password.';
