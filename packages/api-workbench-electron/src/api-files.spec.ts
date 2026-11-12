import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { WorkspaceStore } from './workspaces';
import type { WorkspaceChange, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { blankSpec } from '@techieutils/api-workbench-common/api-specs';
import { newMock, newMockRoute } from '@techieutils/api-workbench-common/mocks';

const seed = (): WorkspaceState => ({
  requests: [
    {
      id: 'r1',
      name: 'List',
      method: 'GET',
      url: 'https://example.com',
      folder: 'Shop',
      params: [],
      headers: [],
      body: '',
      auth: 'None',
      token: '',
      username: '',
      password: '',
      tests: '',
      response: null,
    },
  ],
  tabs: ['r1'],
  environments: [{ name: 'Local', variables: [] }],
  environment: 0,
  history: [],
  specs: [
    { id: 's1', name: 'Shop API', format: 'yaml', content: blankSpec('Shop'), collection: 'Shop' },
    { id: 's2', name: 'Shop API', format: 'json', content: blankSpec('Shop', 'json') },
  ],
  mocks: [
    {
      ...newMock('Shop mock', []),
      id: 'm1',
      routes: [newMockRoute({ id: 'route', path: '/items/:id', body: '{"id":"{{params.id}}"}' })],
    },
  ],
});
async function setup(t: { after(callback: () => Promise<void> | void): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-api-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new WorkspaceStore(root) };
}
const eventually = async <T>(read: () => T | undefined): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for a change.');
};

test('specifications and mocks are saved as their own files and read back', async (t) => {
  const { root, store } = await setup(t);
  const state = seed();
  await store.save(state);
  assert.deepEqual((await fs.readdir(path.join(root, 'specs'))).sort(), [
    'Shop API 2.json',
    'Shop API.yaml',
  ]);
  assert.equal(
    await fs.readFile(path.join(root, 'specs', 'Shop API.yaml'), 'utf8'),
    state.specs![0].content,
    'a specification file holds the specification exactly as written',
  );
  const mock = parse(await fs.readFile(path.join(root, 'mocks', 'Shop mock.yaml'), 'utf8'));
  assert.equal(mock.routes[0].path, '/items/:id');
  const workspace = JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(workspace.specs, undefined);
  assert.equal(workspace.mocks, undefined);
  assert.deepEqual(
    workspace.specFiles.map((entry: { file: string }) => entry.file),
    ['Shop API.yaml', 'Shop API 2.json'],
  );
  const loaded = (await new WorkspaceStore(root).load())!;
  assert.deepEqual(
    [...loaded.specs!].sort((a, b) => a.id.localeCompare(b.id)),
    state.specs,
  );
  assert.deepEqual(loaded.mocks, state.mocks);
});

test('removing a specification or mock removes its file, and files added by hand are read', async (t) => {
  const { root, store } = await setup(t);
  const state = seed();
  await store.save(state);
  state.specs = state.specs!.slice(0, 1);
  state.mocks = [];
  await store.save(state);
  assert.deepEqual(await fs.readdir(path.join(root, 'specs')), ['Shop API.yaml']);
  assert.deepEqual(await fs.readdir(path.join(root, 'mocks')), []);
  await fs.writeFile(path.join(root, 'specs', 'Pets.yml'), blankSpec('Pets'));
  await fs.writeFile(
    path.join(root, 'mocks', 'Hand made.yaml'),
    'port: 5000\nroutes:\n  - path: /x\n',
  );
  const loaded = (await new WorkspaceStore(root).load())!;
  const pets = loaded.specs!.find((spec) => spec.name === 'Pets')!;
  assert.equal(pets.format, 'yaml');
  assert.equal(pets.content, blankSpec('Pets'));
  assert.equal(loaded.mocks![0].name, 'Hand made');
  assert.equal(loaded.mocks![0].port, 5000);
  assert.equal(loaded.mocks![0].routes[0].path, '/x');
});

test('a mock file edited outside the app is reported; invalid YAML is an error', async (t) => {
  const { root, store } = await setup(t);
  await store.save(seed());
  await store.load();
  const changes: WorkspaceChange[] = [];
  store.onWorkspaceChange((change) => changes.push(change));
  t.after(() => store.close());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const file = path.join(root, 'mocks', 'Shop mock.yaml');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('port: 4010', 'port: 4999'));
  const change = await eventually(() => changes.at(-1));
  assert.ok('state' in change);
  assert.equal(change.state.mocks![0].port, 4999);
  const spec = path.join(root, 'specs', 'Shop API.yaml');
  await fs.writeFile(spec, blankSpec('Edited'));
  const edited = await eventually(() => {
    const last = changes.at(-1);
    return last &&
      'state' in last &&
      last.state.specs?.some((item) => item.content.includes('Edited'))
      ? last
      : undefined;
  });
  assert.ok('state' in edited);
  await fs.writeFile(file, 'routes: [unclosed');
  const broken = await eventually(() => {
    const last = changes.at(-1);
    return last && 'error' in last ? last : undefined;
  });
  assert.match(broken.error!, /Shop mock\.yaml/);
});
