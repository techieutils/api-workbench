import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { refusedHost, refusedHosts } from './hosts';
import { CliError, builtInEngine, processEngine, runCli, type Runtime } from './cli';
import { buildTree, requestsUnder, type Source } from './model';
import { outcomes, selectionArgs } from './report';
import { renderResponse } from './response';
import { mockDetailsView, mockLine, responseView } from './views';
import { mockUpdate, newRouteDraft } from './mock-edit';
import { credentialFrom } from './credentials';
import { runnerResults, updateArgs, updatePlan } from './editing';
import { requestView } from './views';
import { newRequestArgs } from './new-request';
import { graphqlParts } from './graphql';
import { graphqlCompletions } from './graphql-schema';
import { Workbench } from './workbench';
import { STOP_LINE, liveEvent, liveUpdatePlan, sendLine, type LiveEvent } from './live';

// What the extension does, against the real command line it ships (the CLI package's bundle), a
// team folder and an app data folder written by the app's own WorkspaceStore, and a local API.

const cliPath = path.resolve(__dirname, '../../../api-workbench-cli/dist/api-workbench.cjs');
const runtime: Runtime = {
  command: process.execPath,
  env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  version: process.versions.node,
};
let root: string;
let server: Server;
let team: Source;
let bench: Workbench;
let base: string;

const SPEC = `openapi: 3.0.0
info:
  title: Shop API
  version: '1'
paths:
  /orders:
    get:
      summary: List orders
      responses:
        '200':
          $ref: '#/components/responses/Missing'
`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const request = (id: string, extra: Partial<ApiRequest>): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: '{{base_url}}/users',
  folder: 'Users',
  params: [],
  headers: [],
  body: '',
  auth: 'None',
  token: '',
  username: '',
  password: '',
  tests: 'status 200',
  response: null,
  ...extra,
});

