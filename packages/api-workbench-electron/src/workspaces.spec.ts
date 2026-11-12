import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './workspaces';
import { CredentialVault } from './credentials';
import type { WorkspaceState } from '@techieutils/api-workbench-common/types';
const seed = (name: string): WorkspaceState => ({
  requests: [
    {
      id: name,
      name,
      method: 'GET',
      url: 'https://example.com',
      folder: name,
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
  active: name,
  tabs: [name],
  environments: [{ name, variables: [] }],
  environment: 0,
  history: [],
});
async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-workspaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new WorkspaceStore(root) };
}
test('legacy workspace and encrypted credentials remain in place when workspace support initializes', async (t) => {
  const { root, store } = await setup(t);
  const saved = seed('Legacy');
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify(saved));
  await fs.writeFile(path.join(root, 'credentials.enc'), 'ORIGINAL-ENCRYPTED-VAULT');
  const index = await store.list();
  assert.equal(index.activeId, 'default');
  assert.deepEqual(await store.load(), saved);
  assert.equal(
    await fs.readFile(path.join(root, 'credentials.enc'), 'utf8'),
    'ORIGINAL-ENCRYPTED-VAULT',
  );
  assert.equal(store.vaultPath('default'), path.join(root, 'credentials.enc'));
});
test('workspace switching and explicit save IDs isolate collections and survive restart', async (t) => {
  const { root, store } = await setup(t);
  await store.save(seed('First'), 'default');
  const second = await store.create('Second', seed('Second'));
  await Promise.all([store.save(seed('First updated'), 'default'), store.activate(second.id)]);
  await store.save(seed('Late first save'), 'default');
  assert.equal((await store.load(second.id))!.requests[0].name, 'Second');
  assert.equal((await store.load('default'))!.requests[0].name, 'Late first save');
  const restarted = new WorkspaceStore(root);
  assert.equal((await restarted.load())!.requests[0].name, 'Second');
  assert.equal((await restarted.list()).activeId, second.id);
});
test('rename persists names and deletion protects active workspace and removes only chosen workspace', async (t) => {
  const { root, store } = await setup(t);
  await store.save(seed('First'), 'default');
  const second = await store.create('Second', seed('Second'));
  await store.rename(second.id, 'Renamed');
  assert.equal((await store.load(second.id))!.settings!.workspaceName, 'Renamed');
  assert.equal(
    (await store.list()).workspaces.find((item) => item.id === second.id)!.name,
    'Renamed',
  );
  await assert.rejects(store.delete('default'), /Switch to another/);
  await store.delete(second.id);
  assert.equal((await store.list()).workspaces.length, 1);
  await assert.rejects(store.load(second.id), /no longer exists/);
  assert.equal((await store.load('default'))!.requests[0].name, 'First');
  await assert.rejects(fs.access(path.dirname(store.vaultPath(second.id))), /ENOENT/);
  assert.match(
    await fs.readFile(path.join(root, 'collections', 'First', 'First.yaml'), 'utf8'),
    /^name: First$/m,
  );
});
test('invalid IDs, invalid names, and corrupt target data cannot replace active workspace', async (t) => {
  const { root, store } = await setup(t);
  await store.save(seed('First'), 'default');
  await assert.rejects(store.activate('../outside'), /Invalid workspace ID/);
  await assert.rejects(store.create(' ', seed('bad')), /name/);
  const second = await store.create('Second', seed('Second'));
  const file = path.join(path.dirname(store.vaultPath(second.id)), 'workspace.json');
  await fs.writeFile(file, 'BROKEN-JSON');
  await assert.rejects(store.activate(second.id), /Existing files were preserved/);
  assert.equal((await store.list()).activeId, 'default');
  assert.equal(await fs.readFile(file, 'utf8'), 'BROKEN-JSON');
  await assert.rejects(
    store.save({ ...seed('bad'), requests: [] }, 'default'),
    /Invalid workspace/,
  );
  assert.equal((await store.load('default'))!.requests[0].name, 'First');
  await fs.writeFile(path.join(root, 'workspaces.json'), 'BAD-INDEX');
  await assert.rejects(new WorkspaceStore(root).list(), /Existing files were preserved/);
  assert.equal(await fs.readFile(path.join(root, 'workspaces.json'), 'utf8'), 'BAD-INDEX');
});
test('workspace vaults are separate and construction never requests OS credentials', async (t) => {
  const { store } = await setup(t);
  await store.save(seed('First'), 'default');
  const second = await store.create('Second', seed('Second'));
  let keychainChecks = 0;
  const encryption = {
    isAsyncEncryptionAvailable: async () => {
      keychainChecks++;
      return true;
    },
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
    getSelectedStorageBackend: () => 'test',
  };
  const firstVault = new CredentialVault(store.vaultPath('default'), encryption),
    secondVault = new CredentialVault(store.vaultPath(second.id), encryption);
  assert.equal(keychainChecks, 0);
  const credential = await firstVault.save({
    name: 'First token',
    kind: 'bearer',
    allowedOrigin: 'https://example.com',
    secret: 'FIRST-SECRET',
  });
  assert.equal((await firstVault.list()).length, 1);
  assert.deepEqual(await secondVault.list(), []);
  await assert.rejects(secondVault.get(credential.id), /not found|no longer exists/i);
});

