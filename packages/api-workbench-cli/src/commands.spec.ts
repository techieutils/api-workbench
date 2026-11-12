import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import { WorkbenchVault } from '@techieutils/api-workbench-electron/workbench-vault';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { main } from './cli';

/** The workspace commands against an app data folder and a team folder made by the app. */

let root: string;
let data: string;
let team: string;
const PASSWORD = 'Correct horse 9 battery';

const request = (id: string, extra: Partial<ApiRequest>): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: 'https://api.example.com/items',
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
  ...extra,
});
const state = (): WorkspaceState => ({
  requests: [
    request('items', {
      name: 'List items',
      url: '{{base_url}}/items?api_key={{key}}&page=1',
      headers: [
        { enabled: true, key: 'Authorization', value: 'Bearer live-token-123' },
        { enabled: true, key: 'Accept', value: 'application/json' },
      ],
      tests: 'status 200',
    }),
    request('admin', { name: 'Admin users', folder: 'Shop/Admin' }),
  ],
  tabs: ['items'],
  active: 'items',
  environments: [
    {
      name: 'Local',
      variables: [
        { enabled: true, key: 'base_url', value: 'http://127.0.0.1:9' },
        { enabled: true, key: 'api_token', value: 'super-secret' },
      ],
    },
  ],
  environment: 0,
  history: [],
});

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-commands-'));
  data = path.join(root, 'app-data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(state(), 'default');
  team = path.join(root, 'team');
  await store.openFolder(team, state(), 'Ada', 'share');
  store.close();
  // A cheap key derivation keeps the test fast; the command line reads the cost from the file.
  const vault = new WorkbenchVault(path.join(data, 'vault-key.json'), {
    cost: { N: 1024, r: 8, p: 1 },
  });
  await vault.setup(PASSWORD);
  vault.lock();
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function cli(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string; interrupt?: AbortSignal } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { API_WORKBENCH_DATA_DIR: data, ...options.env },
    false,
    options.interrupt,
    { stdin: async () => options.stdin ?? '', password: async () => PASSWORD },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const ok = async (args: string[], options?: Parameters<typeof cli>[1]) => {
  const result = await cli(args, options);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.out}\n${result.err}`);
  return result;
};

test('workspaces are listed, created, renamed, switched, and deleted as in the app', async () => {
  assert.match((await ok(['workspace', 'list'])).out, /\*\s+Personal workspace\s+local\s+default/);
  await ok(['workspace', 'create', 'Billing']);
  await ok(['workspace', 'rename', 'billing', 'Billing API']);
  await ok(['workspace', 'use', 'Billing API']);
  const listed = JSON.parse((await ok(['workspace', 'list', '--json'])).out);
  assert.equal(listed.find((item: { active: boolean }) => item.active).name, 'Billing API');
  assert.equal(
    (await cli(['workspace', 'delete', 'Billing API', '--yes'])).code,
    2,
    'not the active one',
  );
  await ok(['workspace', 'use', 'default']);
  assert.match((await cli(['workspace', 'delete', 'Billing API'])).err, /--yes/);
  await ok(['workspace', 'delete', 'Billing API', '--yes']);
  assert.match(
    (await cli(['workspace', 'use', 'Persnal workspace'])).err,
    /Did you mean “Personal workspace”/,
  );
  assert.match((await ok(['workspace', 'show'])).out, /Collections\s+1\s+Shop/);
});

test('collections are created, renamed with their folders, exported, imported, and deleted', async () => {
  await ok(['collection', 'create', 'Orders']);
  await ok(['collection', 'rename', 'Shop/Admin', 'Shop/Staff']);
  const requests = JSON.parse((await ok(['request', 'list', '--json'])).out);
  assert.deepEqual(requests.map((item: { folder: string }) => item.folder).sort(), [
    'Orders',
    'Shop',
    'Shop/Staff',
  ]);
  const file = path.join(root, 'shop.postman.json');
  await ok(['collection', 'export', 'Shop', '--format', 'postman', '-o', file]);
  const exported = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(exported.info.name, 'Shop');
  assert.match((await cli(['collection', 'import', file])).err, /already has “Shop”.*--into/);
  assert.match(
    (await ok(['collection', 'import', file, '--into', 'Shop copy'])).out,
    /Imported 2 requests .* and 1 environment/,
  );
  assert.match((await ok(['collection', 'list'])).out, /Shop copy\s+2\s+2/);
  await ok(['collection', 'delete', 'Shop copy', '--yes']);
  // The Postman collection's variables came with it, as an environment.
  await ok(['environment', 'delete', 'Shop variables', '--yes']);
  await ok(['collection', 'delete', 'Orders', '--yes']);
  assert.match(
    (await cli(['collection', 'export', 'Shop', '--format', 'postmn'])).err,
    /Did you mean “postman”/,
  );
});

test('environments are managed, and secret-looking values are never printed', async () => {
  await ok(['environment', 'create', 'Staging', '--copy', 'Local']);
  await ok(['environment', 'set', 'Staging', 'base_url=https://staging.example.com', 'api_token'], {
    env: { api_token: 'from-env-456' },
  });
  const shown = (await ok(['environment', 'show', 'Staging'])).out;
  assert.match(shown, /base_url\s+https:\/\/staging.example.com/);
  assert.match(shown, /api_token\s+<hidden>/);
  assert.ok(!shown.includes('from-env-456'));
  await ok(['environment', 'unset', 'Staging', 'api_token']);
  assert.match(
    (await cli(['environment', 'unset', 'Staging', 'base_ur'])).err,
    /Did you mean “base_url”/,
  );
  await ok(['environment', 'rename', 'Staging', 'Stage']);
  // The workspace on disk has what the command set, as the app would read it.
  const store = new WorkspaceStore(data);
  const saved = await store.load('default');
  store.close();
  const names = saved?.environments.map((item) => item.name) ?? [];
  assert.ok(names.includes('Local') && names.includes('Stage'), names.join(', '));
  await ok(['environment', 'delete', 'Stage', '--yes']);
  assert.match((await cli(['environment', 'delete', 'Local', '--yes'])).err, /keeps at least one/);
});

test('requests are shown, and their code generated, with secrets redacted', async () => {
  const shown = (await ok(['request', 'show', 'List items'])).out;
  assert.match(shown, /Authorization: <hidden>/);
  assert.match(shown, /api_key=%3Credacted%3E|api_key=<redacted>|api_key=/);
  assert.ok(!shown.includes('live-token-123'));
  const code = (await ok(['request', 'code', 'List items', '-e', 'Local'])).out;
  assert.match(code, /curl/);
  assert.match(code, /127\.0\.0\.1:9\/items/);
  assert.match(code, /Bearer <REDACTED>/);
  assert.ok(!code.includes('live-token-123'));
  assert.match((await ok(['request', 'code', '--list'])).out, /shell\s+curl/);
  assert.match(
    (await cli(['request', 'code', 'List items', '--lang', 'pyhton'])).err,
    /Did you mean “python”/,
  );
});

test('specifications are imported, linted, and generate a collection', async () => {
  const spec = path.join(root, 'pets.yaml');
  await fs.writeFile(
    spec,
    'openapi: 3.0.3\ninfo:\n  title: Pets\n  version: "1"\npaths:\n  /pets:\n    get:\n      summary: List pets\n      responses:\n        "200":\n          description: ok\n',
  );
  await ok(['spec', 'import', spec]);
  assert.match((await ok(['spec', 'lint', 'Pets'])).out, /Pets: 0 errors/);
  assert.match((await ok(['spec', 'show', 'Pets'])).out, /GET\s+\/pets\s+List pets/);
  await ok(['spec', 'generate', 'Pets']);
  assert.match((await ok(['request', 'list', '-c', 'Pets'])).out, /GET\s+List pets/);
  assert.match((await cli(['spec', 'generate', 'Pets', '--collection', 'Shop'])).err, /--replace/);
  const broken = path.join(root, 'broken.yaml');
  await fs.writeFile(broken, 'openapi: 3.0.3\npaths: {}\n');
  const lint = await cli(['spec', 'lint', broken]);
  assert.equal(lint.code, 1, 'an invalid specification fails, for CI');
  assert.match(lint.err, /error/);
});

test('credentials are saved write-only and listed without their secrets', async () => {
  await ok(
    [
      'secret',
      'set',
      'Shop token',
      '--type',
      'bearer',
      '--origin',
      'https://api.example.com',
      '--stdin',
    ],
    { stdin: 'tok-789\n' },
  );
  const listed = await ok(['secret', 'list']);
  assert.match(listed.out, /Shop token\s+bearer\s+https:\/\/api.example.com/);
  assert.ok(!listed.out.includes('tok-789'));
  // A secret on the command line would end up in shell history and CI logs.
  assert.match(
    (await cli(['secret', 'set', 'X', '--type', 'bearer', '--origin', 'https://a.example'])).err,
    /--stdin or --from-env/,
  );
  await ok(['secret', 'delete', 'Shop token', '--yes']);
  assert.doesNotMatch((await ok(['secret', 'list'])).out, /Shop token/);
  // A vault the app encrypted with the system's store opens only in the app.
  const other = await cli(['secret', 'list', '-w', 'default'], {
    env: { API_WORKBENCH_DATA_DIR: path.join(root, 'keychain') },
  });
  assert.equal(other.code, 2);
  const keychain = path.join(root, 'keychain');
  const store = new WorkspaceStore(keychain);
  await store.list();
  store.close();
  await fs.writeFile(path.join(keychain, 'credentials.enc'), Buffer.from('os-encrypted'));
  assert.match(
    (await cli(['secret', 'list'], { env: { API_WORKBENCH_DATA_DIR: keychain } })).err,
    /only the (desktop )?app can open.*Use the API Workbench vault/,
  );
});

test('a team folder is changed as a teammate would, without secrets or a history file', async () => {
  await ok(['environment', 'set', 'Local', 'base_url=https://team.example.com', '--dir', team]);
  const file = await fs.readFile(path.join(team, 'environments', 'Local.yaml'), 'utf8');
  assert.match(file, /https:\/\/team.example.com/);
  assert.match(
    (await cli(['environment', 'set', 'Local', 'api_token=x', '--dir', team])).err,
    /team folders never hold secret values/,
  );
  const history = await fs.readdir(path.join(team, 'history')).catch(() => []);
  assert.equal(history.length, 1, 'only the teammate who shared it has a history file');
  // Open in the app on this computer, the folder's credentials are the app's, by name only.
  assert.equal((await cli(['secret', 'list', '--dir', team])).code, 0);
  assert.match(
    (await cli(['secret', 'list', '--dir', path.join(root, 'nowhere-team')])).err,
    /workspace\.json/,
  );
});

test('run takes one of the app workspaces, and mock start serves until stopped', async () => {
  const run = await cli(['run', '-w', 'Personal workspace', '-r', 'List items', '-e', 'Local']);
  assert.equal(run.code, 1, 'nothing listens on port 9');
  assert.match(run.out, /API Workbench · Personal workspace/);

  const store = new WorkspaceStore(data);
  const saved = (await store.load('default'))!;
  saved.mocks = [
    {
      id: 'mock-1',
      name: 'Pets mock',
      port: 0,
      cors: false,
      // As the app saves a mock with HTTPS turned off.
      https: { enabled: false },
      routes: [
        {
          id: 'r1',
          enabled: true,
          method: 'GET',
          path: '/pets',
          status: 200,
          body: '[]',
          headers: [],
        },
      ],
    } as unknown as NonNullable<WorkspaceState['mocks']>[number],
  ];
  await store.save(saved, 'default');
  store.close();
  assert.match((await ok(['mock', 'list'])).out, /Pets mock/);
  const interrupt = new AbortController();
  const lines: string[] = [];
  const port = 40000 + Math.floor(Math.random() * 20000);
  const started = main(
    ['mock', 'start', 'Pets mock', '--port', String(port)],
    {
      out: (line) => {
        lines.push(line);
        if (line.startsWith('Mock'))
          void fetch(`http://127.0.0.1:${port}/pets`).then(() =>
            setTimeout(() => interrupt.abort(), 50),
          );
      },
      err: (line) => lines.push(line),
    },
    { API_WORKBENCH_DATA_DIR: data },
    false,
    interrupt.signal,
  );
  assert.equal(await started, 0, lines.join('\n'));
  assert.ok(
    lines.some((line) => /GET\s+\/pets\s+200/.test(line)),
    lines.join('\n'),
  );
  assert.equal(lines.at(-1), 'Stopped.');
});