before(async () => {
  server = createServer((incoming, response) => {
    const missing = incoming.url?.startsWith('/missing');
    response.writeHead(missing ? 404 : 200, {
      'content-type': 'application/json',
      'x-signed': String(incoming.headers['x-signed'] ?? ''),
      // What auth came with the request, to check a saved credential was applied.
      'x-auth': String(incoming.headers.authorization ?? ''),
    });
    response.end(JSON.stringify(missing ? { error: 'no' } : { users: [{ id: 1, name: 'Ada' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const state: WorkspaceState = {
    requests: [
      request('list', { name: 'List users', tags: ['smoke'] }),
      request('one', { name: 'Get user', url: '{{base_url}}/users/1' }),
      request('miss', { name: 'Missing', url: '{{base_url}}/missing', folder: 'Users/Errors' }),
      request('signed', {
        name: 'Signed',
        folder: 'Scripted',
        scripts: { pre: "aw.request.headers.set('X-Signed', 'yes');" },
      } as Partial<ApiRequest>),
      request('socket', {
        name: 'Socket',
        protocol: 'websocket',
        url: 'ws://127.0.0.1:1',
        folder: 'Live',
      } as Partial<ApiRequest>),
    ],
    tabs: ['list'],
    active: 'list',
    environments: [
      { name: 'Local', variables: [{ enabled: true, key: 'base_url', value: base }] },
      {
        name: 'Nowhere',
        variables: [{ enabled: true, key: 'base_url', value: 'http://127.0.0.1:9' }],
      },
    ],
    environment: 0,
    history: [],
    specs: [{ id: 'shop', name: 'Shop API', format: 'yaml', content: SPEC }],
    mocks: [
      {
        id: 'mock',
        name: 'Shop mock',
        port: await freePort(),
        cors: false,
        routes: [
          {
            id: 'r1',
            enabled: true,
            method: 'GET',
            path: '/orders',
            status: 200,
            headers: [],
            body: '[]',
            delayMs: 0,
          },
        ],
      },
    ],
  } as WorkspaceState;
  root = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-workbench-'));
  const store = new WorkspaceStore(path.join(root, 'data'));
  await store.list();
  await store.save(state, 'default');
  await store.openFolder(path.join(root, 'team'), state, 'Ada', 'share');
  store.close();
  team = { kind: 'team', folder: path.join(root, 'team'), name: 'team' };
  bench = new Workbench(processEngine(runtime, cliPath), path.join(root, 'data'));
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test('the command line reports its version', async () => {
  assert.match(await bench.version(), /^\d+\.\d+\.\d+/);
});

test('a team folder lists its collections, requests, and environments', async () => {
  const list = await bench.list(team);
  assert.deepEqual(list.environments, ['Local', 'Nowhere']);
  const tree = buildTree(list);
  assert.deepEqual(
    tree.map((node) => node.name),
    ['Users', 'Scripted', 'Live'],
  );
  // In the explorer's order, as runs send them: a collection's folders come before its own requests.
  assert.deepEqual(
    requestsUnder(tree[0]).map((r) => r.name),
    ['Missing', 'List users', 'Get user'],
  );
  assert.equal(tree[0].children[0].kind === 'folder' && tree[0].children[0].path, 'Users/Errors');
  assert.equal(list.requests.find((r) => r.id === 'socket')?.runnable, false);
  const environments = await bench.environments(team);
  assert.equal(environments.find((environment) => environment.active)?.name, 'Local');
});

test('the app’s workspaces are listed, with team folders’ paths', async () => {
  const workspaces = await bench.appWorkspaces();
  assert.ok(workspaces.some((workspace) => workspace.id === 'default'));
  assert.ok(workspaces.some((workspace) => workspace.folder === path.join(root, 'team')));
  // No app data at all is no workspaces, not an error.
  const empty = new Workbench(processEngine(runtime, cliPath), path.join(root, 'no-data-here'));
  assert.deepEqual(await empty.appWorkspaces(), []);
});

test('a request is sent, and its response rendered', async () => {
  const result = await bench.send(team, 'list', { environment: 'Local' });
  assert.equal(result.status, 200);
  assert.equal(result.passed, true);
  const text = renderResponse(result, 'GET');
  assert.match(
    text,
    /^200 OK · \d+ ms · \d+ B · HTTP\/1\.1\nGET http:\/\/127\.0\.0\.1:\d+\/users\n/,
  );
  assert.match(text, /✓ status 200/);
  assert.match(text, /"name": "Ada"/);

  const failed = await bench.send(team, 'miss', { environment: 'Local' });
  assert.equal(failed.passed, false, 'a failing test is a result, not an error');
  assert.equal(failed.status, 404);

  const unreachable = await bench.send(team, 'list', { environment: 'Nowhere' });
  assert.ok(unreachable.error);
  await assert.rejects(bench.send(team, 'list', { environment: 'Nope' }), (error: CliError) => {
    assert.equal(error.code, 2);
    assert.match(error.message, /No environment “Nope”/);
    return true;
  });
});

test('runs send the chosen requests, and report each one', async () => {
  const list = await bench.list(team);
  const plain = list.requests.filter((r) => r.folder.startsWith('Users'));
  const { report, output } = await bench.run(team, {
    selection: selectionArgs(plain, list.requests)!,
    environment: 'Local',
  });
  assert.deepEqual(report.results.map((result) => result.request.id).sort(), [
    'list',
    'miss',
    'one',
  ]);
  const found = outcomes(report);
  assert.equal(found.get('list')?.state, 'passed');
  assert.equal(found.get('miss')?.state, 'failed');
  assert.deepEqual(found.get('miss')?.messages, ['status 200 — Actual status: 404']);
  assert.match(output, /3 requests: 2 passed, 1 failed/);

  // A tag narrows the run, as --tag does.
  const tagged = await bench.run(team, {
    selection: [],
    environment: 'Local',
    tags: ['smoke'],
    scripts: 'skip',
  });
  assert.deepEqual(
    tagged.report.results.map((result) => result.request.id),
    ['list'],
  );
});

test('requests with scripts wait for a choice, then run with or without them', async () => {
  const selection = ['-r', 'signed'];
  await assert.rejects(bench.run(team, { selection, environment: 'Local' }), (error: CliError) => {
    assert.ok(error.needsScriptChoice, error.message);
    return true;
  });
  const allowed = await bench.send(team, 'signed', { environment: 'Local', scripts: 'allow' });
  assert.equal(allowed.headers?.['x-signed'], 'yes', 'the pre-request script ran');
  const skipped = await bench.send(team, 'signed', { environment: 'Local', scripts: 'skip' });
  assert.equal(skipped.headers?.['x-signed'], '', 'it did not');
});

test('a request is copied as cURL', async () => {
  const curl = await bench.curl(team, 'list', 'Local');
  assert.match(curl, /^curl /);
  assert.match(curl, /127\.0\.0\.1:\d+\/users/);
  assert.doesNotMatch(curl, /note:/, 'the command line’s note goes to standard error');
});

test('a request of a .http file is sent, shown, and turned into code without a workspace', async () => {
  const file = path.join(root, 'users.http');
  await writeFile(
    file,
    `@base = ${base}\n\n### List users\nGET {{base}}/users\nAccept: application/json\n\n### Missing\nGET {{base}}/missing\n`,
  );
  const result = await bench.sendFile(file, '1', {});
  assert.equal(result.status, 200);
  assert.match(result.body ?? '', /"Ada"/);
  const view = responseView(result);
  assert.equal(view.status, '200 OK');
  assert.equal(view.json, true);
  const missing = await bench.sendFile(file, '2', {});
  assert.equal(missing.status, 404);
  const details = await bench.showRequest({ file }, '1');
  assert.equal(details.name, 'List users');
  assert.deepEqual(
    details.headers.map((h) => h.key),
    ['Accept'],
  );
  const code = await bench.code({ file }, '1', 'python', 'requests');
  assert.match(code.code, /import requests/);
  assert.ok((await bench.codeTargets({ file })).some((target) => target.id === 'shell'));
  // A collection file is only read.
  await assert.rejects(
    runCli(runtime, cliPath, ['request', 'delete', '1', '--file', file, '--yes']),
    /not an option/,
  );
});

test('a saved request is shown for the request editor', async () => {
  const details = await bench.showRequest({ source: team }, 'list');
  assert.equal(details.name, 'List users');
  assert.deepEqual(details.tests, ['status 200']);
  assert.deepEqual(details.tags, ['smoke']);
});

test('a request is saved from a .http file into a collection', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const created = await bench.createRequest(app, [
    'From file',
    '--collection=Saved',
    '--method=POST',
    '--url={{base_url}}/users',
    '--header=Content-Type: application/json',
    '--body=-{"leading dash": true}',
  ]);
  assert.equal(created.name, 'From file');
  const saved = await bench.showRequest({ source: app }, created.id);
  assert.equal(saved.url, '{{base_url}}/users');
  assert.equal(saved.method, 'POST');
});

test('specifications are listed, checked, and generate collections', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const [spec] = await bench.specs(app);
  assert.equal(spec.name, 'Shop API');
  assert.equal(spec.errors, 1);
  const analysis = await bench.lintSpec({ source: app, id: spec.id });
  assert.equal(analysis.problems[0].line, 11);
  assert.equal(await bench.exportSpec(app, spec.id), SPEC.trimEnd() + '\n');
  // A file on disk is checked with no workspace at all.
  const file = path.join(root, 'shop.openapi.yaml');
  await writeFile(file, SPEC);
  const alone = new Workbench(processEngine(runtime, cliPath), path.join(root, 'no-data-here'));
  const fromFile = await alone.lintSpec({ file });
  assert.match(fromFile.problems[0].message, /Missing/);
  assert.match(
    await bench.generateFromSpec(app, file, { collection: 'Shop' }),
    /Generated 1 request in “Shop”/,
  );
});

test('a mock server is served until it is stopped, logging each request', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const [mock] = await bench.mocks(app);
  assert.equal(mock.routes, 1);
  const lines: string[] = [];
  let started: (url: string) => void;
  const url = new Promise<string>((resolve) => (started = resolve));
  const process = bench.startMock(app, mock.id, (line) => {
    lines.push(line);
    const parsed = mockLine(line);
    if (parsed && 'started' in parsed) started(parsed.started);
  });
  const served = await url;
  assert.equal(served, `http://127.0.0.1:${mock.port}`);
  const answer = await fetch(`${served}/orders`);
  assert.equal(answer.status, 200);
  // The log line comes after the answer.
  for (let tries = 0; tries < 50 && !lines.some((line) => /GET\s+\/orders/.test(line)); tries++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const entry = lines.map(mockLine).find((parsed) => parsed && 'entry' in parsed);
  assert.deepEqual(entry && 'entry' in entry && [entry.entry.method, entry.entry.status], [
    'GET',
    '200',
  ]);
  process.stop();
  assert.equal((await process.exited).code, 0);
});

test('history lists the sends kept in one of the app’s workspaces', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  await bench.send(app, 'list', { environment: 'Local' });
  const [latest] = await bench.history(app);
  assert.equal(latest.request, 'List users');
  assert.equal(latest.status, 200);
});

test('a request is edited and saved from the request editor', async () => {
  const created = await bench.createRequest(team, [
    'Draft',
    '--collection=Edits',
    `--url=${base}/users`,
  ]);
  const before = requestView(await bench.showRequest({ source: team }, created.id), {
    hasFile: true,
  });
  const draft = structuredClone(before.saved);
  draft.method = 'PUT';
  draft.url = `${base}/users/2?verbose=1`;
  draft.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
  draft.body = '{"name":"Grace"}';
  draft.bodyType = 'raw';
  await bench.updateRequest(team, created.id, updateArgs(before.saved, draft));
  const after = requestView(await bench.showRequest({ source: team }, created.id), {
    hasFile: true,
  });
  assert.deepEqual(after.saved, draft);
  assert.deepEqual(updateArgs(after.saved, draft), [], 'nothing is left to save');
  const sent = await bench.send(team, created.id, { environment: 'Local' });
  assert.equal(sent.request.method, 'PUT');
  assert.match(sent.url ?? '', /\/users\/2\?verbose=1$/);
  await bench.deleteRequest(team, created.id);
  assert.ok(!(await bench.list(team)).requests.some((r) => r.id === created.id));
});

test('collections are created, renamed, exported, and deleted', async () => {
  await bench.createCollection(team, 'Scratch');
  await bench.renameCollection(team, 'Scratch', 'Scratchpad');
  assert.ok((await bench.list(team)).collections.includes('Scratchpad'));
  const file = path.join(root, 'scratch.postman.json');
  await bench.exportCollection(team, 'Scratchpad', 'postman', file);
  assert.match(await readFile(file, 'utf8'), /"Scratchpad"/);
  await bench.deleteCollection(team, 'Scratchpad');
  assert.ok(!(await bench.list(team)).collections.includes('Scratchpad'));
});

test('environments and their variables are managed, with values kept off the arguments', async () => {
  await bench.createEnvironment(team, 'Staging', 'Local');
  await bench.setVariable(team, 'Staging', 'page', '2 of 3');
  let staging = await bench.environment(team, 'Staging');
  assert.deepEqual(
    staging.variables.map((variable) => `${variable.key}=${variable.value}`),
    [`base_url=${base}`, 'page=2 of 3'],
  );
  await bench.unsetVariable(team, 'Staging', 'page');
  await bench.renameEnvironment(team, 'Staging', 'Stage');
  staging = await bench.environment(team, 'Stage');
  assert.equal(staging.variables.length, 1);
  await bench.deleteEnvironment(team, 'Stage');
  assert.deepEqual(
    (await bench.environments(team)).map((environment) => environment.name),
    ['Local', 'Nowhere'],
  );
});

test('the runner runs a collection several times, and load tests it', async () => {
  const options = {
    collection: 'Users',
    mode: 'collection' as const,
    iterations: 2,
    delayMs: 0,
    bail: false,
    concurrency: 1,
    durationSeconds: 1,
    environment: 'Local',
  };
  const { report } = await bench.runner(team, options);
  assert.equal(report.results?.length, 6, 'three requests, twice');
  const shown = runnerResults(report);
  assert.equal(shown.summary?.[0].value, 'Failed', 'Missing answers 404');
  assert.deepEqual([...new Set(shown.results.map((row) => row.iteration))], ['1', '2']);
  const load = await bench.runner(team, {
    ...options,
    collection: 'Users/Errors',
    mode: 'benchmark',
    iterations: 3,
    concurrency: 2,
  });
  assert.equal(load.report.metrics?.completed, 3);
  assert.ok(runnerResults(load.report).summary?.some((item) => item.label === 'p95'));
});

test('a mock server is made from a specification file and lists its routes', async () => {
  const file = path.join(root, 'pets.yaml');
  await writeFile(
    file,
    'openapi: 3.0.3\ninfo: {title: Pets, version: "1"}\npaths:\n  /pets:\n    get:\n      responses:\n        "200": {description: ok}\n',
  );
  const created = await bench.createMock(team, 'Pets mock', { spec: file });
  assert.equal(created.routes, 1);
  const details = await bench.mock(team, created.id);
  assert.deepEqual(
    details.routes.map((route) => `${route.method} ${route.path} ${route.status}`),
    ['GET /pets 200'],
  );
  assert.ok((await bench.mocks(team)).some((mock) => mock.name === 'Pets mock'));
});

test('a .http request gets values captured before it, through the environment', async () => {
  const file = path.join(root, 'chain.http');
  await writeFile(file, `GET ${base}/users/{{userId}}\n`);
  const sent = await bench.sendFile(file, '1', { variables: { userId: '7', 'bad name': 'x' } });
  assert.match(sent.url ?? '', /\/users\/7$/);
});

test('an app workspace’s cookies are listed and cleared, and its history cleared', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'default' };
  const jar = await bench.cookies(app);
  assert.equal(typeof jar.enabled, 'boolean');
  assert.ok(Array.isArray(jar.cookies));
  await bench.clearCookies(app);
  await bench.clearHistory(app);
  assert.deepEqual(await bench.history(app), []);
});

test('a request is made from a cURL command given on standard input', async () => {
  const created = await bench.createRequestFromCurl(
    team,
    `curl ${base}/users/3 -H 'X-Trace: on'`,
    'Users',
  );
  const shown = await bench.showRequest({ source: team }, created.id);
  assert.equal(shown.url, `${base}/users/3`);
  assert.deepEqual(
    shown.headers.map((header) => header.key),
    ['X-Trace'],
  );
  await bench.deleteRequest(team, created.id);
});

test('tests, tags, and captures are saved from the request editor', async () => {
  const before = requestView(await bench.showRequest({ source: team }, 'one'), { hasFile: true });
  const draft = {
    ...structuredClone(before.saved),
    tests: 'status 200\nbody.users exists',
    tags: ['users'],
    captures: [{ key: 'firstUser', value: 'body.users[0].id' }],
  };
  await bench.updateRequest(team, 'one', updateArgs(before.saved, draft));
  const after = requestView(await bench.showRequest({ source: team }, 'one'), { hasFile: true });
  assert.deepEqual(
    [after.saved.tests, after.saved.tags, after.saved.captures],
    [draft.tests, draft.tags, draft.captures],
  );
  await bench.updateRequest(team, 'one', updateArgs(after.saved, before.saved));
});

test('a collection’s docs and specification are made from its requests', async () => {
  assert.match(await bench.collectionDocs(team, 'Users'), /^openapi: 3/m);
  await bench.specFromCollection(team, 'Users', 'Users API');
  assert.ok((await bench.specs(team)).some((spec) => spec.name === 'Users API'));
});

test('the app’s workspaces are created, renamed, and deleted', async () => {
  const created = await bench.createWorkspace('Scratch space');
  await bench.renameWorkspace(created.id, 'Scratch');
  assert.ok((await bench.appWorkspaces()).some((w) => w.id === created.id && w.name === 'Scratch'));
  await bench.deleteWorkspace(created.id);
  assert.ok(!(await bench.appWorkspaces()).some((w) => w.id === created.id));
});

test('a team folder in Git shows its status, and commits', async (t) => {
  const folder = (team as { folder: string }).folder;
  const git = (args: string[]) =>
    runCliGit(args, folder).catch(() => {
      t.skip('git is not installed');
      return undefined;
    });
  if ((await git(['init', '-q', '-b', 'main'])) === undefined) return;
  await git(['config', 'user.name', 'Test Person']);
  await git(['config', 'user.email', 'test@example.invalid']);
  const status = await bench.team(team, 'status');
  assert.equal(status.status.repository, true);
  assert.ok(status.status.changeCount > 0);
  const committed = await bench.team(team, 'commit', { message: 'Add the API' });
  assert.equal(committed.status.changeCount, 0);
});

function runCliGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

test('auth and a form body are saved from the request editor, their secrets off the arguments', async () => {
  const before = requestView(await bench.showRequest({ source: team }, 'one'), { hasFile: true });
  const draft = structuredClone(before.saved);
  draft.auth = { ...draft.auth, type: 'Bearer token', secret: '{{token}}' };
  draft.bodyType = 'form-data';
  draft.form = [{ key: 'name', value: 'Ada', enabled: true }];
  const plan = updatePlan(before.saved, draft);
  await bench.updateRequest(team, 'one', plan.args, { input: plan.input, env: plan.env });
  const after = requestView(await bench.showRequest({ source: team }, 'one'), { hasFile: true });
  assert.equal(after.saved.auth.type, 'Bearer token');
  assert.equal(after.saved.auth.secret, '', 'the token never comes back');
  assert.equal(after.hasSecret, true);
  assert.equal(after.saved.bodyType, 'form-data');
  assert.deepEqual(after.saved.form, draft.form);
  const sent = await bench.send(team, 'one', { environment: 'Local' });
  assert.equal(sent.status, 200);
  const reset = updatePlan(after.saved, { ...before.saved, auth: { ...before.saved.auth } });
  await bench.updateRequest(team, 'one', reset.args, { input: reset.input });
});

test('OAuth 2.0 is set up from the request editor, and its token got through a browser sign-in', async (t) => {
  let exchanged = '';
  const identity = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      exchanged = body;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ access_token: 'issued-9', token_type: 'Bearer', expires_in: 600 }),
      );
    });
  });
  await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
  t.after(() => identity.close());
  const issuer = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const { id } = await bench.createRequest(app, [
    'Signed in',
    '--collection=OAuth',
    `--url=${base}/users/1`,
  ]);
  const before = requestView(await bench.showRequest({ source: app }, id), { hasFile: false });
  const draft = structuredClone(before.saved);
  const port = await freePort();
  draft.auth = {
    ...draft.auth,
    type: 'OAuth 2.0 (request)',
    options: {
      oauth2GrantType: 'authorization_code',
      oauth2AuthorizationUrl: `${issuer}/authorize`,
      oauth2TokenUrl: `${issuer}/token`,
      oauth2ClientId: 'vscode-test',
      oauth2ClientAuth: 'none',
      oauth2CallbackPort: String(port),
    },
    secrets: {},
  };
  const plan = updatePlan(before.saved, draft);
  await bench.updateRequest(app, id, plan.args, { env: plan.env });
  const opened: string[] = [];
  const result = await bench.requestToken(app, id, {}, (url) => {
    opened.push(url);
    // The browser, once the person has signed in.
    const address = new URL(url);
    const back = new URL(address.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'code-1');
    back.searchParams.set('state', address.searchParams.get('state')!);
    void fetch(back);
  });
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith(`${issuer}/authorize?`));
  assert.match(exchanged, /grant_type=authorization_code/);
  assert.ok(result.expiresAt! > Date.now());
  const after = requestView(await bench.showRequest({ source: app }, id), { hasFile: false });
  assert.deepEqual(after.savedSecrets, ['token']);
  assert.ok(after.tokenExpiresAt! > Date.now());
  assert.equal(after.saved.auth.options.oauth2ClientId, 'vscode-test');
  const sent = await bench.send(app, id, { save: false });
  assert.equal(sent.headers?.['x-auth'], 'Bearer issued-9');
  // A token endpoint that refuses says why, and nothing is kept.
  const refused = structuredClone(after.saved);
  refused.auth.options = { ...refused.auth.options, oauth2GrantType: 'client_credentials' };
  const again = updatePlan(after.saved, refused);
  await bench.updateRequest(app, id, again.args, { env: again.env });
  await assert.rejects(
    bench.requestToken(app, id, {}, () => undefined),
    /client secret/,
  );
});

