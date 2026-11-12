import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKBENCH_VAULT_LOCKED,
  WorkbenchVault,
  isWorkbenchVaultData,
  passwordProblem,
} from './workbench-vault';
import { CredentialVault, type SecretStorage } from './credentials';

/** The API Workbench vault: password, recovery key, locking, and encryption of vault files. */

const cost = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery 9';
async function setup(t: { after(callback: () => Promise<void>): void }, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-vault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'vault-key.json');
  return { root, file, vault: new WorkbenchVault(file, { cost, ...options }) };
}

test('passwords must be long and varied enough', () => {
  assert.match(passwordProblem('short1!')!, /at least 12/);
  assert.match(passwordProblem('alllowercaseletters')!, /Mix letters/);
  assert.equal(passwordProblem('a passphrase of many words'), undefined, 'a long passphrase');
  assert.equal(passwordProblem(PASSWORD), undefined);
  assert.match(passwordProblem(undefined)!, /at least 12/);
});

test('set up, lock, and unlock: the key file holds no password or key in the clear', async (t) => {
  const { file, vault } = await setup(t);
  assert.deepEqual(await vault.state(), { setUp: false, unlocked: false });
  await vault.setup(PASSWORD);
  const recovery = vault.pendingRecoveryKey()!;
  assert.match(recovery, /^([A-Z0-9]{4}-){12}[A-Z0-9]{4}$/, 'a grouped recovery key');
  const encrypted = vault.encrypt('{"secret":"TEST-SECRET-VALUE"}');
  assert.ok(isWorkbenchVaultData(encrypted));
  assert.ok(
    !encrypted.includes(Buffer.from('TEST-SECRET-VALUE')),
    'the secret is not in the clear',
  );
  assert.equal(vault.decrypt(encrypted), '{"secret":"TEST-SECRET-VALUE"}');
  const keyFile = await fs.readFile(file, 'utf8');
  assert.ok(!keyFile.includes(PASSWORD) && !keyFile.includes(recovery.replace(/-/g, '')));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  vault.finishSetup();
  assert.equal(vault.pendingRecoveryKey(), undefined, 'the recovery key is forgotten');

  vault.lock();
  assert.throws(() => vault.decrypt(encrypted), new RegExp(WORKBENCH_VAULT_LOCKED.slice(0, 30)));
  await assert.rejects(vault.unlock('wrong password 1'), /not right/);
  await vault.unlock(PASSWORD);
  assert.equal(vault.decrypt(encrypted), '{"secret":"TEST-SECRET-VALUE"}');
  await assert.rejects(vault.setup(PASSWORD), /already set up/);
});

test('a forgotten password is replaced with the recovery key; changing it keeps the data', async (t) => {
  const { vault } = await setup(t);
  await vault.setup(PASSWORD);
  const recovery = vault.pendingRecoveryKey()!;
  const encrypted = vault.encrypt('kept');
  vault.lock();
  // Lowercase, without dashes, and with look-alike letters still reads.
  await vault.recover(recovery.toLowerCase().replace(/-/g, ' '), 'a brand new passphrase');
  assert.equal(vault.decrypt(encrypted), 'kept');
  vault.lock();
  await assert.rejects(vault.unlock(PASSWORD), /not right/, 'the old password no longer works');
  await vault.unlock('a brand new passphrase');
  await vault.changePassword('a brand new passphrase', 'another long passphrase');
  vault.lock();
  await vault.unlock('another long passphrase');
  assert.equal(vault.decrypt(encrypted), 'kept', 'files are not touched by a password change');
  await assert.rejects(
    vault.changePassword('nope nope nope', 'yet another passphrase'),
    /current password/,
  );
  await assert.rejects(
    vault.recover('AAAA-'.repeat(12) + 'AAAA', 'a brand new passphrase'),
    /does not open this vault/,
  );
  await assert.rejects(vault.recover('not a key', 'a brand new passphrase'), /not a recovery key/);
});

test('it locks after going unused, and wrong guesses are slowed down', async (t) => {
  let now = 1_000_000;
  let locked = 0;
  const { vault } = await setup(t, { now: () => now, autoLockMs: 60_000, onLock: () => locked++ });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await vault.setup(PASSWORD);
  vault.encrypt('use');
  t.mock.timers.tick(59_000);
  assert.equal(vault.unlocked, true);
  vault.encrypt('use again');
  t.mock.timers.tick(59_000);
  assert.equal(vault.unlocked, true, 'each use starts the wait again');
  t.mock.timers.tick(2_000);
  assert.equal(vault.unlocked, false);
  assert.equal(locked, 1, 'the app is told it locked');

  for (let attempt = 0; attempt < 6; attempt++)
    await assert.rejects(vault.unlock(`wrong password ${attempt}`), /not right/);
  await assert.rejects(vault.unlock(PASSWORD), /Too many wrong attempts/);
  assert.ok((await vault.state()).retryAfterSeconds! > 0);
  now += 3_000;
  await vault.unlock(PASSWORD);
  assert.equal(vault.unlocked, true);
});

test('reset forgets the vault, and its old files are reported, not misread', async (t) => {
  const { file, vault } = await setup(t);
  await vault.setup(PASSWORD);
  const old = vault.encrypt('before reset');
  await vault.reset();
  await assert.rejects(fs.access(file));
  assert.deepEqual(await vault.state(), { setUp: false, unlocked: false });
  await vault.setup(PASSWORD);
  assert.throws(() => vault.decrypt(old), /another API Workbench vault/);
  // Tampered data is refused rather than read.
  const tampered = Buffer.from(vault.encrypt('value'));
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => vault.decrypt(tampered), /cannot be read/);
});

test('the credential vault saves through the API Workbench vault when the OS has no store', async (t) => {
  const { root, vault } = await setup(t);
  const storage: SecretStorage = {
    isAsyncEncryptionAvailable: async () => vault.unlocked,
    encryptStringAsync: async (value) => vault.encrypt(value),
    decryptStringAsync: async (value) => ({ result: vault.decrypt(value), shouldReEncrypt: false }),
    getSelectedStorageBackend: () => 'API Workbench vault',
    vaultState: async () => ({
      kind: 'workbench',
      setUp: (await vault.state()).setUp,
      locked: !vault.unlocked,
    }),
  };
  const credentials = new CredentialVault(path.join(root, 'credentials.enc'), storage);
  await assert.rejects(credentials.list(), /Set up the API Workbench vault/);
  await vault.setup(PASSWORD);
  await credentials.save({
    name: 'API token',
    kind: 'bearer',
    allowedOrigin: 'https://api.test',
    secret: 'TEST-BEARER-TOKEN',
  });
  const saved = await fs.readFile(path.join(root, 'credentials.enc'));
  assert.ok(isWorkbenchVaultData(saved));
  assert.ok(!saved.includes(Buffer.from('TEST-BEARER-TOKEN')));
  vault.lock();
  assert.deepEqual(
    { ...(await credentials.status()), backend: undefined },
    { available: false, backend: undefined, kind: 'workbench', setUp: true, locked: true },
  );
  await assert.rejects(credentials.list(), /API Workbench vault is locked/);
  await vault.unlock(PASSWORD);
  assert.equal((await credentials.list())[0].name, 'API token');
});