test('resource help, aliases, and mistakes', async () => {
  assert.match((await ok(['env', '--help'])).out, /api-workbench environment/);
  assert.match((await ok(['collection', 'export', '--help'])).out, /Formats:/);
  assert.match((await cli(['collection', 'lst'])).err, /Did you mean “list”/);
  assert.match((await cli(['environment', 'list', '--bail'])).err, /Unknown option --bail/);
  assert.match((await cli(['environment', 'list', '--yes'])).err, /not an option of this command/);
  assert.match(
    (await cli(['workspace', 'list'], { env: { API_WORKBENCH_DATA_DIR: path.join(root, 'none') } }))
      .err,
    /No API Workbench data/,
  );
});

test('a request is created, sent with its response shown, and kept in History', async () => {
  const server = createServer((incoming, response) => {
    if (incoming.url === '/login') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=s-1; Path=/',
      });
      response.end('{"token":"T-9","user":{"name":"Ada"}}');
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await ok([
      'request',
      'create',
      'Log in',
      '-c',
      'Auth',
      '-X',
      'post',
      '--url',
      `${base}/login`,
      '-H',
      'Accept: application/json',
      '-d',
      '{"user":"ada"}',
      '--tag',
      'auth,smoke',
    ]);
    // A capture, as set up in the app's Vars tab, so the send puts the token in the environment.
    const store = new WorkspaceStore(data);
    const saved = (await store.load('default'))!;
    const login = saved.requests.find((item) => item.name === 'Log in')!;
    assert.equal(login.method, 'POST');
    assert.equal(login.rawContentType, 'application/json');
    assert.deepEqual(login.tags, ['auth', 'smoke'], 'request create --tag tags it');
    login.tests = 'status 200\njson $.user.name equals "Ada"';
    login.captures = [{ enabled: true, key: 'token', value: '$.token' }];
    await store.save(saved, 'default');
    store.close();

    assert.match((await ok(['request', 'show', 'Log in'])).out, /Tags\s+#auth #smoke/);
    const sent = await ok(['request', 'send', 'Log in', '-e', 'Local', '-i']);
    assert.match(sent.out, /^200 OK/);
    assert.match(sent.out, /"name": "Ada"/, 'JSON is indented');
    assert.match(sent.out, /set-cookie: <hidden>/i);
    assert.match(sent.out, /✓ .*status/);
    assert.match(sent.out, /captured token/);
    assert.ok(!sent.out.includes('s-1'), 'cookie values are not printed');

    const body = await ok(['request', 'send', 'Log in', '--body-only', '--no-save']);
    assert.equal(body.out, '{"token":"T-9","user":{"name":"Ada"}}');

    const check = new WorkspaceStore(data);
    const after = (await check.load('default'))!;
    check.close();
    assert.equal(
      after.environments
        .find((item) => item.name === 'Local')
        ?.variables.find((item) => item.key === 'token')?.value,
      'T-9',
      'the captured value is in the environment, as after a send in the app',
    );
    assert.equal(after.history.length, 1, '--no-save kept the second send out of History');
    assert.match(
      (await ok(['history', 'list'])).out,
      /POST\s+200\s+\d+ ms\s+http:\/\/127\.0\.0\.1:\d+\/login/,
    );

    await ok([
      'request',
      'create',
      '--curl',
      `curl -X DELETE ${base}/gone -H 'X-Trace: 1'`,
      '-c',
      'Auth',
    ]);
    const missing = await cli(['request', 'send', 'Auth/DELETE /gone']);
    assert.equal(missing.code, 1, 'a 404 without tests fails, as in a run');
    assert.match(missing.out, /^404 Not Found/);

    await ok(['history', 'clear', '--yes']);
    assert.doesNotMatch((await ok(['history', 'list'])).out, /login/);
    assert.match((await cli(['history', 'clear'])).err, /--yes/);
  } finally {
    server.close();
  }
});