test('a request’s scripts are saved from an editor and removed when emptied', async () => {
  const script = "aw.request.headers.set('X-Signed', 'yes');\n";
  await bench.saveScript(team, 'one', 'pre', script);
  let shown = await bench.showRequest({ source: team }, 'one');
  assert.deepEqual(shown.scripts, { pre: script, post: '' });
  const view = requestView(shown, { hasFile: true });
  assert.equal(view.scripts.pre, script);
  // Saving never runs it: the send still waits for the scripts choice.
  await assert.rejects(bench.send(team, 'one', {}), (error: CliError) => error.needsScriptChoice);
  await bench.saveScript(team, 'one', 'pre', '');
  shown = await bench.showRequest({ source: team }, 'one');
  assert.deepEqual(shown.scripts, { pre: '', post: '' });
});

test('a WebSocket request is connected, sent messages, and stopped', async (t) => {
  const { WebSocketServer } = await import('ws');
  const { WorkspaceStore: Store } = await import('@techieutils/api-workbench-electron/workspaces');
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => sockets.once('listening', resolve));
  // The server always closes, so a failure here never keeps the other tests waiting.
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  });
  sockets.on('connection', (socket) =>
    socket.on('message', (message) => socket.send(`echo ${message}`)),
  );
  const port = (sockets.address() as AddressInfo).port;
  const folder = path.join(root, 'live');
  const store = new Store(path.join(root, 'live-data'));
  await store.list();
  await store.openFolder(
    folder,
    {
      requests: [
        request('ticker', {
          name: 'Ticker',
          protocol: 'websocket',
          url: `ws://127.0.0.1:${port}`,
          folder: 'Live',
          tests: '',
        } as Partial<ApiRequest>),
      ],
      tabs: [],
      active: 'ticker',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'Ada',
    'share',
  );
  store.close();
  const live: Source = { kind: 'team', folder, name: 'live' };
  const events: LiveEvent[] = [];
  let opened: () => void = () => undefined;
  const open = new Promise<void>((resolve) => (opened = resolve));
  let echoed: () => void = () => undefined;
  const echo = new Promise<void>((resolve) => (echoed = resolve));
  const connection = bench.connect(live, 'ticker', {}, (line) => {
    const event = liveEvent(line);
    if (!event) return;
    events.push(event);
    if (event.type === 'open') opened();
    if (event.type === 'message' && event.data === 'echo hi') echoed();
  });
  await open;
  const line = sendLine({ message: 'hi' });
  assert.ok('line' in line);
  connection.write(line.line);
  await echo;
  connection.write(STOP_LINE);
  assert.equal((await connection.exited).code, 0);
  assert.deepEqual(
    // The handshake's headers come as metadata, and connecting comes first; the rest in order.
    events.map((event) => event.type).filter((type) => !['connecting', 'metadata'].includes(type)),
    ['open', 'sent', 'message', 'closed'],
  );
});

