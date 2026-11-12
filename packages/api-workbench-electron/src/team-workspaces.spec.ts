import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './workspaces';
import { TeamPresenceService, STALE_MS } from './team-presence';
import { joinTeamState, sharedURL, splitTeamState } from './team-files';
import { trimHistory } from '@techieutils/api-workbench-common/history';
import type {
  ApiRequest,
  TeamPresenceChange,
  WorkspaceChange,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';

/** Team workspaces: two people, each with their own app data, sharing one folder. */

const request = (id: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: 'https://api.example.com/orders',
  folder: 'Orders',
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
});
const seed = (): WorkspaceState => ({
  requests: [
    request('list', {
      url: 'https://api.example.com/orders?api_key=TEST-QUERY-KEY&page=2',
      auth: 'Bearer token',
      token: 'TEST-INLINE-TOKEN',
      headers: [
        { enabled: true, key: 'X-Api-Key', value: 'TEST-HEADER-KEY' },
        { enabled: true, key: 'Authorization', value: 'Bearer {{token}}' },
        { enabled: true, key: 'Accept', value: 'application/json' },
      ],
      httpSettings: { proxyUsername: 'proxy-user', proxyPassword: 'TEST-PROXY-PASSWORD' },
    }),
    request('create', { method: 'POST', auth: 'Saved credential', credentialId: 'vault-entry' }),
  ],
  active: 'list',
  tabs: ['list', 'create'],
  environments: [
    {
      name: 'Staging',
      variables: [
        { enabled: true, key: 'base_url', value: 'https://staging.example.com' },
        { enabled: true, key: 'client_secret', value: 'TEST-ENV-SECRET' },
        { enabled: true, key: 'token', value: '{{login_token}}' },
      ],
    },
    { name: 'Production', variables: [] },
  ],
  environment: 1,
  history: [
    {
      requestId: 'list',
      method: 'GET',
      url: 'https://api.example.com/orders?token=TEST-HISTORY-TOKEN',
      status: 200,
      date: '2026-11-01T10:00:00.000Z',
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'set-cookie': 'session=TEST-COOKIE', 'content-type': 'application/json' },
        body: '[]',
        size: 2,
      },
    },
  ],
  settings: { theme: 'dark' } as WorkspaceState['settings'],
  collectionAuth: {
    Orders: {
      auth: 'Basic auth',
      token: '',
      username: 'ada',
      password: 'TEST-COLLECTION-PASSWORD',
    },
  },
});
async function person(t: { after(callback: () => Promise<void> | void): void }, name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `api-workbench-${name}-`));
  const store = new WorkspaceStore(root);
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.list();
  return { root, store };
}
async function folder(t: { after(callback: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-team-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function eventually<T>(read: () => T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a change.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** Every file under a folder, as text, for checking what was shared. */
async function allText(directory: string): Promise<string> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')),
  );
  return texts.join('\n');
}

test('secrets, personal state, and saved-credential links stay out of the team folder', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  const entry = await ada.store.openFolder(team, seed(), 'Ada', 'share');
  assert.equal(entry.folder, team);
  const shared = await allText(team);
  for (const secret of [
    'TEST-QUERY-KEY',
    'TEST-INLINE-TOKEN',
    'TEST-HEADER-KEY',
    'TEST-PROXY-PASSWORD',
    'TEST-ENV-SECRET',
    'TEST-COLLECTION-PASSWORD',
    'TEST-HISTORY-TOKEN',
    'TEST-COOKIE',
    'vault-entry',
    '"theme"',
  ])
    assert.ok(!shared.includes(secret), `${secret} is not shared`);
  for (const kept of ['Bearer {{token}}', '{{login_token}}', 'page=2', 'base_url', 'ada'])
    assert.ok(shared.includes(kept), `${kept} is shared`);
  assert.ok(
    (await fs.readdir(path.join(team, 'environments'))).includes('Staging.yaml'),
    'environments have files of their own',
  );

  // Ada still has everything after a restart.
  await ada.store.activate(entry.id);
  const again = (await ada.store.load(entry.id))!;
  const list = again.requests.find((item) => item.id === 'list')!;
  assert.equal(list.token, 'TEST-INLINE-TOKEN');
  assert.equal(list.url, 'https://api.example.com/orders?api_key=TEST-QUERY-KEY&page=2');
  assert.equal(list.headers[0].value, 'TEST-HEADER-KEY');
  assert.equal(list.httpSettings?.proxyPassword, 'TEST-PROXY-PASSWORD');
  assert.equal(again.requests.find((item) => item.id === 'create')!.credentialId, 'vault-entry');
  assert.equal(again.environments[0].variables[1].value, 'TEST-ENV-SECRET');
  assert.equal(again.environments[again.environment].name, 'Production');
  assert.equal(again.collectionAuth?.Orders.password, 'TEST-COLLECTION-PASSWORD');
  assert.equal(again.settings?.theme, 'dark');
  assert.deepEqual(again.tabs, ['list', 'create']);
});

test('a teammate joins, sees shared changes and history, and never gets the secrets', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  const sam = await person(t, 'sam');
  const shared = await ada.store.openFolder(team, seed(), 'Ada', 'share');
  await ada.store.activate(shared.id);

  const joined = await sam.store.openFolder(team, seed(), 'Sam', 'open');
  assert.equal(joined.name, shared.name);
  const samState = (await sam.store.activate(joined.id))!;
  const list = samState.requests.find((item) => item.id === 'list')!;
  assert.equal(list.token, '');
  assert.equal(list.headers[0].value, '');
  assert.equal(list.headers[1].value, 'Bearer {{token}}');
  assert.equal(list.url, 'https://api.example.com/orders?api_key=&page=2');
  assert.equal(samState.requests.find((item) => item.id === 'create')!.credentialId, undefined);
  assert.equal(samState.environments[0].variables[1].value, '');
  assert.deepEqual(samState.tabs, [], 'tabs are personal');
  const history = samState.history[0];
  assert.equal(history.author?.name, 'Ada', 'teammates’ history is marked with who sent it');
  assert.ok(!history.url.includes('TEST-HISTORY-TOKEN'));
  assert.equal(history.response?.headers['set-cookie'], '<redacted>');

  // Sam fills in their own secret and edits a request; Ada sees the edit, not the secret.
  const changes: WorkspaceChange[] = [];
  ada.store.onWorkspaceChange((change) => changes.push(change));
  samState.environments[0].variables[1].value = 'SAM-OWN-SECRET';
  samState.requests.find((item) => item.id === 'create')!.url = 'https://api.example.com/v2/orders';
  await sam.store.save(samState, joined.id);
  const change = await eventually(() => changes.find((item) => 'state' in item));
  assert.ok('state' in change);
  assert.equal(
    change.state.requests.find((item) => item.id === 'create')!.url,
    'https://api.example.com/v2/orders',
  );
  assert.equal(
    change.state.environments[0].variables[1].value,
    'TEST-ENV-SECRET',
    'Ada keeps her own secret',
  );
  assert.ok(!(await allText(team)).includes('SAM-OWN-SECRET'));

  // Sam's own history goes to Sam's file; Ada's stays Ada's.
  samState.history = [
    {
      requestId: 'create',
      method: 'POST',
      url: 'https://api.example.com/v2/orders',
      status: 201,
      date: '2026-11-02T10:00:00.000Z',
    },
    ...samState.history,
  ];
  await sam.store.save(samState, joined.id);
  const histories = await fs.readdir(path.join(team, 'history'));
  assert.equal(histories.length, 2, 'one history file per person');
  const reloaded = (await sam.store.load(joined.id))!;
  assert.deepEqual(
    reloaded.history.map((entry) => entry.author?.name ?? 'me'),
    ['me', 'Ada'],
  );
});