test('missing previously saved default workspace is reported without replacing its file', async (t) => {
  const { root, store } = await setup(t);
  await store.save(seed('First'), 'default');
  await fs.unlink(path.join(root, 'workspace.json'));
  await assert.rejects(new WorkspaceStore(root).load(), /Workspace data is missing/);
  await assert.rejects(fs.access(path.join(root, 'workspace.json')), /ENOENT/);
});
test('the active workspace file follows the active workspace', async (t) => {
  const { root, store } = await setup(t);
  await store.list();
  assert.equal(store.activeStatePath(), path.join(root, 'workspace.json'));
  const second = await store.create('Second', seed('Second'));
  await store.activate(second.id);
  assert.equal(store.activeStatePath(), path.join(root, 'workspaces', second.id, 'workspace.json'));
});
test('a workspace kept in one file moves into collection files on its first save, with a copy kept', async (t) => {
  const { root, store } = await setup(t);
  const legacy = seed('Shop');
  legacy.requests[0].folder = 'Shop/Orders';
  legacy.requests[0].response = {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: 'ok',
    time: 1,
    size: 2,
    url: 'https://example.com',
  };
  legacy.collectionHttpSettings = { 'Shop/Orders': { timeoutMs: 1234 } };
  await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify(legacy));
  const loaded = (await store.load())!;
  assert.deepEqual(loaded, legacy, 'a workspace kept in one file still loads');
  await store.save(loaded);
  const file = JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(file.storage, 'collections');
  assert.equal(file.requests, undefined, 'requests move out of the workspace file');
  assert.deepEqual(file.collectionOrder, ['Shop']);
  assert.equal(
    file.responses[legacy.requests[0].id].body,
    'ok',
    'saved responses stay in the workspace file',
  );
  const requestFile = await fs.readFile(
    path.join(root, 'collections', 'Shop', 'Orders', 'Shop.yaml'),
    'utf8',
  );
  assert.doesNotMatch(requestFile, /response|folder/);
  assert.match(
    await fs.readFile(path.join(root, 'collections', 'Shop', 'Orders', '_folder.yaml'), 'utf8'),
    /timeoutMs: 1234/,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, 'workspace.legacy.json'), 'utf8')),
    legacy,
    'the workspace as it was is kept beside it',
  );
  // A fresh store, as after a restart, reads the same workspace back from the files.
  assert.deepEqual(await new WorkspaceStore(root).load(), legacy);
});
test('saving after edits changes only the files that changed and removes deleted requests', async (t) => {
  const { root, store } = await setup(t);
  const state = seed('Shop');
  state.requests.push({ ...structuredClone(state.requests[0]), id: 'second', name: 'Second' });
  await store.save(state);
  const first = path.join(root, 'collections', 'Shop', 'Shop.yaml');
  const second = path.join(root, 'collections', 'Shop', 'Second.yaml');
  const before = (await fs.stat(first)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  state.requests = state.requests.filter((request) => request.id !== 'second');
  state.requests[0].url = 'https://example.com/changed';
  await store.save(state);
  assert.ok((await fs.stat(first)).mtimeMs > before, 'the edited request is rewritten');
  await assert.rejects(fs.access(second), /ENOENT/, 'the deleted request file is removed');
  assert.equal((await store.load())!.requests[0].url, 'https://example.com/changed');
});
test('reveal finds a saved folder’s directory, and falls back before anything is saved', async (t) => {
  const { root, store } = await setup(t);
  await store.list();
  assert.equal(await store.revealPath('Shop'), path.join(root, 'workspace.json'));
  const state = seed('Shop');
  state.requests[0].folder = 'Shop/Admin: tools';
  await store.save(state);
  assert.equal(
    await store.revealPath('Shop/Admin: tools'),
    path.join(root, 'collections', 'Shop', 'Admin- tools'),
  );
  assert.equal(await store.revealPath('Shop'), path.join(root, 'collections', 'Shop'));
  assert.equal(await store.revealPath('Missing'), path.join(root, 'collections'));
});

/** Waits for `check` to pass, polling while file events arrive. */
async function eventually<T>(check: () => T | undefined, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a collection change.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function watched(t: { after(callback: () => Promise<void> | void): void }) {
  const context = await setup(t);
  const changes: import('@techieutils/api-workbench-common/types').WorkspaceChange[] = [];
  await context.store.save(seed('Shop'));
  await context.store.load();
  context.store.onWorkspaceChange((change) => changes.push(change));
  t.after(() => context.store.close());
  // A new watcher takes a moment to start (macOS FSEvents), so let it settle before editing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const file = path.join(context.root, 'collections', 'Shop', 'Shop.yaml');
  return { ...context, changes, file };
}
test('a request file edited outside the app is reported; the app’s own saves are not', async (t) => {
  const { store, changes, file } = await watched(t);
  const state = (await store.load())!;
  state.requests[0].url = 'https://example.com/from-app';
  await store.save(state);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(changes.length, 0, 'saving from the app is not an outside change');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('from-app', 'from-editor'));
  const change = await eventually(() => changes.at(-1));
  assert.ok('state' in change);
  assert.equal(change.state.requests[0].url, 'https://example.com/from-editor');
});
test('a save that crosses an outside edit keeps the edit on disk until the app applies it', async (t) => {
  const { store, changes, file } = await watched(t);
  const stale = (await store.load())!;
  await fs.writeFile(
    file,
    (await fs.readFile(file, 'utf8')).replace(/^url: .*$/m, 'url: https://example.com/editor'),
  );
  stale.requests[0].url = 'https://example.com/stale-app';
  await store.save(stale);
  assert.match(await fs.readFile(file, 'utf8'), /editor/, 'the outside edit is not overwritten');
  const change = await eventually(() => changes.find((item) => 'state' in item));
  assert.ok('state' in change);
  assert.equal(change.state.requests[0].url, 'https://example.com/editor');
  // Until the app confirms it applied the change, its saves leave the files alone.
  await store.save(stale);
  assert.match(await fs.readFile(file, 'utf8'), /editor/);
  store.workspaceChangeApplied(change.sequence);
  const applied = (await store.load())!;
  applied.requests[0].name = 'Renamed in app';
  await store.save(applied);
  assert.match(
    await fs.readFile(path.join(path.dirname(file), 'Renamed in app.yaml'), 'utf8'),
    /editor/,
  );
});
test('invalid YAML is reported, and saving never overwrites the file being fixed', async (t) => {
  const { store, changes, file } = await watched(t);
  const state = (await store.load())!;
  await fs.writeFile(file, 'name: [unclosed\n');
  const change = await eventually(() => changes.find((item) => 'error' in item));
  assert.ok('error' in change);
  assert.match(change.error, /Shop\.yaml/);
  state.requests[0].url = 'https://example.com/while-broken';
  await store.save(state);
  assert.equal(await fs.readFile(file, 'utf8'), 'name: [unclosed\n');
});
test('a request file added by hand gets an id line, and the rest of it is kept as written', async (t) => {
  const { root, changes } = await watched(t);
  const added = path.join(root, 'collections', 'Shop', 'Added.yaml');
  const text = '# written by hand\nname: Added\nurl: https://example.com/added\n';
  await fs.writeFile(added, text);
  const change = await eventually(() => changes.find((item) => 'state' in item));
  assert.ok('state' in change);
  const request = change.state.requests.find((item) => item.name === 'Added')!;
  assert.equal(await fs.readFile(added, 'utf8'), `id: ${request.id}\n${text}`);
});
test('workspace.json edited outside the app is reported; the app’s own saves are not', async (t) => {
  const { root, store, changes } = await watched(t);
  const workspaceFile = path.join(root, 'workspace.json');
  const state = (await store.load())!;
  state.history = [];
  await store.save(state);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(changes.length, 0, 'saving from the app is not an outside change');
  const saved = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
  saved.environments[0].variables = [{ key: 'host', value: 'edited.example.com', enabled: true }];
  await fs.writeFile(workspaceFile, JSON.stringify(saved, null, 2));
  const change = await eventually(() => changes.find((item) => 'state' in item));
  assert.ok('state' in change);
  assert.equal(change.state.environments[0].variables[0].value, 'edited.example.com');
  assert.equal(change.state.requests.length, 1, 'the collections come along unchanged');
});
test('a save that crosses an outside edit of workspace.json keeps the edit', async (t) => {
  const { root, store, changes } = await watched(t);
  const workspaceFile = path.join(root, 'workspace.json');
  const stale = (await store.load())!;
  const saved = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
  saved.environments[0].name = 'Edited outside';
  await fs.writeFile(workspaceFile, JSON.stringify(saved));
  stale.environments[0].name = 'Stale in app';
  await store.save(stale);
  assert.match(await fs.readFile(workspaceFile, 'utf8'), /Edited outside/);
  const change = await eventually(() => changes.find((item) => 'state' in item));
  assert.ok('state' in change);
  assert.equal(change.state.environments[0].name, 'Edited outside');
  store.workspaceChangeApplied(change.sequence);
  const applied = (await store.load())!;
  applied.environments[0].name = 'After applying';
  await store.save(applied);
  assert.match(await fs.readFile(workspaceFile, 'utf8'), /After applying/);
});
test('invalid JSON in workspace.json is reported and never overwritten', async (t) => {
  const { root, store, changes } = await watched(t);
  const workspaceFile = path.join(root, 'workspace.json');
  const state = (await store.load())!;
  await fs.writeFile(workspaceFile, '{"environments": [');
  const change = await eventually(() => changes.find((item) => 'error' in item));
  assert.ok('error' in change);
  state.history = [];
  await store.save(state);
  assert.equal(await fs.readFile(workspaceFile, 'utf8'), '{"environments": [');
});
async function indexWatched(t: { after(callback: () => Promise<void> | void): void }) {
  const context = await setup(t);
  await context.store.save(seed('First'), 'default');
  const second = await context.store.create('Second', seed('Second'));
  const changes: import('@techieutils/api-workbench-common/types').WorkspaceIndexChange[] = [];
  context.store.onIndexChange((change) => changes.push(change));
  t.after(() => context.store.close());
  await new Promise((resolve) => setTimeout(resolve, 300));
  const indexFile = path.join(context.root, 'workspaces.json');
  const edit = async (
    change: (index: import('@techieutils/api-workbench-common/types').WorkspaceIndex) => void,
  ) => {
    const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    change(index);
    await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
  };
  return { ...context, second, changes, indexFile, edit };
}
test('workspaces.json edited outside the app is reported, and saves keep the edit', async (t) => {
  const { store, second, changes, edit, indexFile } = await indexWatched(t);
  await store.save(seed('First'), 'default');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(changes.length, 0, 'the app’s own index writes are not reported');
  await edit((index) => {
    index.workspaces.find((item) => item.id === second.id)!.name = 'Renamed outside';
  });
  const change = await eventually(() => changes.find((item) => 'index' in item));
  assert.ok('index' in change);
  assert.equal(
    change.index.workspaces.find((item) => item.id === second.id)!.name,
    'Renamed outside',
  );
  await store.save(seed('First'), 'default');
  const saved = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.equal(
    saved.workspaces.find((item: { id: string }) => item.id === second.id).name,
    'Renamed outside',
  );
});
test('the open workspace stays open and listed when workspaces.json switches or removes it', async (t) => {
  const { store, second, changes, edit } = await indexWatched(t);
  await edit((index) => {
    index.activeId = second.id;
    index.workspaces = index.workspaces.filter((item) => item.id !== 'default');
  });
  const change = await eventually(() => changes.find((item) => 'index' in item));
  assert.ok('index' in change);
  assert.equal(change.index.activeId, 'default');
  assert.deepEqual(
    change.index.workspaces.map((item) => item.id).sort(),
    ['default', second.id].sort(),
  );
  assert.match(change.warning!, /is open, so it stays/);
  assert.equal(store.activeId, 'default');
  await store.save(seed('Still saving'), 'default');
  assert.equal((await store.load('default'))!.requests[0].name, 'Still saving');
});
test('invalid JSON in workspaces.json is reported once and never overwritten', async (t) => {
  const { store, changes, indexFile } = await indexWatched(t);
  await fs.writeFile(indexFile, '{"workspaces": [');
  const change = await eventually(() => changes.find((item) => 'error' in item));
  assert.ok('error' in change);
  await store.save(seed('First'), 'default');
  await store.save(seed('First'), 'default');
  assert.equal(await fs.readFile(indexFile, 'utf8'), '{"workspaces": [');
  assert.equal(
    changes.filter((item) => 'error' in item).length,
    1,
    'the same broken file is reported once',
  );
});

test('new workspaces go in the storage folder, each in a folder of its own, with the vault left in app data', async (t) => {
  const { root, store } = await setup(t);
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-storage-'));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const before = await store.storage();
  assert.deepEqual(before, { appData: root, current: root });

  const info = await store.setStorageFolder(elsewhere);
  assert.equal(info.storageFolder, elsewhere);
  const shop = await store.create('Shop: API?', seed('Shop'));
  assert.equal(
    shop.location,
    path.join(elsewhere, 'Shop API'),
    'the name is made safe for a folder',
  );
  await fs.access(path.join(shop.location!, 'workspace.json'));
  await fs.access(path.join(shop.location!, 'collections'));
  assert.equal(
    store.vaultPath(shop.id),
    path.join(root, 'workspaces', shop.id, 'credentials.enc'),
    'credentials stay in app data',
  );
  // The same name again never overwrites: it gets the next free folder.
  const again = await store.create('Shop: API?', seed('Again'));
  assert.equal(again.location, path.join(elsewhere, 'Shop API 2'));
  // App data on request, for one workspace.
  const local = await store.create('Local', seed('Local'), null);
  assert.equal(local.location, undefined);
  await fs.access(path.join(root, 'workspaces', local.id, 'workspace.json'));

  // A restart reads the workspace from its folder.
  const reopened = new WorkspaceStore(root);
  assert.equal((await reopened.load(shop.id))!.requests[0].name, 'Shop');
  assert.equal((await reopened.list()).storageFolder, elsewhere);
  await reopened.activate(shop.id);
  assert.equal((await reopened.storage()).current, shop.location);

  // Removing it keeps the person's files; only the app's copy goes.
  await reopened.activate('default');
  await reopened.delete(shop.id);
  await fs.access(path.join(shop.location!, 'workspace.json'));

  // Back to app data.
  assert.equal((await reopened.setStorageFolder(undefined)).storageFolder, undefined);
  assert.equal((await reopened.create('Later', seed('Later'))).location, undefined);
});

test('a storage folder inside app data is refused, and an unreachable one falls back to app data', async (t) => {
  const { root, store } = await setup(t);
  await assert.rejects(store.setStorageFolder(path.join(root, 'workspaces')), /outside/);
  await assert.rejects(store.setStorageFolder(root), /outside/);
  await assert.rejects(store.setStorageFolder('relative/folder'), /full path/);
  const blocked = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-blocked-'));
  t.after(() => fs.rm(blocked, { recursive: true, force: true }));
  // A file where the folder should be stands in for an unplugged drive.
  const gone = path.join(blocked, 'drive');
  await store.setStorageFolder(gone);
  await fs.rm(gone, { recursive: true, force: true });
  await fs.writeFile(gone, 'not a folder');
  assert.match((await store.storage()).storageProblem!, /cannot be reached/);
  const created = await store.create('Offline', seed('Offline'));
  assert.equal(created.location, undefined, 'it is saved in app data instead');
  await assert.rejects(store.create('Chosen', seed('Chosen'), gone), /cannot be written/);
});

test('workspace scripts are saved with the workspace, as text only', async (t) => {
  const { root, store } = await setup(t);
  const state = seed('Shop');
  state.workspaceScripts = { pre: "aw.vars.set('stamp', Date.now());\n" };
  await store.save(state);
  assert.deepEqual((await new WorkspaceStore(root).load())!.workspaceScripts, {
    pre: "aw.vars.set('stamp', Date.now());\n",
  });
  // Something other than text, written by hand, is not kept as a script.
  const file = path.join(root, 'workspace.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.workspaceScripts = { pre: { code: 'x' } };
  await fs.writeFile(file, JSON.stringify(saved));
  assert.equal((await new WorkspaceStore(root).load())!.workspaceScripts, undefined);
});

test('library modules are saved as scripts/<name>.js and read back, with files added by hand', async (t) => {
  const { root, store } = await setup(t);
  const state = seed('Shop');
  state.scriptLibrary = [
    { name: 'signing', source: 'exports.sign = (text) => text;\n' },
    { name: 'format', source: 'module.exports = {};\n' },
  ];
  await store.save(state);
  assert.equal(
    await fs.readFile(path.join(root, 'scripts', 'signing.js'), 'utf8'),
    'exports.sign = (text) => text;\n',
  );
  const saved = JSON.parse(await fs.readFile(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(saved.scriptLibrary, undefined, 'modules live in their own files');
  await fs.writeFile(path.join(root, 'scripts', 'dates.js'), 'exports.now = () => 1;\n');
  await fs.writeFile(path.join(root, 'scripts', 'not a module.js'), 'ignored');
  const loaded = (await new WorkspaceStore(root).load())!;
  assert.deepEqual(
    loaded.scriptLibrary?.map((module) => module.name),
    ['dates', 'format', 'signing'],
  );
  // Removing a module removes its file.
  loaded.scriptLibrary = loaded.scriptLibrary!.filter((module) => module.name !== 'format');
  const reopened = new WorkspaceStore(root);
  await reopened.load();
  await reopened.save(loaded);
  await assert.rejects(fs.access(path.join(root, 'scripts', 'format.js')), /ENOENT/);
});

test('saved snippets are kept with the workspace, valid ones only', async (t) => {
  const { root, store } = await setup(t);
  const state = seed('Shop');
  state.scriptSnippets = [{ id: 's1', title: 'Ours', places: ['post'], code: 'aw.log(1);' }];
  await store.save(state);
  assert.deepEqual((await new WorkspaceStore(root).load())!.scriptSnippets, state.scriptSnippets);
  const file = path.join(root, 'workspace.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.scriptSnippets = [{ id: 's1', title: '', places: ['post'], code: 'x' }];
  await fs.writeFile(file, JSON.stringify(saved));
  assert.equal((await new WorkspaceStore(root).load())!.scriptSnippets, undefined);
});