test('a Socket.IO request is connected and sent an event from the live editor', async (t) => {
  const { Server } = await import('socket.io');
  const { WorkspaceStore: Store } = await import('@techieutils/api-workbench-electron/workspaces');
  const web = createServer();
  const io = new Server(web);
  io.on('connection', (socket) =>
    socket.on('chat', (value: unknown) => socket.emit('chat', value)),
  );
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await io.close();
  });
  const folder = path.join(root, 'io');
  const store = new Store(path.join(root, 'io-data'));
  await store.list();
  await store.openFolder(
    folder,
    {
      requests: [
        request('chat', {
          name: 'Chat',
          protocol: 'socketio',
          url: `http://127.0.0.1:${(web.address() as AddressInfo).port}`,
          folder: 'Live',
          tests: '',
          socketio: { path: '/socket.io', event: 'chat', ack: false },
        } as Partial<ApiRequest>),
      ],
      tabs: [],
      active: 'chat',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'Ada',
    'share',
  );
  store.close();
  const events: LiveEvent[] = [];
  let echoed: () => void = () => undefined;
  const echo = new Promise<void>((resolve) => (echoed = resolve));
  let opened: () => void = () => undefined;
  const open = new Promise<void>((resolve) => (opened = resolve));
  const connection = bench.connect({ kind: 'team', folder, name: 'io' }, 'chat', {}, (line) => {
    const event = liveEvent(line);
    if (!event) return;
    events.push(event);
    if (event.type === 'open') opened();
    if (event.type === 'message' && event.event === 'chat') echoed();
  });
  await open;
  const line = sendLine({ message: '{"text":"hi"}', options: { event: 'chat' } }, 'socketio');
  assert.ok('line' in line);
  connection.write(line.line);
  await echo;
  connection.write(STOP_LINE);
  assert.equal((await connection.exited).code, 0);
  assert.ok(events.some((event) => event.type === 'sent' && event.event === 'chat'));
});