test('edits to different requests and environments from two people both survive', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  const sam = await person(t, 'sam');
  const entry = await ada.store.openFolder(team, seed(), 'Ada', 'share');
  const adaState = (await ada.store.activate(entry.id))!;
  const joined = await sam.store.openFolder(team, seed(), 'Sam', 'open');
  const samState = (await sam.store.activate(joined.id))!;

  adaState.requests.find((item) => item.id === 'list')!.name = 'List orders (Ada)';
  adaState.environments[0].variables.push({ enabled: true, key: 'region', value: 'eu' });
  samState.requests.find((item) => item.id === 'create')!.name = 'Create order (Sam)';
  samState.environments[1].variables.push({ enabled: true, key: 'region', value: 'us' });
  await ada.store.save(adaState, entry.id);
  await sam.store.save(samState, joined.id);

  const final = (await ada.store.load(entry.id))!;
  const names = final.requests.map((item) => item.name).sort();
  assert.ok(names.includes('Create order (Sam)'), JSON.stringify(names));
  assert.equal(final.environments[1].variables.at(-1)?.value, 'us');
});

test('opening and sharing folders is checked, and leaving keeps the shared folder', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  await assert.rejects(ada.store.openFolder(ada.root, seed(), 'Ada', 'open'), /outside/);
  await assert.rejects(
    ada.store.openFolder('relative/path', seed(), 'Ada', 'open'),
    /Choose a folder/,
  );
  await assert.rejects(ada.store.openFolder(team, seed(), '', 'open'), /name/);
  const other = await folder(t);
  await fs.writeFile(path.join(other, 'workspace.json'), '{"requests":[]}');
  await assert.rejects(ada.store.openFolder(other, seed(), 'Ada', 'open'), /not an API Workbench/);

  const entry = await ada.store.openFolder(team, seed(), 'Ada', 'share');
  assert.equal((await ada.store.openFolder(team, seed(), 'Ada', 'open')).id, entry.id);
  await assert.rejects(ada.store.openFolder(team, seed(), 'Ada', 'share'), /already/);
  assert.equal((await ada.store.member()).name, 'Ada');

  await ada.store.delete(entry.id);
  assert.ok(!(await ada.store.list()).workspaces.some((item) => item.id === entry.id));
  await fs.access(path.join(team, 'workspace.json'));
  await fs.access(path.join(team, 'collections'));
  await assert.rejects(fs.access(path.join(ada.root, 'workspaces', entry.id)));
});