test('the cookie jar is listed without values, and cleared', async () => {
  const store = new WorkspaceStore(data);
  const saved = (await store.load('default'))!;
  saved.cookieJar = {
    enabled: true,
    cookies: [
      {
        name: 'session',
        value: 'secret-session',
        domain: 'api.example.com',
        hostOnly: true,
        path: '/',
        secure: true,
        httpOnly: true,
        created: 0,
      },
      {
        name: 'theme',
        value: 'dark',
        domain: 'example.com',
        hostOnly: false,
        path: '/',
        secure: false,
        httpOnly: false,
        created: 0,
      },
    ],
  };
  await store.save(saved, 'default');
  store.close();
  const listed = await ok(['cookie', 'list']);
  assert.match(listed.out, /api\.example\.com\s+session\s+\/\s+session/);
  assert.ok(!listed.out.includes('secret-session'));
  await ok(['cookie', 'delete', 'theme']);
  assert.doesNotMatch((await ok(['cookie', 'list'])).out, /theme/);
  await ok(['cookie', 'clear', '--yes']);
  assert.equal(JSON.parse((await ok(['cookie', 'list', '--json'])).out).cookies.length, 0);
});

test('documentation and a specification are made from a collection', async () => {
  const docs = (await ok(['collection', 'docs', 'Shop'])).out;
  assert.match(docs, /^openapi: 3/m);
  assert.match(docs, /\/items/);
  const file = path.join(root, 'docs', 'shop.json');
  await ok(['collection', 'docs', 'Shop', '--format', 'swagger', '-o', file]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).swagger, '2.0');
  // Tags: each operation carries its request's and collection's; --tag documents part of it.
  const summaries = (document: {
    paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
  }) => Object.values(document.paths).flatMap((methods) => Object.values(methods));
  const before = summaries(JSON.parse((await ok(['collection', 'docs', 'Shop', '--json'])).out));
  // One operation per path and method, so tag a request whose operation is in the document.
  const documented = before[0].summary;
  const store = new WorkspaceStore(data);
  const saved = (await store.load())!;
  saved.requests.find((request) => request.name === documented)!.tags = ['beta'];
  saved.collectionTags = { Shop: ['public'] };
  await store.save(saved);
  store.close();
  const after = summaries(JSON.parse((await ok(['collection', 'docs', 'Shop', '--json'])).out));
  assert.deepEqual(after.find((operation) => operation.summary === documented)!.tags, [
    'Shop',
    'public',
    'beta',
  ]);
  const only = summaries(
    JSON.parse((await ok(['collection', 'docs', 'Shop', '--json', '--tag', 'beta'])).out),
  );
  assert.deepEqual(
    only.map((operation) => operation.summary),
    [documented],
  );
  assert.equal(
    (await cli(['collection', 'docs', 'Shop', '--tag', 'nothing'])).code,
    2,
    'a tag nothing has is a mistake',
  );
  await ok(['spec', 'create', '-c', 'Shop', '--name', 'Shop API']);
  assert.match((await ok(['spec', 'lint', 'Shop API'])).out, /Shop API: 0 errors/);
});

test('a team folder in a Git repository is committed with the team commands', async (t) => {
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('git', args, { cwd: team }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    );
  try {
    await git(['init', '-q', '-b', 'main']);
  } catch {
    t.skip('git is not installed');
    return;
  }
  await git(['config', 'user.name', 'Test Person']);
  await git(['config', 'user.email', 'test@example.invalid']);
  const status = await ok(['team', 'status', '--dir', team]);
  assert.match(status.out, /main/);
  assert.match(status.out, /added|untracked|modified/);
  assert.match((await ok(['team', 'commit', '-m', 'Add the API', '--dir', team])).out, /Committed/);
  assert.equal(
    (await git(['log', '--format=%an %s'])).trim(),
    'Test Person Add the API',
    'git’s own name is used',
  );
  assert.match((await cli(['team', 'status'])).err, /not a team workspace/);
  assert.match((await cli(['team', 'commit', '--dir', team])).err, /-m/);
});

test('a .http file is read with --file: listed, shown, sent, and turned into code, never changed', async () => {
  const server = createServer((incoming, response) => {
    response.writeHead(incoming.url === '/missing' ? 404 : 200, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ path: incoming.url, method: incoming.method }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const file = path.join(root, 'orders.http');
    const text = `@base = http://127.0.0.1:${port}\n\n### List orders\nGET {{base}}/orders\nAccept: application/json\n\n###\nPOST {{base}}/missing\nContent-Type: application/json\n\n{"a": 1}\n`;
    await fs.writeFile(file, text);
    // No app data is needed for a file.
    const env = { API_WORKBENCH_DATA_DIR: path.join(root, 'nowhere') };
    const listed = JSON.parse(
      (await ok(['request', 'list', '--file', file, '--json'], { env })).out,
    );
    assert.deepEqual(
      listed.map((row: { id: string; name: string }) => [row.id, row.name]),
      [
        ['1', 'List orders'],
        ['2', 'Request 2'],
      ],
    );
    assert.match((await ok(['request', 'show', '1', '--file', file], { env })).out, /Accept/);
    const sent = JSON.parse(
      (await ok(['request', 'send', 'List orders', '--file', file, '--json'], { env })).out,
    );
    assert.equal(sent.status, 200);
    assert.match(sent.body, /"\/orders"/);
    const missing = await cli(['request', 'send', '2', '--file', file, '--json'], { env });
    assert.equal(missing.code, 1, 'a 404 fails, as in a run');
    assert.equal(JSON.parse(missing.out).status, 404);
    assert.match(
      (await ok(['request', 'code', '2', '--file', file], { env })).out,
      /--request 'POST'/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), text, 'the file is unchanged');
    // Only send takes a workspace with --file, for the environment its {{variables}} come from.
    assert.match(
      (await cli(['request', 'show', '1', '--file', file, '--dir', team])).err,
      /not more than one/,
    );
    assert.match(
      (await cli(['request', 'delete', '1', '--file', file, '--yes'])).err,
      /not an option/,
    );
  } finally {
    server.close();
  }
});

test('a specification file is linted with no workspace at all', async () => {
  const spec = path.join(root, 'standalone.yaml');
  await fs.writeFile(spec, 'openapi: 3.0.3\npaths: {}\n');
  const lint = await cli(['spec', 'lint', spec, '--json'], {
    env: { API_WORKBENCH_DATA_DIR: path.join(root, 'nowhere') },
  });
  assert.equal(lint.code, 1);
  assert.ok(JSON.parse(lint.out).problems.length);
});

test('an option given as --name=value may start with a dash', async () => {
  const created = await ok([
    'request',
    'create',
    'Dashed',
    '-c',
    'Shop',
    '--url',
    'https://api.example.com/x',
    '--body=-1',
    '--json',
  ]);
  assert.equal(JSON.parse(created.out).name, 'Dashed');
  assert.match(
    (await cli(['request', 'create', 'Dashed', '-c', 'Shop', '--url', '-x'])).err,
    /needs a value/,
  );
});

test('request update changes a request, keeping headers it does not name', async () => {
  const dir = ['--dir', team];
  const authorization = (shown: { headers: { key: string; value: string }[] }) =>
    shown.headers.find((header) => header.key === 'Authorization')?.value;
  const before = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  await ok([
    'request',
    'update',
    'List items',
    '-X',
    'post',
    '--url=https://api.example.com/items?page=2',
    '-H',
    'accept: text/plain',
    '-H',
    'X-Trace: on',
    '--unset-header',
    'x-missing',
    '-d',
    '{"a":1}',
    ...dir,
  ]);
  const shown = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.equal(shown.method, 'POST');
  assert.equal(shown.url, 'https://api.example.com/items?page=2');
  assert.equal(shown.bodyText, '{"a":1}');
  assert.equal(shown.bodyType, 'raw');
  assert.deepEqual(
    shown.headers.map((header: { key: string }) => header.key),
    ['Authorization', 'accept', 'X-Trace'],
    '-H replaces a header by name, and adds one',
  );
  assert.equal(authorization(shown), authorization(before), 'a header not named is kept');
  assert.equal(
    shown.headers.find((header: { key: string }) => header.key === 'accept').value,
    'text/plain',
  );
  await ok(['request', 'update', 'items', '--unset-header', 'X-Trace', '--no-body', ...dir]);
  const after = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.equal(after.headers.length, 2);
  assert.equal(after.bodyType, 'none');
  assert.equal(
    (await cli(['request', 'update', 'items', '--body', 'x', '--no-body', ...dir])).code,
    2,
  );
  assert.equal((await cli(['request', 'update', 'items', '-X', 'GET 1', ...dir])).code, 2);
});