test('a live request’s URL, headers, message, and settings are saved from its editor', async () => {
  const details = await bench.showRequest({ source: team }, 'socket');
  const view = requestView(details, { hasFile: true });
  const saved = {
    url: view.saved.url,
    headers: view.saved.headers,
    auth: view.saved.auth,
    body: details.bodyText ?? '',
    settings: {},
  };
  const draft = structuredClone(saved);
  draft.url = 'ws://127.0.0.1:2/feed';
  draft.headers.push({ key: 'X-Room', value: 'blue', enabled: true });
  draft.body = '{"subscribe":"prices"}';
  const plan = liveUpdatePlan(saved, draft);
  await bench.updateRequest(team, 'socket', plan.args, plan);
  const after = await bench.showRequest({ source: team }, 'socket');
  assert.equal(after.url, 'ws://127.0.0.1:2/feed');
  assert.equal(after.bodyText, '{"subscribe":"prices"}');
  assert.ok(after.headers.some((header) => header.key === 'X-Room'));
  assert.equal(after.protocol, 'websocket', 'it stays a WebSocket request');
  // A WebSocket has no protocol settings to save.
  await assert.rejects(
    bench.updateRequest(team, 'socket', [], { settings: { mqtt: {} } }),
    (error: CliError) => error.code === 2,
  );
});

test('inside VS Code, the built-in engine gives the command line’s results with no process', async (t) => {
  assert.throws(
    () => builtInEngine(path.join(root, 'missing.cjs'), require),
    (error: CliError) => /missing/.test(error.message),
  );
  const inside = new Workbench(builtInEngine(cliPath, require), path.join(root, 'data'));
  assert.equal(await inside.version(), await bench.version());
  assert.deepEqual(await inside.list(team), await bench.list(team));
  const sent = await inside.send(team, 'list', { environment: 'Local' });
  assert.equal(sent.status, 200);
  const failed = await inside.send(team, 'miss', { environment: 'Local' });
  assert.equal(failed.status, 404, 'a failing test is a result, not an error');
  await assert.rejects(
    inside.send(team, 'list', { environment: 'Nope' }),
    (error: CliError) => error.code === 2 && /No environment “Nope”/.test(error.message),
  );
  const { report } = await inside.run(team, {
    selection: [],
    environment: 'Local',
    scripts: 'skip',
  });
  assert.equal(report.summary.requests, 4);
  // Standard input reaches a command as a process's would.
  const created = await inside.createRequestFromCurl(team, `curl ${base}/users/9`, 'Users');
  assert.equal((await inside.showRequest({ source: team }, created.id)).url, `${base}/users/9`);
  await inside.deleteRequest(team, created.id);
  // A command that keeps running stops when asked.
  const { WebSocketServer } = await import('ws');
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => sockets.once('listening', resolve));
  sockets.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo ${m}`)));
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  });
  const folder = path.join(root, 'live');
  // The WebSocket request of the earlier live test, pointed at this server.
  await inside.updateRequest({ kind: 'team', folder, name: 'live' }, 'ticker', [
    `--url=ws://127.0.0.1:${(sockets.address() as AddressInfo).port}`,
  ]);
  const events: LiveEvent[] = [];
  let echoed: () => void = () => undefined;
  const echo = new Promise<void>((resolve) => (echoed = resolve));
  const connection = inside.connect(
    { kind: 'team', folder, name: 'live' },
    'ticker',
    {},
    (line) => {
      const event = liveEvent(line);
      if (!event) return;
      events.push(event);
      if (event.type === 'open') {
        const sent = sendLine('hi');
        if ('line' in sent) connection.write(sent.line);
      }
      if (event.type === 'message' && event.data === 'echo hi') echoed();
    },
  );
  await echo;
  connection.stop();
  assert.equal((await connection.exited).code, 0);
  assert.equal(events.at(-1)?.type, 'closed');
});