test('split and join round-trip, and teammates’ values win over stale secrets', () => {
  const state = seed();
  const { shared, local } = splitTeamState(state);
  const joined = joinTeamState(shared, 'Team', local, state.history);
  assert.deepEqual(joined.requests, state.requests);
  assert.deepEqual(joined.environments, state.environments);
  // A teammate replaced the inline token with a variable: theirs is kept.
  shared.requests[0].token = '{{token}}';
  assert.equal(joinTeamState(shared, 'Team', local, []).requests[0].token, '{{token}}');
  assert.equal(
    sharedURL('https://user:pw@x.test/a?token={{t}}&key=1'),
    'https://x.test/a?token={{t}}&key=1',
  );
  // Your history limit counts only your entries.
  const mine = { requestId: 'a', method: 'GET', url: 'u', date: 'd' };
  const theirs = { ...mine, author: { id: 'x', name: 'Sam' } };
  assert.deepEqual(trimHistory([theirs, mine, theirs, mine], 1), [theirs, mine, theirs]);
});

test('presence shows teammates and the request they are on, and drops stale ones', async (t) => {
  const team = await folder(t);
  const changes: TeamPresenceChange[] = [];
  let now = Date.now();
  const ada = new TeamPresenceService(
    (change) => changes.push(change),
    () => now,
  );
  const sam = new TeamPresenceService(() => {});
  t.after(async () => {
    await ada.stop();
    await sam.stop();
  });
  const adaMember = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada' };
  const samMember = { id: '22222222-2222-4222-8222-222222222222', name: 'Sam' };
  await ada.start('w', team, adaMember);
  await sam.start('w', team, samMember);
  await sam.update('list', 'List orders');
  await ada.read();
  const seen = changes.at(-1)!;
  assert.deepEqual(
    seen.others.map((item) => [item.member.name, item.requestName]),
    [['Sam', 'List orders']],
  );
  now += STALE_MS + 1000;
  await ada.read();
  assert.deepEqual(changes.at(-1)!.others, [], 'a teammate who stopped updating is dropped');
  await sam.stop();
  assert.deepEqual(await fs.readdir(path.join(team, '.workbench/presence')), [
    `${adaMember.id}.json`,
  ]);
  await assert.rejects(ada.start('w', team, { id: '../escape', name: 'x' }), /Invalid member/);
});

test('workspace scripts are shared with teammates in the team folder', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  const sam = await person(t, 'sam');
  const shared = await ada.store.openFolder(
    team,
    { ...seed(), workspaceScripts: { post: "aw.test('json', () => {});\n" } },
    'Ada',
    'share',
  );
  await ada.store.activate(shared.id);
  const file = JSON.parse(await fs.readFile(path.join(team, 'workspace.json'), 'utf8'));
  assert.deepEqual(file.workspaceScripts, { post: "aw.test('json', () => {});\n" });
  const joined = await sam.store.openFolder(team, seed(), 'Sam', 'open');
  assert.deepEqual((await sam.store.activate(joined.id))!.workspaceScripts, {
    post: "aw.test('json', () => {});\n",
  });
});

test('saved snippets are shared with teammates in the team folder', async (t) => {
  const team = await folder(t);
  const ada = await person(t, 'ada');
  const sam = await person(t, 'sam');
  const snippets = [
    { id: 's1', title: 'Team check', places: ['post' as const], code: 'aw.log(1);' },
  ];
  const shared = await ada.store.openFolder(
    team,
    { ...seed(), scriptSnippets: snippets },
    'Ada',
    'share',
  );
  await ada.store.activate(shared.id);
  const joined = await sam.store.openFolder(team, seed(), 'Sam', 'open');
  assert.deepEqual((await sam.store.activate(joined.id))!.scriptSnippets, snippets);
});