test('mock create makes a mock from a specification or a collection, and mock show lists its routes', async () => {
  const dir = ['--dir', team];
  const spec = path.join(root, 'pets.yaml');
  await fs.writeFile(
    spec,
    'openapi: 3.0.3\ninfo: {title: Pets, version: "1"}\npaths:\n  /pets:\n    get:\n      responses:\n        "200": {description: ok}\n    post:\n      responses:\n        "201": {description: made}\n',
  );
  const created = JSON.parse(
    (await ok(['mock', 'create', 'Pets mock', '--spec', spec, '--port', '4999', '--json', ...dir]))
      .out,
  );
  assert.equal(created.routes, 2);
  assert.equal(created.port, 4999);
  const shown = JSON.parse((await ok(['mock', 'show', 'Pets mock', '--json', ...dir])).out);
  assert.deepEqual(shown.source, { kind: 'spec', name: 'pets' });
  assert.deepEqual(
    shown.routes.map((route: { method: string; path: string; status: number }) =>
      [route.method, route.path, route.status].join(' '),
    ),
    ['GET /pets 200', 'POST /pets 201'],
  );
  assert.match((await ok(['mock', 'show', 'Pets mock', ...dir])).out, /POST\s+\/pets\s+201/);
  const fromCollection = JSON.parse(
    (await ok(['mock', 'create', 'Shop mock', '-c', 'Shop', '--json', ...dir])).out,
  );
  assert.ok(fromCollection.routes >= 1);
  assert.equal((await cli(['mock', 'create', 'Pets mock', '--spec', spec, ...dir])).code, 2);
  assert.equal((await cli(['mock', 'create', 'Neither', ...dir])).code, 2);
});

test('request update replaces tests, tags, and captures', async () => {
  const dir = ['--dir', team];
  await ok([
    'request',
    'update',
    'items',
    '--tests',
    'status 200\nbody.items exists',
    '--tag',
    'smoke,orders',
    '--capture',
    'firstId=body.items[0].id',
    ...dir,
  ]);
  const shown = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.deepEqual(shown.tests, ['status 200', 'body.items exists']);
  assert.deepEqual(shown.tags, ['smoke', 'orders']);
  assert.deepEqual(shown.captures, [
    { variable: 'firstId', from: 'body.items[0].id', enabled: true },
  ]);
  await ok(['request', 'update', 'items', '--no-tags', '--no-captures', '--tests', '', ...dir]);
  const cleared = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.deepEqual([cleared.tests, cleared.tags, cleared.captures], [[], [], []]);
  assert.equal((await cli(['request', 'update', 'items', '--capture', 'nofrom', ...dir])).code, 2);
  assert.equal(
    (await cli(['request', 'update', 'items', '--tag', 'a', '--no-tags', ...dir])).code,
    2,
  );
});

test('request update sets auth from the environment and a form from standard input', async () => {
  const dir = ['--dir', team];
  await ok(
    [
      'request',
      'update',
      'admin',
      '--auth',
      'api-key',
      '--auth-username',
      'X-API-Key',
      '--auth-secret-from-env',
      'KEY_VALUE',
      '--api-key-in',
      'query',
      '--body-type',
      'x-www-form-urlencoded',
      '--form-fields',
      '-',
      ...dir,
    ],
    {
      env: { KEY_VALUE: '{{api_key}}' },
      stdin: JSON.stringify([
        { key: 'user', value: 'ada', enabled: true },
        { key: 'password', value: 'pw-123', enabled: false },
      ]),
    },
  );
  const shown = JSON.parse((await ok(['request', 'show', 'admin', '--json', ...dir])).out);
  assert.deepEqual(shown.authDetails, {
    type: 'API key',
    username: 'X-API-Key',
    hasSecret: true,
    apiKeyIn: 'query',
    options: { apiKeyIn: 'query' },
    saved: ['token'],
  });
  assert.equal(shown.bodyType, 'x-www-form-urlencoded');
  assert.deepEqual(
    shown.formFields.map((field: { key: string; enabled: boolean }) => [field.key, field.enabled]),
    [
      ['user', true],
      ['password', false],
    ],
  );
  assert.equal(shown.formFields[0].value, 'ada');
  assert.notEqual(shown.formFields[1].value, 'pw-123', 'a secret-looking value is never shown');
  // Sending the hidden value back keeps the field's own.
  await ok(['request', 'update', 'admin', '--form-fields', '-', ...dir], {
    stdin: JSON.stringify([{ key: 'password', value: '<hidden>', enabled: true }]),
  });
  await ok(['request', 'update', 'admin', '--body-type', 'form-data', ...dir]);
  assert.equal((await cli(['request', 'update', 'admin', '--auth', 'oauth', ...dir])).code, 2);
  assert.equal(
    (await cli(['request', 'update', 'admin', '--auth-secret-from-env', 'NOPE_UNSET', ...dir]))
      .code,
    2,
  );
  assert.equal(
    (await cli(['request', 'update', 'admin', '--form-fields', '-', ...dir], { stdin: '{' })).code,
    2,
  );
});

test('request update saves scripts from files, and request show gives them', async () => {
  const dir = ['--dir', team];
  const pre = path.join(root, 'pre.js');
  const empty = path.join(root, 'empty.js');
  await fs.writeFile(pre, "aw.request.headers.set('X-Trace', 'on');\n");
  await fs.writeFile(empty, '');
  await ok(['request', 'update', 'items', '--pre-script-file', pre, ...dir]);
  let shown = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.deepEqual(shown.scripts, { pre: "aw.request.headers.set('X-Trace', 'on');\n", post: '' });
  // A request with a script now waits for a choice before it is sent.
  assert.equal((await cli(['request', 'send', 'items', ...dir])).code, 2);
  await ok(['request', 'update', 'items', '--pre-script-file', empty, ...dir]);
  shown = JSON.parse((await ok(['request', 'show', 'items', '--json', ...dir])).out);
  assert.deepEqual(shown.scripts, { pre: '', post: '' });
});