test('an app workspace’s request is sent with its saved credential, given the vault’s password', async () => {
  const { WorkbenchVault } = await import('@techieutils/api-workbench-electron/workbench-vault');
  const password = 'Correct horse 9 battery';
  const vault = new WorkbenchVault(path.join(root, 'data', 'vault-key.json'), {
    cost: { N: 1024, r: 8, p: 1 },
  });
  await vault.setup(password);
  vault.lock();
  const app: Source = { kind: 'app', id: 'default', name: 'default' };
  await bench.setSecret(
    app,
    { name: 'Users API', type: 'bearer', origin: base, secret: 'vault-secret-7' },
    password,
  );
  const [credential] = await bench.secrets(app, password);
  await bench.updateRequest(app, 'one', ['--auth=credential', `--credential=${credential.id}`]);
  const sent = await bench.send(app, 'one', { environment: 'Local', save: false, password });
  assert.equal(sent.status, 200);
  assert.equal(sent.headers?.['x-auth'], 'Bearer vault-secret-7');
  const { report } = await bench.run(app, {
    selection: ['-r', 'one'],
    environment: 'Local',
    scripts: 'skip',
    password,
  });
  assert.equal(report.passed, true);
  // Without the password, the vault stays locked and the result says so.
  const locked = await bench.send(app, 'one', { environment: 'Local', save: false });
  assert.match(locked.error ?? '', /vault is locked/i);
  await bench.updateRequest(app, 'one', ['--auth=none']);
});

test('a team folder the app has open is sent with its saved credential, chosen in VS Code', async () => {
  // The vault the previous test set up; the team folder is open in the same app data.
  const password = 'Correct horse 9 battery';
  const linked: Source = { ...team, inApp: true } as Source;
  await bench.setSecret(
    linked,
    { name: 'Team API', type: 'bearer', origin: base, secret: 'team-secret-5' },
    password,
  );
  const [credential] = (await bench.secrets(linked, password)).filter(
    (item) => item.name === 'Team API',
  );
  await bench.updateRequest(linked, 'one', ['--auth=credential', `--credential=${credential.id}`]);
  const shown = await bench.showRequest({ source: linked }, 'one');
  assert.equal(shown.authDetails?.credentialId, credential.id, 'the choice is read back');
  const sent = await bench.send(linked, 'one', { environment: 'Local', password });
  assert.equal(sent.headers?.['x-auth'], 'Bearer team-secret-5');
  // The shared folder never holds the choice.
  const folder = (team as { folder: string }).folder;
  for (const file of await readdir(folder, { recursive: true })) {
    const full = path.join(folder, String(file));
    if ((await stat(full)).isFile())
      assert.doesNotMatch(await readFile(full, 'utf8'), new RegExp(credential.id), String(file));
  }
  await bench.updateRequest(linked, 'one', ['--auth=none']);
});

test('a GraphQL request is made from the New Request page, saved as the app keeps it, and sent', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const created = await bench.createRequest(
    app,
    newRequestArgs({
      workspace: 'app:default',
      protocol: 'graphql',
      folder: 'GraphQL',
      name: 'Who am I',
      method: 'POST',
      url: `${base}/graphql`,
      tags: [],
    }),
  );
  const shown = await bench.showRequest({ source: app }, created.id);
  assert.equal(shown.protocol, 'http');
  assert.equal(shown.method, 'POST');
  assert.equal(shown.bodyType, 'raw');
  assert.ok(graphqlParts(shown.bodyText ?? ''), 'a body the editor shows as a query');
  assert.ok(
    shown.headers.some(
      (header) => header.key === 'Content-Type' && header.value === 'application/json',
    ),
  );
  const sent = await bench.send(app, created.id, { save: false });
  assert.equal(sent.status, 200);
});

