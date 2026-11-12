import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import {
  collectionFiles,
  readCollectionFiles,
  safeFileName,
  syncCollectionFiles,
} from './collection-files';

const request = (id: string, name: string, folder: string, extra: Partial<ApiRequest> = {}) =>
  ({
    id,
    name,
    folder,
    method: 'GET',
    url: `https://api.example.com/${id}`,
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
    response: null,
    ...extra,
  }) as ApiRequest;
const state = (requests: ApiRequest[], extra: Partial<WorkspaceState> = {}): WorkspaceState => ({
  requests,
  tabs: [],
  environments: [{ name: 'Default', variables: [] }],
  environment: 0,
  history: [],
  ...extra,
});
async function directory(t: { after(callback: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-collections-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
/** Writes a workspace's collections and reads them back. */
async function roundTrip(root: string, workspace: WorkspaceState) {
  const written = collectionFiles(workspace);
  await syncCollectionFiles(root, new Map(), written.files);
  return { written, read: await readCollectionFiles(root, written.order) };
}

test('names on disk are safe on Windows, macOS, and Linux', () => {
  assert.equal(safeFileName('Users / Orders?'), 'Users - Orders-');
  assert.equal(safeFileName('a<b>c:"d|e*f\\g'), 'a-b-c--d-e-f-g');
  assert.equal(safeFileName('CON'), 'CON_');
  assert.equal(safeFileName('lpt1.yaml'), 'lpt1.yaml_');
  assert.equal(safeFileName('trailing dots...'), 'trailing dots');
  assert.equal(safeFileName('  '), 'Untitled');
  assert.equal(safeFileName('..'), 'Untitled');
  assert.equal(safeFileName('x'.repeat(200)).length, 80);
});

test('collections, folders, settings, and auth round-trip through directories and YAML files', async (t) => {
  const root = await directory(t);
  const workspace = state(
    [
      request('a', 'List users', 'Users'),
      request('b', 'a/b?', 'Users/Admin: tools'),
      request('c', 'Users', 'Users/Admin: tools'),
      request('d', 'users', 'Users/Admin: tools'),
      request('e', 'Health', 'Ops'),
      request('f', 'Deep', 'Users/Admin: tools/Archive'),
    ],
    {
      collectionHttpSettings: {
        Users: { timeoutMs: 2222 },
        'Users/Admin: tools': { timeoutMs: 3333 },
      },
      collectionAuth: {
        Users: { auth: 'Bearer token', token: 't', username: '', password: '' },
        'Users/Admin: tools': {
          auth: 'Inherit from collection',
          token: '',
          username: '',
          password: '',
        },
      },
    },
  );
  const { written, read } = await roundTrip(root, workspace);
  assert.deepEqual(written.order, ['Users', 'Ops']);
  // Requests load in explorer order: each folder's folders, then its own requests.
  assert.deepEqual(
    read.requests.map((item) => item.id),
    ['f', 'b', 'c', 'd', 'a', 'e'],
  );
  const original = new Map(workspace.requests.map((item) => [item.id, item]));
  for (const item of read.requests) assert.deepEqual(item, original.get(item.id));
  assert.deepEqual(read.collectionHttpSettings, workspace.collectionHttpSettings);
  assert.deepEqual(read.collectionAuth, workspace.collectionAuth);
  // Unsafe characters are replaced on disk, and names that differ only in case get their own file.
  const admin = path.join(root, 'collections', 'Users', 'Admin- tools');
  assert.deepEqual((await fs.readdir(admin)).sort(), [
    'Archive',
    'Users.yaml',
    '_folder.yaml',
    'a-b-.yaml',
    'users 2.yaml',
  ]);
  assert.equal(read.directories.get('Users/Admin: tools'), 'collections/Users/Admin- tools');
});

test('collections named after Object built-ins keep only their own settings', async (t) => {
  // "constructor" once found Object's own function where its settings should be.
  const root = await directory(t);
  const workspace = state(
    [
      request('a', 'Build', 'constructor'),
      request('b', 'Text', 'toString'),
      request('c', 'Proto', '__proto__'),
    ],
    {
      collectionTags: JSON.parse('{"__proto__": ["proto"], "constructor": ["built"]}'),
      collectionScripts: { constructor: { pre: "aw.vars.set('a', '1');\n" } },
    },
  );
  const { read } = await roundTrip(root, workspace);
  assert.deepEqual(read.collectionTags, workspace.collectionTags);
  assert.equal(Object.getPrototypeOf(read.collectionTags), Object.prototype);
  assert.deepEqual(read.collectionScripts, workspace.collectionScripts);
  assert.deepEqual(read.collectionAuth, {});
  assert.deepEqual(read.collectionHttpSettings, {});
  const files = await fs
    .readFile(path.join(root, 'collections', 'toString', '_collection.yaml'), 'utf8')
    .catch(() => '');
  assert.doesNotMatch(files, /auth|tags|scripts/);
});

test('request files are readable YAML with multi-line text kept as written', async (t) => {
  const root = await directory(t);
  const body = '{\n  "name": "one"\n}';
  const tests = 'status 200\njson $.name equals "one"';
  await roundTrip(
    root,
    state([
      request('a', 'Create', 'Shop', {
        method: 'POST',
        body,
        tests,
        response: { status: 200 } as never,
      }),
    ]),
  );
  const text = await fs.readFile(path.join(root, 'collections', 'Shop', 'Create.yaml'), 'utf8');
  assert.match(text, /^id: a\nname: Create\nmethod: POST\nurl: https:\/\/api\.example\.com\/a\n/);
  assert.match(text, /body: \|-\n {2}\{\n {4}"name": "one"\n {2}\}\n/);
  assert.doesNotMatch(text, /folder:|response:/);
});

test('request files added by hand are read, and missing or repeated ids are replaced', async (t) => {
  const root = await directory(t);
  const { written } = await roundTrip(root, state([request('a', 'First', 'Shop')]));
  const shop = path.join(root, 'collections', 'Shop');
  await fs.writeFile(path.join(shop, 'Added.yaml'), 'name: Added\nurl: https://example.com\n');
  await fs.writeFile(path.join(shop, 'Copy.yaml'), 'id: a\nname: Copy\nurl: https://example.com\n');
  await fs.mkdir(path.join(shop, 'New folder'));
  await fs.writeFile(path.join(shop, 'New folder', 'Inside.yaml'), 'id: z\nname: Inside\n');
  const read = await readCollectionFiles(root, written.order);
  assert.deepEqual(
    read.requests.map((item) => [item.name, item.folder]),
    [
      ['Inside', 'Shop/New folder'],
      ['First', 'Shop'],
      ['Added', 'Shop'],
      ['Copy', 'Shop'],
    ],
  );
  const ids = read.requests.map((item) => item.id);
  assert.equal(new Set(ids).size, 4, 'every request has its own id');
  assert.equal(ids[1], 'a');
  assert.equal(read.requests[2].method, 'GET', 'missing fields get their defaults');
});

test('syncing removes files and folders the app no longer needs, and keeps files it did not write', async (t) => {
  const root = await directory(t);
  const first = collectionFiles(
    state([request('a', 'One', 'Shop/Old'), request('b', 'Two', 'Shop')]),
  );
  await syncCollectionFiles(root, new Map(), first.files);
  await fs.writeFile(path.join(root, 'collections', 'Shop', 'notes.md'), 'mine');
  const second = collectionFiles(state([request('b', 'Two', 'Shop')]));
  await syncCollectionFiles(root, first.files, second.files);
  const shop = path.join(root, 'collections', 'Shop');
  assert.deepEqual((await fs.readdir(shop)).sort(), ['Two.yaml', '_collection.yaml', 'notes.md']);
  // A rename that only changes case keeps the file on disks that ignore case.
  const renamed = collectionFiles(state([request('b', 'two', 'Shop')]));
  await syncCollectionFiles(root, second.files, renamed.files);
  const read = await readCollectionFiles(root, renamed.order);
  assert.deepEqual(
    read.requests.map((item) => item.name),
    ['two'],
  );
});

test('collection and folder scripts are saved in their folder files, as text only', async (t) => {
  const root = await directory(t);
  const { written, read } = await roundTrip(
    root,
    state([request('a', 'List', 'Shop/Orders'), request('b', 'Ping', 'Health')], {
      collectionScripts: {
        Shop: { pre: "aw.vars.set('tenant', 'acme');\n" },
        'Shop/Orders': { post: "aw.test('ok', () => aw.expect(aw.response.status).toBe(200));\n" },
        Health: { pre: '   ' },
      },
    }),
  );
  const collection = written.files.get('collections/Shop/_collection.yaml')!;
  assert.match(collection, /scripts:\n {2}pre: \|\n {4}aw\.vars\.set\('tenant', 'acme'\);/);
  assert.match(written.files.get('collections/Shop/Orders/_folder.yaml')!, /post: \|/);
  assert.doesNotMatch(written.files.get('collections/Health/_collection.yaml')!, /scripts/);
  assert.deepEqual(read.collectionScripts, {
    Shop: { pre: "aw.vars.set('tenant', 'acme');\n" },
    'Shop/Orders': { post: "aw.test('ok', () => aw.expect(aw.response.status).toBe(200));\n" },
  });
  // A hand-edited file with something other than text in it keeps no script.
  await fs.writeFile(
    path.join(root, 'collections/Health/_collection.yaml'),
    'name: Health\nscripts:\n  pre: [1, 2]\n',
  );
  assert.equal(
    (await readCollectionFiles(root, written.order)).collectionScripts.Health,
    undefined,
  );
});

test('request tags are saved in the request file and read back, valid ones only', async (t) => {
  const root = await directory(t);
  const { written, read } = await roundTrip(
    root,
    state([
      request('a', 'List', 'Shop', { tags: ['smoke', 'auth'] }),
      request('b', 'Ping', 'Shop'),
    ]),
  );
  const file = [...written.files].find(([name]) => name.endsWith('List.yaml'))![1];
  assert.match(file, /tags:\n {2}- smoke\n {2}- auth/);
  assert.deepEqual(read.requests.find((item) => item.id === 'a')!.tags, ['smoke', 'auth']);
  assert.equal('tags' in read.requests.find((item) => item.id === 'b')!, false);
  await fs.writeFile(
    path.join(root, 'collections/Shop/List.yaml'),
    'id: a\nname: List\nmethod: GET\nurl: https://x.test\ntags:\n  - smoke\n  - two words\n  - 7\n',
  );
  const again = await readCollectionFiles(root, written.order);
  assert.deepEqual(again.requests.find((item) => item.id === 'a')!.tags, ['smoke']);
});

test('collection and folder tags are saved in their folder files and read back', async (t) => {
  const root = await directory(t);
  const { written, read } = await roundTrip(
    root,
    state([request('a', 'List', 'Shop/Orders')], {
      collectionTags: { Shop: ['smoke'], 'Shop/Orders': ['orders', 'write'] },
    }),
  );
  assert.match(written.files.get('collections/Shop/_collection.yaml')!, /tags:\n {2}- smoke/);
  assert.match(written.files.get('collections/Shop/Orders/_folder.yaml')!, /- orders\n {2}- write/);
  assert.deepEqual(read.collectionTags, { Shop: ['smoke'], 'Shop/Orders': ['orders', 'write'] });
});