test('an HTTP request with a saved credential is sent and run with it, from the app’s vault', async (t) => {
  const server = createServer((incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ auth: incoming.headers.authorization ?? null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await ok(
    ['secret', 'set', 'API token', '--type', 'bearer', '--origin', origin, '--from-env', 'TOKEN'],
    { env: { TOKEN: 'vault-token-9' } },
  );
  const [credential] = JSON.parse((await ok(['secret', 'list', '--json'])).out).filter(
    (item: { name: string }) => item.name === 'API token',
  );
  const created = JSON.parse(
    (await ok(['request', 'create', 'Who am I', '-c', 'Shop', '--url', `${origin}/me`, '--json']))
      .out,
  );
  await ok([
    'request',
    'update',
    created.id,
    '--auth',
    'credential',
    '--credential',
    credential.id,
  ]);
  const sent = JSON.parse((await ok(['request', 'send', created.id, '--json'])).out);
  assert.equal(sent.status, 200);
  assert.match(sent.body, /Bearer vault-token-9/);
  const run = await cli(['run', '-w', 'default', '-r', created.id, '--skip-scripts']);
  assert.equal(run.code, 0, run.out + run.err);
  assert.doesNotMatch(run.out, /vault-token-9/, 'the token is never printed');
  // A team folder the app on this computer has open uses its credential choices and vault; the
  // choice is kept on this device, never in the shared folder.
  await ok(['request', 'create', 'Who', '-c', 'Shop', '--url', `${origin}/me`, '--dir', team]);
  await ok(
    [
      'secret',
      'set',
      'Team token',
      '--type',
      'bearer',
      '--origin',
      origin,
      '--from-env',
      'TOKEN',
      '--dir',
      team,
    ],
    { env: { TOKEN: 'team-token-3' } },
  );
  const [teamCredential] = JSON.parse(
    (await ok(['secret', 'list', '--json', '--dir', team])).out,
  ).filter((item: { name: string }) => item.name === 'Team token');
  await ok([
    'request',
    'update',
    'Who',
    '--auth',
    'credential',
    '--credential',
    teamCredential.id,
    '--dir',
    team,
  ]);
  const fromTeam = JSON.parse((await ok(['request', 'send', 'Who', '--dir', team, '--json'])).out);
  assert.match(fromTeam.body, /Bearer team-token-3/);
  for (const file of await fs.readdir(team, { recursive: true })) {
    const full = path.join(team, String(file));
    if ((await fs.stat(full)).isFile())
      assert.doesNotMatch(
        await fs.readFile(full, 'utf8'),
        new RegExp(teamCredential.id),
        String(file),
      );
  }
  // A copy of the folder the app does not have keeps none, and says how to use them.
  const copy = path.join(root, 'team-copy');
  await fs.cp(team, copy, { recursive: true });
  const fromCopy = JSON.parse((await cli(['request', 'send', 'Who', '--dir', copy, '--json'])).out);
  assert.match(fromCopy.error, /team folder the app on this computer has open/);
  // Literal auth secrets follow the same rule: the app keeps them on this device for a folder it
  // has open, never in the folder; a folder it does not have refuses them rather than lose them.
  await ok(
    ['request', 'update', 'Who', '--auth', 'bearer', '--auth-secret-from-env', 'T', '--dir', team],
    {
      env: { T: 'team-literal-5' },
    },
  );
  const kept = JSON.parse((await ok(['request', 'send', 'Who', '--dir', team, '--json'])).out);
  assert.match(kept.body, /Bearer team-literal-5/);
  for (const file of await fs.readdir(team, { recursive: true })) {
    const full = path.join(team, String(file));
    if ((await fs.stat(full)).isFile())
      assert.doesNotMatch(await fs.readFile(full, 'utf8'), /team-literal-5/, String(file));
  }
  const refused = await cli(
    ['request', 'update', 'Who', '--auth', 'bearer', '--auth-secret-from-env', 'T', '--dir', copy],
    { env: { T: 'lost-6' } },
  );
  assert.equal(refused.code, 2);
  assert.match(refused.err, /keeps no secret values here/);
  // A {{variable}} is no secret value, so it is shared as it is.
  await ok(['request', 'update', 'Who', '--auth-secret-from-env', 'T', '--dir', copy], {
    env: { T: '{{api_token}}' },
  });
  await ok(['request', 'update', 'Who', '--auth', 'oauth2', '--dir', copy]);
  const noToken = await cli(['request', 'token', 'Who', '--dir', copy]);
  assert.match(noToken.err, /keeps no tokens here/);
});

test('every auth type is set from the command line, its secrets never printed', async (t) => {
  const created = JSON.parse(
    (
      await ok([
        'request',
        'create',
        'Signed',
        '-c',
        'Shop',
        '--url',
        'https://example.com/a',
        '--json',
      ])
    ).out,
  );
  const fields = {
    username: 'AKIDEXAMPLE',
    password: 'aws-secret-7',
    options: { awsRegion: 'eu-west-1', awsService: 'execute-api', awsSessionToken: 'session-5' },
  };
  await ok(['request', 'update', created.id, '--auth', 'aws', '--auth-fields-from-env', 'FIELDS'], {
    env: { FIELDS: JSON.stringify(fields) },
  });
  const shown = await ok(['request', 'show', created.id, '--json']);
  assert.doesNotMatch(shown.out, /aws-secret-7|session-5/);
  const details = JSON.parse(shown.out).authDetails;
  assert.equal(details.type, 'AWS Signature');
  assert.equal(details.username, 'AKIDEXAMPLE');
  assert.deepEqual(details.options, { awsRegion: 'eu-west-1', awsService: 'execute-api' });
  assert.deepEqual(details.saved.sort(), ['awsSessionToken', 'password']);
  // `<hidden>` keeps a secret, null removes an option, and unknown or wrong values are refused.
  await ok(['request', 'update', created.id, '--auth-fields-from-env', 'FIELDS'], {
    env: {
      FIELDS: JSON.stringify({ password: '<hidden>', options: { awsSessionToken: null } }),
    },
  });
  const kept = JSON.parse((await ok(['request', 'show', created.id, '--json'])).out).authDetails;
  assert.deepEqual(kept.saved, ['password']);
  for (const bad of [
    { options: { jwtAlgorithm: 'none' } },
    { options: { oauth2RefreshToken: 'x' } },
    { options: { constructor: 'x' } },
    { other: 1 },
  ]) {
    const refused = await cli(
      ['request', 'update', created.id, '--auth-fields-from-env', 'FIELDS'],
      { env: { FIELDS: JSON.stringify(bad) } },
    );
    assert.equal(refused.code, 2, JSON.stringify(bad));
  }

  // OAuth 2.0: request token gets the token from the token endpoint and keeps it, unprinted.
  let grant = '';
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      if (incoming.url === '/token') {
        grant = `${incoming.headers.authorization} ${body}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'issued-token-4',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-8',
          }),
        );
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ auth: incoming.headers.authorization ?? null }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await ok(
    [
      'request',
      'update',
      created.id,
      '--url',
      `${origin}/me`,
      '--auth',
      'oauth2',
      '--auth-fields-from-env',
      'FIELDS',
    ],
    {
      env: {
        FIELDS: JSON.stringify({
          options: {
            oauth2GrantType: 'client_credentials',
            oauth2TokenUrl: `${origin}/token`,
            oauth2ClientId: 'client-1',
            oauth2ClientSecret: 'client-secret-2',
            oauth2ClientAuth: 'basic',
            oauth2Scope: 'read',
          },
        }),
      },
    },
  );
  const token = await ok(['request', 'token', created.id, '--json']);
  assert.doesNotMatch(token.out, /issued-token-4|refresh-8|client-secret-2/);
  const result = JSON.parse(token.out);
  assert.equal(result.type, 'token');
  assert.equal(result.refreshToken, true);
  assert.ok(result.expiresAt > Date.now());
  assert.match(grant, /^Basic /);
  assert.match(grant, /grant_type=client_credentials/);
  const after = JSON.parse((await ok(['request', 'show', created.id, '--json'])).out).authDetails;
  assert.ok(after.saved.includes('token') && after.saved.includes('oauth2RefreshToken'));
  assert.ok(after.expiresAt > Date.now());
  assert.equal(after.options.oauth2ClientSecret, undefined);
  const sent = JSON.parse((await ok(['request', 'send', created.id, '--json'])).out);
  assert.match(sent.body, /Bearer issued-token-4/);
  const refreshed = await ok(['request', 'token', created.id, '--refresh', '--json']);
  assert.equal(JSON.parse(refreshed.out).type, 'token');
  assert.match(grant, /grant_type=refresh_token/);
  // An authorization code grant prints where to sign in, then waits for the browser's return.
  const port = 43000 + Math.floor(Math.random() * 2000);
  await ok(['request', 'update', created.id, '--auth-fields-from-env', 'FIELDS'], {
    env: {
      FIELDS: JSON.stringify({
        options: {
          oauth2GrantType: 'authorization_code',
          oauth2AuthorizationUrl: `${origin}/authorize`,
          oauth2ClientAuth: 'none',
          oauth2CallbackPort: String(port),
        },
      }),
    },
  });
  const lines: string[] = [];
  const code = await main(
    ['request', 'token', created.id, '--json'],
    {
      out: (line) => {
        lines.push(line);
        const event = JSON.parse(line);
        if (event.type !== 'authorize') return;
        const url = new URL(event.url);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        // As the browser would, once the person signs in.
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-6');
        back.searchParams.set('state', url.searchParams.get('state')!);
        void fetch(back);
      },
      err: () => undefined,
    },
    { API_WORKBENCH_DATA_DIR: data },
    false,
    undefined,
    { stdin: async () => '', password: async () => PASSWORD },
  );
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).type),
    ['authorize', 'token'],
  );
  assert.match(grant, /grant_type=authorization_code/);
  assert.match(grant, /code=code-6/);
  assert.match(grant, /code_verifier=/);
  await ok(['request', 'update', created.id, '--auth', 'bearer']);
  const notOAuth = await cli(['request', 'token', created.id]);
  assert.equal(notOAuth.code, 2);
});

test('request create makes a request of each type, with its protocol’s settings', async () => {
  for (const [protocol, url] of [
    ['websocket', 'wss://echo.example.com/ws'],
    ['mqtt', 'mqtt://broker.example.com:1883'],
    ['socketio', 'https://chat.example.com/'],
    ['grpc', 'localhost:50051'],
    ['http', 'https://api.example.com/orders'],
  ]) {
    const created = JSON.parse(
      (
        await ok([
          'request',
          'create',
          `New ${protocol}`,
          '-c',
          'Types',
          '--url',
          url,
          '--protocol',
          protocol,
          '--json',
        ])
      ).out,
    );
    const shown = JSON.parse((await ok(['request', 'show', created.id, '--json'])).out);
    assert.equal(shown.protocol, protocol);
    if (protocol === 'mqtt') assert.equal(shown.mqtt.version, 4);
    if (protocol === 'socketio') assert.equal(shown.socketio.path, '/socket.io');
    if (protocol === 'grpc') assert.equal(shown.grpc.proto, '');
  }
  const wrong = await cli([
    'request',
    'create',
    'X',
    '-c',
    'Types',
    '--url',
    'a',
    '--protocol',
    'ftp',
  ]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /--protocol is http, websocket/);
  const curl = await cli([
    'request',
    'create',
    '--curl',
    'curl https://a.example',
    '--protocol',
    'mqtt',
  ]);
  assert.equal(curl.code, 2);
});

test('request schema asks a GraphQL endpoint for its schema as the request is sent', async (t) => {
  let seen: { auth?: string; body: string } = { body: '' };
  const schema = {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'orders',
              description: 'Recent orders',
              isDeprecated: false,
              args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int' } }],
              type: {
                kind: 'NON_NULL',
                ofType: { kind: 'LIST', ofType: { kind: 'OBJECT', name: 'Order' } },
              },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Order',
          fields: [
            { name: 'id', args: [], type: { kind: 'SCALAR', name: 'ID' } },
            {
              name: 'old',
              args: [],
              isDeprecated: true,
              deprecationReason: 'Use id',
              type: { kind: 'SCALAR', name: 'String' },
            },
            { name: 'bad name', args: [], type: { kind: 'SCALAR', name: 'ID' } },
          ],
        },
        { kind: 'OBJECT', name: '__Schema', fields: [] },
        { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'OPEN' }, { name: 'SHIPPED' }] },
      ],
    },
  };
  let introspection = true;
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      seen = { auth: incoming.headers.authorization, body };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          introspection
            ? { data: schema }
            : { errors: [{ message: 'GraphQL introspection is not allowed' }] },
        ),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const created = JSON.parse(
    (
      await ok([
        'request',
        'create',
        'Shop GraphQL',
        '-c',
        'GraphQL',
        '--url',
        `${origin}/graphql`,
        '-X',
        'POST',
        '-d',
        '{"query": "{ orders { id } }"}',
        '--json',
      ])
    ).out,
  );
  await ok(['request', 'update', created.id, '--auth', 'bearer', '--auth-secret-from-env', 'T'], {
    env: { T: 'gql-token-1' },
  });
  // A script of the request's own never runs on the introspection query.
  const script = path.join(root, 'schema-pre.js');
  await fs.writeFile(script, "aw.request.headers.set('X-Script', 'ran');");
  await ok(['request', 'update', created.id, '--pre-script-file', script]);
  const result = await ok(['request', 'schema', created.id, '--json']);
  assert.equal(seen.auth, 'Bearer gql-token-1', 'sent with its auth');
  assert.match(JSON.parse(seen.body).query, /__schema/);
  assert.doesNotMatch(result.out, /gql-token-1/);
  const compact = JSON.parse(result.out);
  assert.equal(compact.queryType, 'Query');
  assert.deepEqual(
    compact.types.map((type: { name: string }) => type.name),
    ['Query', 'Order', 'Status'],
  );
  assert.deepEqual(compact.types[0].fields[0], {
    name: 'orders',
    type: '[Order]!',
    description: 'Recent orders',
    args: [{ name: 'first', type: 'Int' }],
  });
  assert.deepEqual(
    compact.types[1].fields.map((field: { name: string; deprecated?: string }) => [
      field.name,
      field.deprecated,
    ]),
    [
      ['id', undefined],
      ['old', 'Use id'],
    ],
    'a name that is not a GraphQL name is left out',
  );
  assert.match((await ok(['request', 'schema', created.id])).out, /3 types\. Query: 1 fields/);
  // The request itself is unchanged, and nothing is kept in History.
  const shown = JSON.parse((await ok(['request', 'show', created.id, '--json'])).out);
  assert.equal(shown.bodyText, '{"query": "{ orders { id } }"}');
  introspection = false;
  const refused = await cli(['request', 'schema', created.id]);
  assert.equal(refused.code, 2);
  assert.match(
    refused.err,
    /refused the introspection query: GraphQL introspection is not allowed/,
  );
});

test('a header is kept but not sent, and sent again', async () => {
  const created = JSON.parse(
    (
      await ok([
        'request',
        'create',
        'Toggled',
        '-c',
        'Headers',
        '--url',
        'https://example.com',
        '-H',
        'X-Trace: 1',
        '--json',
      ])
    ).out,
  );
  const enabled = async () =>
    JSON.parse((await ok(['request', 'show', created.id, '--json'])).out).headers.find(
      (header: { key: string }) => header.key === 'X-Trace',
    ).enabled;
  await ok(['request', 'update', created.id, '--disable-header', 'x-trace']);
  assert.equal(await enabled(), false);
  // Changing its value keeps it off.
  await ok(['request', 'update', created.id, '-H', 'X-Trace: 2']);
  assert.equal(await enabled(), false);
  await ok(['request', 'update', created.id, '--enable-header', 'X-Trace']);
  assert.equal(await enabled(), true);
  const missing = await cli(['request', 'update', created.id, '--disable-header', 'Nope']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no header “Nope”/);
});

test('mock update changes a mock server’s settings and routes, from what mock show gives', async () => {
  const dir = ['--dir', team];
  const spec = path.join(root, 'orders.yaml');
  await fs.writeFile(
    spec,
    'openapi: 3.0.3\ninfo: {title: Orders, version: "1"}\npaths:\n  /orders:\n    get:\n      responses:\n        "200": {description: ok}\n',
  );
  await ok(['mock', 'create', 'Orders mock', '--spec', spec, '--port', '4710', ...dir]);
  const before = JSON.parse((await ok(['mock', 'show', 'Orders mock', '--json', ...dir])).out);
  assert.equal(before.settings.corsOptions.origins, '*');
  const settingsFile = path.join(root, 'mock-settings.json');
  const write = (value: unknown) => fs.writeFile(settingsFile, JSON.stringify(value));
  await write({
    name: 'Orders API mock',
    port: 4711,
    corsOptions: { origins: 'http://localhost:5173', credentials: true, maxAge: 600 },
    defaultHeaders: [
      ...before.settings.defaultHeaders,
      { key: 'X-Api-Key', value: 'mock-key-1', enabled: true },
    ],
    routes: [{ id: before.routes[0].id, status: 503, delayMs: 250, enabled: false }],
  });
  await ok(['mock', 'update', 'Orders mock', '--settings-file', settingsFile, ...dir]);
  const after = JSON.parse((await ok(['mock', 'show', 'Orders API mock', '--json', ...dir])).out);
  assert.equal(after.port, 4711);
  assert.equal(after.settings.corsOptions.origins, 'http://localhost:5173');
  assert.equal(after.settings.corsOptions.credentials, true);
  assert.deepEqual(
    [after.routes[0].status, after.routes[0].delayMs, after.routes[0].enabled],
    [503, 250, false],
  );
  // A secret-looking header's value is hidden, and kept when given back hidden.
  const key = after.settings.defaultHeaders.find((row: { key: string }) => row.key === 'X-Api-Key');
  assert.equal(key.value, '<hidden>');
  await write({ defaultHeaders: after.settings.defaultHeaders });
  await ok(['mock', 'update', 'Orders API mock', '--settings-file', settingsFile, ...dir]);
  const kept = JSON.parse((await ok(['mock', 'show', 'Orders API mock', '--json', ...dir])).out);
  assert.equal(
    kept.settings.defaultHeaders.filter((row: { key: string }) => row.key === 'X-Api-Key').length,
    1,
  );
  await ok(['mock', 'create', 'Second mock', '--spec', spec, '--port', '4720', ...dir]);
  for (const [bad, reason] of [
    [{ port: 80 }, /port: Choose a port from 1024/],
    [{ corsOptions: { maxAge: -1 } }, /maxAge/],
    [{ routes: [{ id: 'nope' }] }, /no route/],
    [{ defaultHeaders: [{ key: 'Bad Name', value: 'x' }] }, /not a header name/],
    [{ https: { enabled: true, certFile: 'a.pem' } }, /both a certificate/],
    [{ name: 'second MOCK' }, /already a mock server/],
    [{ port: 4720 }, /Port 4720 is used by the mock server “Second mock”/],
    [{ other: 1 }, /no “other”/],
  ] as const) {
    await write(bad);
    const refused = await cli([
      'mock',
      'update',
      'Orders API mock',
      '--settings-file',
      settingsFile,
      ...dir,
    ]);
    assert.equal(refused.code, 2, JSON.stringify(bad));
    assert.match(refused.err, reason);
  }
});

test('a route added to a mock made from a collection is added to that collection too', async () => {
  const dir = ['--dir', team];
  await ok(['mock', 'create', 'Sync mock', '-c', 'Shop', '--port', '4730', ...dir]);
  const settingsFile = path.join(root, 'add-routes.json');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      addRoutes: [
        { method: 'post', path: '/items/:id/archive', status: 202, name: 'Archive item' },
      ],
    }),
  );
  const updated = await ok([
    'mock',
    'update',
    'Sync mock',
    '--settings-file',
    settingsFile,
    ...dir,
  ]);
  assert.match(updated.out, /in the collection “Shop” too/);
  const listed = JSON.parse((await ok(['list', team, '--json'])).out);
  const added = listed.requests.find((item: { name: string }) => item.name === 'Archive item');
  assert.ok(added, 'in the collection');
  assert.equal(added.method, 'POST');
  assert.equal(added.folder, 'Shop');
  const shown = JSON.parse((await ok(['request', 'show', added.id, '--json', ...dir])).out);
  assert.match(shown.url, /\/items\/\{\{id\}\}\/archive$/);
  const mock = JSON.parse((await ok(['mock', 'show', 'Sync mock', '--json', ...dir])).out);
  const route = mock.routes.find((item: { path: string }) => item.path === '/items/:id/archive');
  assert.deepEqual([route.method, route.status], ['POST', 202]);
  // The same route again is refused, and nothing is added twice.
  const again = await cli(['mock', 'update', 'Sync mock', '--settings-file', settingsFile, ...dir]);
  assert.equal(again.code, 2);
  assert.match(again.err, /already answers POST \/items\/:id\/archive/);
});

test('a request added to or changed in a collection updates the mock made from it', async () => {
  const dir = ['--dir', team];
  await ok(['mock', 'create', 'Back sync mock', '-c', 'Shop', '--port', '4740', ...dir]);
  const created = await ok([
    'request',
    'create',
    'Ship an order',
    '-c',
    'Shop',
    '-X',
    'POST',
    '--url',
    '{{base_url}}/orders/{{id}}/ship',
    ...dir,
  ]);
  // Every mock made from Shop gets it, this one among them.
  assert.match(created.out, /Added to the mock servers? .*“Back sync mock”/);
  const route = (mock: { routes: { path: string; method: string; name: string }[] }) =>
    mock.routes.find((item) => item.name === 'Ship an order' || item.name === 'Ship it');
  let mock = JSON.parse((await ok(['mock', 'show', 'Back sync mock', '--json', ...dir])).out);
  assert.deepEqual([route(mock)?.method, route(mock)?.path], ['POST', '/orders/:id/ship']);
  await ok([
    'request',
    'update',
    'Ship an order',
    '-X',
    'PUT',
    '--url',
    '{{base_url}}/orders/{{id}}/shipment',
    '--name',
    'Ship it',
    ...dir,
  ]);
  mock = JSON.parse((await ok(['mock', 'show', 'Back sync mock', '--json', ...dir])).out);
  assert.deepEqual(
    [route(mock)?.method, route(mock)?.path, route(mock)?.name],
    ['PUT', '/orders/:id/shipment', 'Ship it'],
  );
  // A change that is not the method, URL, or name leaves the mock as it was.
  const routes = JSON.stringify(mock.routes);
  await ok(['request', 'update', 'Ship it', '--tests', 'status 200', ...dir]);
  mock = JSON.parse((await ok(['mock', 'show', 'Back sync mock', '--json', ...dir])).out);
  assert.equal(JSON.stringify(mock.routes), routes);
});

test('credentials of every kind are saved and changed, their secrets kept out of arguments and output', async () => {
  const fields = {
    secret: 'aws-secret-1',
    extraSecret: 'session-2',
    username: 'AKIDEXAMPLE',
    options: { awsRegion: 'eu-west-1', awsService: 'execute-api' },
  };
  await ok(
    [
      'secret',
      'set',
      'Signing',
      '--type',
      'aws',
      '--origin',
      'https://api.example.com',
      '--fields-from-env',
      'F',
    ],
    { env: { F: JSON.stringify(fields) } },
  );
  const list = async () =>
    JSON.parse((await ok(['secret', 'list', '--json'])).out).find(
      (item: { name: string }) => item.name === 'Signing',
    );
  let saved = await list();
  assert.deepEqual(
    [saved.type, saved.username, saved.options.awsRegion, saved.hasSecret, saved.hasExtraSecret],
    ['aws', 'AKIDEXAMPLE', 'eu-west-1', true, true],
  );
  const output = (await ok(['secret', 'list', '--json'])).out;
  assert.doesNotMatch(output, /aws-secret-1|session-2/);
  // A change without secrets keeps them, and keeps what it does not name.
  await ok(['secret', 'set', 'Signing', '--fields-from-env', 'F'], {
    env: { F: JSON.stringify({ options: { awsRegion: 'us-east-1' } }) },
  });
  saved = await list();
  assert.deepEqual(
    [saved.options.awsRegion, saved.options.awsService, saved.hasSecret, saved.origin],
    ['us-east-1', 'execute-api', true, 'https://api.example.com'],
  );
  // OAuth 2.0: its client, with the client secret given as a field and never shown.
  await ok(
    [
      'secret',
      'set',
      'Login',
      '--type',
      'oauth2',
      '--origin',
      'https://api.example.com',
      '--fields-from-env',
      'F',
    ],
    {
      env: {
        F: JSON.stringify({
          oauth: {
            grantType: 'client_credentials',
            tokenUrl: 'https://id.example.com/token',
            clientId: 'shop',
            clientSecret: 'client-secret-3',
            clientAuth: 'basic',
            scope: 'read',
          },
        }),
      },
    },
  );
  const login = JSON.parse((await ok(['secret', 'list', '--json'])).out).find(
    (item: { name: string }) => item.name === 'Login',
  );
  assert.equal(login.oauth.clientId, 'shop');
  assert.doesNotMatch(JSON.stringify(login), /client-secret-3/);
  for (const [extra, reason] of [
    [{ other: 1 }, /no field “other”/],
    [{ options: { awsRegion: { x: 1 } } }, /not a setting/],
  ] as const) {
    const refused = await cli(['secret', 'set', 'Signing', '--fields-from-env', 'F'], {
      env: { F: JSON.stringify(extra) },
    });
    assert.equal(refused.code, 2);
    assert.match(refused.err, reason);
  }
  assert.match(
    (
      await cli(
        [
          'secret',
          'set',
          'Cert',
          '--type',
          'client-certificate',
          '--origin',
          'https://a.example',
          '--stdin',
        ],
        { stdin: 'x' },
      )
    ).err,
    /set up in the app/,
  );
  await ok(['secret', 'delete', 'Signing', '--yes']);
  await ok(['secret', 'delete', 'Login', '--yes']);
});

test('mock update edits a route’s method, path, headers, and body, and removes routes', async () => {
  const dir = ['--dir', team];
  await ok(['mock', 'create', 'Route editor mock', '-c', 'Shop', '--port', '4750', ...dir]);
  const settingsFile = path.join(root, 'route-edit.json');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      addRoutes: [{ method: 'GET', path: '/drafts', name: 'Drafts', status: 200 }],
    }),
  );
  await ok(['mock', 'update', 'Route editor mock', '--settings-file', settingsFile, ...dir]);
  const show = async () =>
    JSON.parse((await ok(['mock', 'show', 'Route editor mock', '--json', ...dir])).out);
  let mock = await show();
  const route = mock.routes.find((item: { path: string }) => item.path === '/drafts');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      routes: [
        {
          id: route.id,
          method: 'POST',
          path: '/drafts/:id',
          name: 'Save a draft',
          headers: [
            { key: 'Content-Type', value: 'application/json', enabled: true },
            { key: 'X-Session-Token', value: 'route-secret-4', enabled: true },
          ],
          body: '{"saved": true}',
        },
      ],
    }),
  );
  await ok(['mock', 'update', 'Route editor mock', '--settings-file', settingsFile, ...dir]);
  mock = await show();
  const edited = mock.routes.find((item: { id: string }) => item.id === route.id);
  assert.deepEqual(
    [edited.method, edited.path, edited.name, edited.body],
    ['POST', '/drafts/:id', 'Save a draft', '{"saved": true}'],
  );
  assert.equal(edited.headers[1].value, '<hidden>', 'a secret-looking value is hidden');
  assert.doesNotMatch(JSON.stringify(mock), /route-secret-4/);
  // Its request in the collection followed it.
  const request = JSON.parse((await ok(['list', team, '--json'])).out).requests.find(
    (item: { name: string }) => item.name === 'Save a draft',
  );
  assert.equal(request?.method, 'POST');
  // Headers given back hidden keep their values; a route is removed, its request kept.
  await fs.writeFile(
    settingsFile,
    JSON.stringify({ routes: [{ id: route.id, headers: edited.headers }] }),
  );
  await ok(['mock', 'update', 'Route editor mock', '--settings-file', settingsFile, ...dir]);
  await fs.writeFile(settingsFile, JSON.stringify({ removeRoutes: [route.id] }));
  await ok(['mock', 'update', 'Route editor mock', '--settings-file', settingsFile, ...dir]);
  assert.ok(!(await show()).routes.some((item: { id: string }) => item.id === route.id));
  assert.ok(
    JSON.parse((await ok(['list', team, '--json'])).out).requests.some(
      (item: { name: string }) => item.name === 'Save a draft',
    ),
  );
  for (const [bad, reason] of [
    [{ routes: [{ id: route.id }] }, /no route/],
    [{ removeRoutes: ['nope'] }, /no route/],
  ] as const) {
    await fs.writeFile(settingsFile, JSON.stringify(bad));
    const refused = await cli([
      'mock',
      'update',
      'Route editor mock',
      '--settings-file',
      settingsFile,
      ...dir,
    ]);
    assert.match(refused.err, reason);
  }
});

test('mock sync puts a mock and its collection in step, and a renamed collection stays the mock’s', async () => {
  const dir = ['--dir', team];
  await ok(['collection', 'create', 'Ledger', ...dir]);
  await ok([
    'request',
    'create',
    'List entries',
    '-c',
    'Ledger',
    '--url',
    '{{base_url}}/entries',
    ...dir,
  ]);
  await ok(['mock', 'create', 'Ledger mock', '-c', 'Ledger', '--port', '4760', ...dir]);
  const show = async () =>
    JSON.parse((await ok(['mock', 'show', 'Ledger mock', '--json', ...dir])).out);
  // A route with no request, as made before routes and requests were linked.
  const settingsFile = path.join(root, 'ledger-route.json');
  await fs.writeFile(
    settingsFile,
    JSON.stringify({ addRoutes: [{ method: 'DELETE', path: '/entries/:id' }] }),
  );
  await ok(['mock', 'update', 'Ledger mock', '--settings-file', settingsFile, ...dir]);
  let mock = await show();
  assert.deepEqual(mock.collectionSync, {
    collection: 'Ledger',
    missingRoutes: 0,
    missingRequests: 0,
  });
  // Renamed, the collection is still the mock's, and new requests there still reach it.
  await ok(['collection', 'rename', 'Ledger', 'Accounts', ...dir]);
  mock = await show();
  assert.equal(mock.source.name, 'Accounts');
  await ok([
    'request',
    'create',
    'Add entry',
    '-c',
    'Accounts',
    '-X',
    'POST',
    '--url',
    '{{base_url}}/entries',
    ...dir,
  ]);
  mock = await show();
  assert.ok(
    mock.routes.some(
      (route: { method: string; path: string }) =>
        route.method === 'POST' && route.path === '/entries',
    ),
  );
  const synced = await ok(['mock', 'sync', 'Ledger mock', '--json', ...dir]);
  assert.deepEqual(JSON.parse(synced.out), {
    collection: 'Accounts',
    routesAdded: 0,
    requestsAdded: 0,
  });
  assert.match((await ok(['mock', 'sync', 'Ledger mock', ...dir])).out, /are in step/);
  assert.equal(
    (await cli(['mock', 'sync', 'Pets mock', ...dir])).code,
    2,
    'not made from a collection',
  );
});

test('environment update saves a whole list of variables, in order, on or off, hidden values kept', async () => {
  await ok(['environment', 'create', 'Update test']);
  await ok(['environment', 'set', 'Update test', 'api_token', 'base=https://a.example'], {
    env: { api_token: 'tok-11' },
  });
  const shown = async () =>
    JSON.parse((await ok(['environment', 'show', 'Update test', '--json'])).out).variables;
  const before = await shown();
  assert.equal(before.find((row: { key: string }) => row.key === 'api_token').value, '<hidden>');
  const rows = [
    { key: 'region', value: 'eu', enabled: false },
    ...before,
    { key: 'page_size', value: '50', enabled: true },
  ].filter((row) => row.key !== 'base');
  await ok(['environment', 'update', 'Update test', '--variables-from-env', 'V'], {
    env: { V: JSON.stringify(rows) },
  });
  const after = await shown();
  assert.deepEqual(
    after.map((row: { key: string; enabled: boolean }) => [row.key, row.enabled]),
    [
      ['region', false],
      ['api_token', true],
      ['page_size', true],
    ],
  );
  // The hidden value was kept, not written as “<hidden>”: a run sees it.
  const store = JSON.parse((await ok(['environment', 'show', 'Update test', '--json'])).out);
  assert.equal(store.variables[1].value, '<hidden>');
  for (const [bad, reason] of [
    [[{ key: 'a b', value: '' }], /without spaces/],
    [
      [
        { key: 'x', value: '1' },
        { key: 'x', value: '2' },
      ],
      /twice/,
    ],
    [[{ key: 'new_secret', value: '<hidden>' }], /no value to keep/],
  ] as const) {
    const refused = await cli(
      ['environment', 'update', 'Update test', '--variables-from-env', 'V'],
      {
        env: { V: JSON.stringify(bad) },
      },
    );
    assert.equal(refused.code, 2, JSON.stringify(bad));
    assert.match(refused.err, reason);
  }
  await ok(['environment', 'delete', 'Update test', '--yes']);
});