test('a GraphQL request’s schema is fetched with its auth, for the Query’s suggestions', async (t) => {
  let auth: string | undefined;
  const graphql = createServer((incoming, response) => {
    auth = incoming.headers.authorization;
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: {
            __schema: {
              queryType: { name: 'Query' },
              types: [
                {
                  kind: 'OBJECT',
                  name: 'Query',
                  fields: [
                    {
                      name: 'me',
                      args: [],
                      type: { kind: 'OBJECT', name: 'User' },
                      description: 'Who is signed in',
                    },
                  ],
                },
                {
                  kind: 'OBJECT',
                  name: 'User',
                  fields: [{ name: 'email', args: [], type: { kind: 'SCALAR', name: 'String' } }],
                },
              ],
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => graphql.listen(0, '127.0.0.1', resolve));
  t.after(() => graphql.close());
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  const { id } = await bench.createRequest(app, [
    'Schema',
    '--collection=GraphQL',
    `--url=http://127.0.0.1:${(graphql.address() as AddressInfo).port}/graphql`,
  ]);
  await bench.updateRequest(app, id, ['--auth=bearer', '--auth-secret-from-env=T'], {
    env: { T: 'schema-token' },
  });
  const schema = await bench.requestSchema(app, id);
  assert.equal(auth, 'Bearer schema-token');
  assert.equal(schema.queryType, 'Query');
  const { items } = graphqlCompletions('{ me { ', 7, schema);
  assert.deepEqual(
    items.map((item) => item.label),
    ['email', '__typename'],
  );
});

test('a mock server’s settings and routes are saved from the mock page', async () => {
  const file = path.join(root, 'orders-mock.yaml');
  await writeFile(
    file,
    'openapi: 3.0.3\ninfo: {title: Orders, version: "1"}\npaths:\n  /orders:\n    get:\n      responses:\n        "200": {description: ok}\n',
  );
  const created = await bench.createMock(team, 'Orders page mock', { spec: file });
  const before = mockDetailsView(await bench.mock(team, created.id)).saved!;
  assert.equal(before.routes.length, 1);
  const draft = structuredClone(before);
  draft.settings.port = await freePort();
  draft.settings.corsOptions.origins = 'http://localhost:5173';
  draft.routes[0].status = 503;
  draft.routes[0].delayMs = 100;
  await bench.updateMock(team, created.id, mockUpdate(before, draft)!);
  const after = mockDetailsView(await bench.mock(team, created.id)).saved!;
  assert.deepEqual(after, draft);
});

test('a route added on the mock page of a mock made from a collection is added to the collection', async () => {
  const created = await bench.createMock(team, 'Users page mock', { collection: 'Users' });
  const before = mockDetailsView(await bench.mock(team, created.id));
  assert.equal(before.fromCollection, 'Users');
  const draft = structuredClone(before.saved!);
  draft.routes.push({
    ...newRouteDraft(draft.routes),
    method: 'DELETE',
    path: '/users/:id',
    status: 204,
    name: 'Remove a user',
  });
  await bench.updateMock(team, created.id, mockUpdate(before.saved!, draft)!);
  const after = mockDetailsView(await bench.mock(team, created.id));
  assert.ok(
    after.routeList?.some((route) => route.method === 'DELETE' && route.path === '/users/:id'),
  );
  const listed = await bench.list(team);
  const added = listed.requests.find((item) => item.name === 'Remove a user');
  assert.deepEqual([added?.method, added?.folder], ['DELETE', 'Users']);
  const shown = await bench.showRequest({ source: team }, added!.id);
  assert.equal(shown.url, '{{base_url}}/users/{{id}}');
});

test('credentials of every kind are saved from the Credentials page, their secrets never coming back', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  // The vault set up with this password by the saved-credential test above.
  const before = await bench.secrets(app, 'Correct horse 9 battery');
  const save = credentialFrom(
    {
      id: 'new',
      name: 'Page AWS',
      type: 'aws',
      origin: 'https://api.example.com',
      values: {
        username: 'AKID',
        secret: 'page-secret-1',
        'options.awsRegion': 'eu-west-1',
        'options.awsService': 's3',
        extraSecret: '',
      },
    },
    before,
  );
  assert.equal(typeof save, 'object');
  await bench.saveCredential(app, save as Exclude<typeof save, string>, 'Correct horse 9 battery');
  const listed = await bench.secrets(app, 'Correct horse 9 battery');
  const row = listed.find((item) => item.name === 'Page AWS');
  assert.deepEqual(
    [row?.type, row?.username, row?.options?.awsRegion, row?.hasSecret],
    ['aws', 'AKID', 'eu-west-1', true],
  );
  assert.doesNotMatch(JSON.stringify(listed), /page-secret-1/);
  await bench.deleteSecret(app, row!.id, 'Correct horse 9 battery');
});

test('a mock page shows whether its collection is in step, and Sync now puts them in step', async () => {
  const created = await bench.createMock(team, 'Synced page mock', { collection: 'Users' });
  let details = mockDetailsView(await bench.mock(team, created.id));
  assert.equal(details.collectionSync?.collection, 'Users');
  // A request added to the collection reaches the mock as it is saved.
  await bench.createRequest(team, [
    'Find user',
    '--collection=Users',
    '--url={{base_url}}/users/find',
  ]);
  details = mockDetailsView(await bench.mock(team, created.id));
  assert.ok(details.saved?.routes.some((route) => route.path === '/users/find'));
  assert.deepEqual(
    [details.collectionSync?.missingRoutes, details.collectionSync?.missingRequests],
    [0, 0],
  );
  const done = await bench.syncMock(team, created.id);
  assert.deepEqual(done, { collection: 'Users', routesAdded: 0, requestsAdded: 0 });
});

test('an environment’s variables are saved from the Environments page, in order and switched', async () => {
  const app: Source = { kind: 'app', id: 'default', name: 'Personal' };
  await bench.createEnvironment(app, 'Page env');
  await bench.updateEnvironment(app, 'Page env', [
    { key: 'base_url', value: 'https://a.example', enabled: true },
    { key: 'debug', value: 'true', enabled: false },
  ]);
  const shown = await bench.environment(app, 'Page env');
  assert.deepEqual(
    shown.variables.map((row) => [row.key, row.value, row.enabled]),
    [
      ['base_url', 'https://a.example', true],
      ['debug', 'true', false],
    ],
  );
  await bench.deleteEnvironment(app, 'Page env');
});

test('a run sends the files chosen in VS Code, and says where to choose a missing one', async () => {
  const folder = path.join(root, 'uploads-team');
  const state = {
    requests: [
      request('import', {
        name: 'Import',
        method: 'POST',
        folder: 'Files',
        bodyType: 'binary',
        binaryName: 'export.csv',
      } as Partial<ApiRequest>),
      request('avatar', {
        name: 'Avatar',
        method: 'POST',
        folder: 'Files',
        bodyType: 'form-data',
        bodyFields: [{ enabled: true, key: 'avatar', value: '', kind: 'file' }],
      } as Partial<ApiRequest>),
    ],
    tabs: [],
    active: 'import',
    environments: [{ name: 'Local', variables: [{ enabled: true, key: 'base_url', value: base }] }],
    environment: 0,
    history: [],
  } as unknown as WorkspaceState;
  const store = new WorkspaceStore(path.join(root, 'uploads-data'));
  await store.list();
  await store.openFolder(folder, state, 'Ada', 'share');
  store.close();
  const source: Source = { kind: 'team', folder, name: 'uploads' };
  const file = path.join(root, 'export.csv');
  await writeFile(file, 'id,name\n1,Ada\n');
  const selection = ['-r', 'import', '-r', 'avatar'];

  // Not chosen: the run says to choose the file in the request's Body tab, not an option.
  const missing = await bench.run(source, { selection, environment: 'Local' });
  assert.deepEqual(
    missing.report.results.map((result) => result.error),
    [
      "This request's body is a file (export.csv): choose its file in the request’s Body tab, then run again.",
      'The form field “avatar” is a file: choose its file in the request’s Body tab, then run again.',
    ],
  );

  // Chosen: both are sent, the file body and the form's file field.
  const sent = await bench.run(source, {
    selection,
    environment: 'Local',
    uploads: { import: { binary: file, fields: {} }, avatar: { fields: { avatar: file } } },
  });
  assert.deepEqual(
    sent.report.results.map((result) => [result.request.id, result.status, result.passed]),
    [
      ['import', 200, true],
      ['avatar', 200, true],
    ],
  );
});

test('a .http file sent from a copy finds its `< ./path` files beside the original', async () => {
  const original = path.join(root, 'http-original');
  const copy = path.join(root, 'http-copy');
  await mkdir(path.join(original, 'data', 'staging'), { recursive: true });
  await mkdir(copy, { recursive: true });
  await writeFile(path.join(original, 'data', 'staging', 'users.csv'), 'id,name\n1,Ada\n');
  // The editor's text, written to a copy elsewhere, as VS Code sends unsaved text.
  const file = path.join(copy, 'upload.http');
  await writeFile(
    file,
    [`@base_url = ${base}`, '', 'POST {{base_url}}/users', '', '< ./data/{{stage}}/users.csv'].join(
      '\n',
    ),
  );
  // Beside the copy there is no such file: without the original's folder, it is not found.
  const lost = await bench.sendFile(file, '1', { variables: { stage: 'staging' } });
  assert.match(lost.error ?? '', /No file/);
  // With it, the path — a captured value filled in — is the original's file.
  const sent = await bench.sendFile(file, '1', {
    variables: { stage: 'staging' },
    baseDir: original,
  });
  assert.equal(sent.error, undefined);
  assert.equal(sent.status, 200);
});

test('a .http file’s {{variables}} come from a workspace’s environment, under its own', async () => {
  const folder = path.join(root, 'http-environment');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'users.http');
  await writeFile(file, ['GET {{base_url}}/users', 'Accept: application/json'].join('\n'));
  // Alone, nothing sets {{base_url}}.
  assert.ok((await bench.sendFile(file, '1', {})).error);
  // The team folder's environment by name, and the one it uses.
  const local = await bench.sendFile(file, '1', { environment: { source: team, name: 'Local' } });
  assert.equal(local.status, 200);
  assert.equal((await bench.sendFile(file, '1', { environment: { source: team } })).status, 200);
  assert.ok(
    (await bench.sendFile(file, '1', { environment: { source: team, name: 'Nowhere' } })).error,
    'Nowhere’s base_url is a closed port',
  );
  // The file's own @variables win over the environment's.
  await writeFile(
    file,
    ['@base_url = http://127.0.0.1:9', '', 'GET {{base_url}}/users'].join('\n'),
  );
  assert.ok(
    (await bench.sendFile(file, '1', { environment: { source: team, name: 'Local' } })).error,
  );
});

test('a .http file sends only to the hosts allowed, and says which host it was refused', async () => {
  const file = path.join(root, 'hosts.http');
  // Through a variable, as most files write it: the command line checks the filled-in URL.
  await writeFile(
    file,
    `@base = ${base.replace('127.0.0.1', 'localhost')}\n\nGET {{base}}/users\n`,
  );
  const sent = await bench.sendFile(file, '1', { allowedHosts: [] });
  assert.equal(sent.status, 200, 'this computer never asks');
  const elsewhere = path.join(root, 'elsewhere.http');
  await writeFile(elsewhere, '@base = http://api.example.invalid\n\nGET {{base}}/users\n');
  await assert.rejects(
    bench.sendFile(elsewhere, '1', { allowedHosts: ['other.example.com'] }),
    (error: unknown) =>
      error instanceof CliError && error.refusedHost === 'api.example.invalid' && error.code === 2,
  );
  // Allowed, it is sent (and fails only because the host does not exist).
  const tried = await bench.sendFile(elsewhere, '1', { allowedHosts: ['api.example.invalid'] });
  assert.ok(tried.error && !/--allow-host/.test(tried.error), tried.error ?? 'no error');
});

test('a team folder sends and runs only to the hosts allowed, and names those it did not', async () => {
  const folder = path.join(root, 'hosts-team');
  // One request to this computer, through the environment, and one to a host elsewhere.
  const state = {
    requests: [
      request('local', { name: 'Local' }),
      request('away', { name: 'Away', url: 'http://api.example.invalid/users' }),
    ],
    tabs: [],
    active: 'local',
    environments: [{ name: 'Local', variables: [{ enabled: true, key: 'base_url', value: base }] }],
    environment: 0,
    history: [],
  } as unknown as WorkspaceState;
  const store = new WorkspaceStore(path.join(root, 'hosts-data'));
  await store.list();
  await store.openFolder(folder, state, 'Ada', 'share');
  store.close();
  const source: Source = { kind: 'team', folder, name: 'hosts' };

  const local = await bench.send(source, 'local', { environment: 'Local', allowedHosts: [] });
  assert.equal(local.status, 200, 'this computer never asks');
  await assert.rejects(
    bench.send(source, 'away', { environment: 'Local', allowedHosts: [] }),
    (error: unknown) => error instanceof CliError && error.refusedHost === 'api.example.invalid',
  );
  // A run sends what it may and names the hosts it did not send to, for one question.
  const selection = ['-r', 'local', '-r', 'away'];
  const run = await bench.run(source, { selection, environment: 'Local', allowedHosts: [] });
  assert.deepEqual(
    run.report.results.map((result) => result.status ?? 'unsent'),
    [200, 'unsent'],
  );
  assert.deepEqual(refusedHosts(run.report.results), ['api.example.invalid']);
  const again = await bench.run(source, {
    selection,
    environment: 'Local',
    allowedHosts: ['api.example.invalid'],
  });
  assert.deepEqual(refusedHosts(again.report.results), [], 'allowed, it is sent');
  // Without the list, as for the app's own workspaces, nothing is checked.
  assert.deepEqual(
    refusedHosts((await bench.run(source, { selection, environment: 'Local' })).report.results),
    [],
  );
});

test('a live request connects only to the hosts allowed, and names the one it did not', async () => {
  const folder = path.join(root, 'live-hosts');
  const store = new WorkspaceStore(path.join(root, 'live-hosts-data'));
  await store.list();
  await store.openFolder(
    folder,
    {
      requests: [
        request('away', {
          name: 'Away',
          protocol: 'websocket',
          url: 'wss://live.example.invalid/socket',
          folder: 'Live',
        } as Partial<ApiRequest>),
      ],
      tabs: [],
      active: 'away',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'Ada',
    'share',
  );
  store.close();
  const source: Source = { kind: 'team', folder, name: 'live-hosts' };
  const refused = await bench.connect(source, 'away', { allowedHosts: [] }, () => undefined).exited;
  assert.equal(refused.code, 2);
  assert.equal(refusedHost(refused.message ?? ''), 'live.example.invalid');
  // Allowed, it tries to connect (and fails only because the host does not exist).
  const tried = await bench.connect(
    source,
    'away',
    { allowedHosts: ['live.example.invalid'] },
    () => undefined,
  ).exited;
  assert.equal(refusedHost(tried.message ?? ''), undefined);
});

test('a run says where it would go before sending anything, for tests and the Runner', async () => {
  const folder = path.join(root, 'preflight-team');
  const state = {
    requests: [
      request('local', { name: 'Local' }),
      request('away', { name: 'Away', url: 'https://{{region}}.example.invalid/users' }),
      request('captured', { name: 'Captured', url: 'https://{{next_host}}/page' }),
    ],
    tabs: [],
    active: 'local',
    environments: [
      {
        name: 'Local',
        variables: [
          { enabled: true, key: 'base_url', value: base },
          { enabled: true, key: 'region', value: 'eu' },
        ],
      },
    ],
    environment: 0,
    history: [],
  } as unknown as WorkspaceState;
  const store = new WorkspaceStore(path.join(root, 'preflight-data'));
  await store.list();
  await store.openFolder(folder, state, 'Ada', 'share');
  store.close();
  const source: Source = { kind: 'team', folder, name: 'preflight' };
  const selection = ['-r', 'local', '-r', 'away', '-r', 'captured'];
  const expected = {
    hosts: ['127.0.0.1', 'eu.example.invalid'],
    unresolved: [{ request: 'Captured', url: 'https://{{next_host}}/page' }],
  };
  assert.deepEqual(await bench.runHosts(source, { selection, environment: 'Local' }), expected);
  assert.deepEqual(
    await bench.runnerHosts(source, {
      collection: '',
      mode: 'collection',
      iterations: 1,
      delayMs: 0,
      bail: false,
      concurrency: 1,
      durationSeconds: 10,
      environment: 'Local',
    }),
    expected,
  );
  // That nothing is sent is checked against a server in the command line's own specs.
});
