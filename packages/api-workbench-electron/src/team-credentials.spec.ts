import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { WorkspaceStore } from './workspaces';

/** A team workspace's credential choices stay on this device, never in the shared folder. */

const request = (id: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: 'https://api.example.com/items',
  folder: 'Shop',
  params: [],
  headers: [],
  body: '',
  auth: 'Saved credential',
  token: '',
  username: '',
  password: '',
  tests: '',
  response: null,
  ...extra,
});

test('a team request’s credential choice is kept on this device and read back with it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-credentials-'));
  const folder = path.join(root, 'team');
  const store = new WorkspaceStore(path.join(root, 'data'));
  await store.list();
  const state = {
    requests: [request('items')],
    tabs: ['items'],
    active: 'items',
    environments: [{ name: 'Local', variables: [] }],
    environment: 0,
    history: [],
    collectionAuth: { Shop: { auth: 'Saved credential', token: '', username: '', password: '' } },
  } as unknown as WorkspaceState;
  const entry = await store.openFolder(folder, state, 'Ada', 'share');
  await store.setTeamCredential(entry.id, { request: 'items' }, 'cred-1');
  await store.setTeamCredential(entry.id, { collection: 'Shop' }, 'cred-2');
  // A collection named like Object's members is just a name.
  await store.setTeamCredential(entry.id, { collection: '__proto__' }, 'cred-3');
  assert.equal(({} as Record<string, unknown>).credentialId, undefined);
  const loaded = (await store.load(entry.id))!;
  assert.equal(loaded.requests[0].credentialId, 'cred-1');
  assert.equal(loaded.collectionAuth?.Shop?.credentialId, 'cred-2');
  // The shared folder never holds one.
  const shared = await fs.readdir(folder, { recursive: true });
  for (const file of shared) {
    const full = path.join(folder, file);
    if ((await fs.stat(full)).isFile())
      assert.doesNotMatch(await fs.readFile(full, 'utf8'), /cred-[123]/, file);
  }
  await store.setTeamCredential(entry.id, { request: 'items' }, undefined);
  assert.equal((await store.load(entry.id))!.requests[0].credentialId, undefined);
  await assert.rejects(
    store.setTeamCredential('default', { request: 'items' }, 'x'),
    /team workspace/,
  );
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});
