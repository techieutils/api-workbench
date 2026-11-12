import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchVault, isWorkbenchVaultData } from './workbench-vault';
import { moveVaultFiles, readBackendChoice, writeBackendChoice } from './vault-backend';

test('the vault choice is saved, and anything else reads as the system’s store', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-backend-'));
  const file = path.join(root, 'vault-backend.json');
  assert.equal(readBackendChoice(file), 'system', 'no choice yet');
  await writeBackendChoice(file, 'workbench');
  assert.equal(readBackendChoice(file), 'workbench');
  await fs.writeFile(file, '{"backend":"elsewhere"}');
  assert.equal(readBackendChoice(file), 'system');
  await fs.rm(root, { recursive: true, force: true });
});

test('credentials move from the system’s store to the API Workbench vault and back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-backend-'));
  const vault = new WorkbenchVault(path.join(root, 'vault-key.json'), {
    cost: { N: 1024, r: 8, p: 1 },
  });
  await vault.setup('Correct horse 9 battery');
  // A stand-in for the system's store: reversible, and plainly not the vault's format.
  const system = {
    encrypt: async (text: string) => Buffer.from(`os:${Buffer.from(text).toString('base64')}`),
    decrypt: async (data: Buffer) => Buffer.from(data.toString().slice(3), 'base64').toString(),
  };
  const files = ['a', 'b', 'missing'].map((name) => path.join(root, `${name}.vault`));
  await fs.writeFile(files[0], await system.encrypt('[{"name":"Token"}]'));
  await fs.writeFile(files[1], await vault.encrypt('[{"name":"Already moved"}]'));
  const toVault = {
    needs: (data: Buffer) => !isWorkbenchVaultData(data),
    decrypt: system.decrypt,
    encrypt: async (text: string) => vault.encrypt(text),
  };
  assert.equal(await moveVaultFiles(files, toVault), 1, 'only the system-encrypted file moves');
  const moved = await fs.readFile(files[0]);
  assert.ok(isWorkbenchVaultData(moved));
  assert.equal(vault.decrypt(moved), '[{"name":"Token"}]');
  assert.equal(await moveVaultFiles(files, toVault), 0, 'moving again changes nothing');
  const back = await moveVaultFiles(files, {
    needs: isWorkbenchVaultData,
    decrypt: async (data) => vault.decrypt(data),
    encrypt: system.encrypt,
  });
  assert.equal(back, 2);
  assert.equal(await system.decrypt(await fs.readFile(files[1])), '[{"name":"Already moved"}]');
  await fs.rm(root, { recursive: true, force: true });
});
