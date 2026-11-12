import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { main } from './cli';
import { parseArgs } from './args';

/** The command line against a team folder made by the app, and a local API. */

let server: Server;
let base: string;
let root: string;
let team: string;
const seen: { url: string; authorization?: string; name?: string }[] = [];

const request = (id: string, extra: Partial<ApiRequest>): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: '',
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

before(async () => {
  server = createServer((incoming, response) => {
    seen.push({
      url: incoming.url ?? '',
      authorization: incoming.headers.authorization,
      name: incoming.headers['x-name'] as string | undefined,
    });
    const url = new URL(incoming.url ?? '/', 'http://x');
    if (url.pathname === '/login') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=abc; Path=/',
      });
      response.end('{"token":"T-123"}');
    } else if (url.pathname === '/me') {
      const ok =
        incoming.headers.authorization === 'Bearer T-123' &&
        incoming.headers.cookie === 'session=abc';
      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      response.end(ok ? '{"name":"Ada"}' : '{"error":"unauthorized"}');
    } else if (url.pathname.startsWith('/users/')) {
      const id = url.pathname.split('/')[2];
      response.writeHead(id === '1' || id === '2' ? 200 : 404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ id }));
    } else {
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-'));
  team = path.join(root, 'team');
  const store = new WorkspaceStore(path.join(root, 'app-data'));
  await store.list();
  const state: WorkspaceState = {
    requests: [
      request('login', {
        name: 'Log in',
        method: 'POST',
        url: '{{base_url}}/login',
        body: '{"user":"ada"}',
        tests: 'status 200\njson-exists $.token',
        captures: [{ enabled: true, key: 'token', value: '$.token' }],
      }),
      request('me', {
        name: 'Who am I',
        url: '{{base_url}}/me',
        auth: 'Bearer token',
        token: '{{token}}',
        tests: 'status 200\njson $.name equals "Ada"',
      }),
      request('user', {
        name: 'Get user',
        folder: 'Users',
        url: '{{base_url}}/users/{{id}}',
        headers: [{ enabled: true, key: 'X-Name', value: '{{name}}' }],
        tests: 'status {{expected}}',
      }),
      request('vaulted', {
        name: 'Vaulted',
        folder: 'Vault',
        url: '{{base_url}}/me',
        auth: 'Saved credential',
        credentialId: 'vault-id',
      }),
    ],
    active: 'login',
    tabs: ['login'],
    environments: [
      {
        name: 'Local',
        variables: [
          { enabled: true, key: 'base_url', value: base },
          { enabled: true, key: 'id', value: '1' },
          { enabled: true, key: 'expected', value: '200' },
        ],
      },
      {
        name: 'Broken',
        variables: [{ enabled: true, key: 'base_url', value: 'http://127.0.0.1:1' }],
      },
    ],
    environment: 0,
    history: [],
  };
  await store.openFolder(team, state, 'CI', 'share');
  store.close();
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  onLine?: (line: string) => void,
  interrupt?: AbortSignal,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    args,
    {
      out: (line) => {
        out.push(line);
        onLine?.(line);
      },
      err: (line) => err.push(line),
    },
    env,
    false,
    interrupt,
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('a passing run exits 0, chains captured values and cookies, and writes JSON and JUnit reports', async () => {
  const json = path.join(root, 'reports', 'run.json');
  const junit = path.join(root, 'reports', 'junit.xml');
  const result = await cli([
    'run',
    team,
    '-c',
    'Shop',
    '-e',
    'Local',
    '--report-json',
    json,
    '--report-junit',
    junit,
  ]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /✓ POST\s+Log in\s+200/);
  assert.match(result.out, /✓ GET\s+Who am I\s+200/);
  assert.match(result.out, /2 requests: 2 passed/);
  const report = JSON.parse(await fs.readFile(json, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.summary.tests, 4);
  assert.equal(report.environment, 'Local');
  const xml = await fs.readFile(junit, 'utf8');
  assert.match(xml, /<testsuites name="[^"]+" tests="2" failures="0" errors="0"/);
  assert.match(xml, /<testcase classname="Shop" name="POST Log in"/);
  for (const text of [JSON.stringify(report), xml])
    assert.ok(!text.includes('T-123'), 'captured values and tokens stay out of reports');
});

test('a failing test exits 1 and is reported as a JUnit failure with its message', async () => {
  const junit = path.join(root, 'fail.xml');
  const result = await cli([
    'run',
    team,
    '-c',
    'Users',
    '-e',
    'Local',
    '-v',
    'id=99',
    '--report-junit',
    junit,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.out, /✗ GET\s+Get user\s+404/);
  assert.match(result.out, /✗ .*status/);
  const xml = await fs.readFile(junit, 'utf8');
  assert.match(xml, /<failure message="[^"]*status[^"]*" type="assertion">/);
  assert.equal(seen.at(-1)?.url, '/users/99', '--var overrides the environment');
});

test('a data file runs once per row, with columns in requests and tests', async () => {
  const data = path.join(root, 'users.csv');
  await fs.writeFile(data, 'id,name,expected\n1,Ada,200\n2,"Sam, Jr",200\n404,Nobody,404\n');
  seen.length = 0;
  const result = await cli(['run', team, '-c', 'Users', '-e', 'Local', '-d', data]);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(
    seen.map((item) => [item.url, item.name]),
    [
      ['/users/1', 'Ada'],
      ['/users/2', 'Sam, Jr'],
      ['/users/404', 'Nobody'],
    ],
  );
  assert.match(result.out, /Iteration 1\/3 \(id=1, name=Ada, expected=200\)/);
  assert.match(result.out, /Iteration 3\/3/);
});

test('a bare --var reads the process environment, so secrets stay off the command line', async () => {
  seen.length = 0;
  const result = await cli(
    ['run', team, '-r', 'Who am I', '-e', 'Local', '-v', 'token', '--quiet'],
    {
      token: 'FROM-ENV',
    },
  );
  assert.equal(result.code, 1, 'the API rejects the wrong token');
  assert.equal(seen.at(-1)?.authorization, 'Bearer FROM-ENV');
  assert.ok(!result.out.includes('FROM-ENV'), 'the value is not printed');
  assert.equal((await cli(['run', team, '-v', 'MISSING'])).code, 2);
});

test('saved credentials and unreachable APIs fail with a reason; --bail stops the run', async () => {
  const vault = await cli(['run', team, '-c', 'Vault', '-e', 'Local']);
  assert.equal(vault.code, 1);
  assert.match(vault.out, /saved credential.*--var/);
  const bail = await cli(['run', team, '-c', 'Shop', '-e', 'Broken', '--bail']);
  assert.equal(bail.code, 1);
  assert.match(bail.out, /1 request: 0 passed, 1 failed, 1 skipped/);
  assert.match(bail.out, /Stopped at the first failure/);
});

test('a Postman collection file runs directly', async () => {
  const file = path.join(root, 'shop.postman_collection.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      info: {
        name: 'Shop',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [{ name: 'User one', request: { method: 'GET', url: `${base}/users/1` } }],
    }),
  );
  const result = await cli(['run', file]);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /✓ GET\s+User one\s+200/);
});

test('list shows collections, requests, and environments', async () => {
  const result = await cli(['list', team]);
  assert.equal(result.code, 0);
  assert.match(result.out, /Shop\n\s+POST\s+Log in/);
  assert.match(result.out, /Environments: Local, Broken/);
});

test('list --json gives scripts the structure, without URLs or variable values', async () => {
  const result = await cli(['list', team, '--json']);
  assert.equal(result.code, 0, result.err);
  const listed = JSON.parse(result.out);
  assert.deepEqual(listed.environments, ['Local', 'Broken']);
  assert.ok(listed.collections.includes('Shop'));
  assert.deepEqual(
    listed.requests.find((item: { id: string }) => item.id === 'login'),
    {
      id: 'login',
      name: 'Log in',
      folder: 'Shop',
      method: 'POST',
      protocol: 'http',
      runnable: true,
    },
  );
  assert.ok(!result.out.includes(base), 'environment values are not listed');
});

test('an interrupted run stops, still reports what ran, and exits 130', async () => {
  const json = path.join(root, 'interrupted.json');
  const interrupt = new AbortController();
  const result = await cli(
    ['run', team, '-c', 'Shop', '-e', 'Local', '--report-json', json],
    {},
    (line) => {
      if (/✓ POST\s+Log in/.test(line)) interrupt.abort();
    },
    interrupt.signal,
  );
  assert.equal(result.code, 130, result.out + result.err);
  assert.match(result.out, /1 request: 1 passed, 1 skipped/);
  assert.match(result.out, /Interrupted/);
  const report = JSON.parse(await fs.readFile(json, 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.interrupted, true);
});

test('mistyped names suggest the one that was probably meant', async () => {
  for (const [args, message] of [
    [['rnu', team], /Unknown command “rnu”. Did you mean “run”\?/],
    [
      ['run', team, '--colection', 'Shop'],
      /Unknown option --colection. Did you mean “--collection”\?/,
    ],
    [['run', team, '-c', 'shpo'], /No collection or folder “shpo”. Did you mean “Shop”\?/],
    [['run', team, '-e', 'Locl'], /Did you mean “Local”\?/],
    [['run', team, '-r', 'Log ni'], /Did you mean “Log in”\?/],
    [['list', team, '--bail'], /--bail is not an option of list/],
    [['run', team, '--json'], /--json is not an option of run/],
  ] as const) {
    const result = await cli([...args]);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.out}${result.err}`);
    assert.match(result.err, message);
  }
  // Nothing close: no suggestion rather than a misleading one.
  assert.doesNotMatch((await cli(['run', team, '-e', 'Production'])).err, /Did you mean/);
});

test('usage mistakes exit 2 with a reason', async () => {
  for (const [args, message] of [
    [['run'], /needs a workspace folder/],
    [['explode'], /Unknown command/],
    [['run', team, '--wat'], /Unknown option --wat/],
    [['run', team, '-c', 'Nope'], /No collection or folder “Nope”/],
    [['run', team, '-e', 'Nope'], /No environment “Nope”. Environments: Local, Broken/],
    [['run', team, '-r', 'Nope'], /No request named “Nope”/],
    [['run', path.join(root, 'missing')], /was not found/],
    [['run', root], /has no workspace.json/],
    [['run', team, '-n', '0'], /must be a whole number from 1/],
    [['run', team, '-n', '2', '-d', 'x.csv'], /not both/],
  ] as const) {
    const result = await cli([...args]);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.out}${result.err}`);
    assert.match(result.err, message);
  }
  assert.equal((await cli(['--help'])).code, 0);
  for (const args of [
    ['run', '--help'],
    ['list', team, '-h'],
  ]) {
    const help = await cli(args);
    assert.equal(help.code, 0, help.err);
    assert.match(help.out, /Options for run/);
  }
  assert.match((await cli(['--version'])).out, /^\d+\.\d+\.\d+$/);
  assert.equal(
    (parseArgs(['run', team, '--reporter', 'junit'], {}, true) as { junitFile: string }).junitFile,
    'api-workbench-junit.xml',
  );
  assert.equal(
    (parseArgs(['run', team], { NO_COLOR: '1' }, true) as { color: boolean }).color,
    false,
  );
});

test('the command line is released with the app, so their versions match', async () => {
  const read = async (file: string) =>
    (JSON.parse(await fs.readFile(path.join(__dirname, file), 'utf8')) as { version: string })
      .version;
  const cliVersion = await read('../package.json');
  assert.equal(cliVersion, await read('../../../package.json'));
  assert.equal((await cli(['--version'])).out, cliVersion);
});

test('a performance run reports throughput and latency, and fails on a missed threshold', async () => {
  const junit = path.join(root, 'load.xml');
  const passing = await cli([
    'run',
    team,
    '-r',
    'Log in',
    '-e',
    'Local',
    '--duration',
    '0.3',
    '--concurrency',
    '2',
    '--report-junit',
    junit,
  ]);
  assert.equal(passing.code, 0, passing.out + passing.err);
  assert.match(passing.out, /Performance: 1 request for 0\.3 s, 2 at a time/);
  assert.match(passing.out, /\d+ requests in [\d.]+ s · [\d.]+ a second · 0 failed/);
  assert.match(passing.out, /Latency: average \d+ ms · p50/);
  assert.doesNotMatch(passing.out, /✓ POST\s+Log in/, 'no line per request in a load test');
  assert.match(await fs.readFile(junit, 'utf8'), /<testcase classname="load"/);

  const failing = await cli([
    'run',
    team,
    '-r',
    'Log in',
    '-e',
    'Local',
    '--mode',
    'benchmark',
    '-n',
    '5',
    '--min-rps',
    '1000000',
    '--report-junit',
    junit,
  ]);
  assert.equal(failing.code, 1, failing.out);
  assert.match(failing.out, /✗ .*(throughput|rps|requests)/i);
  assert.match(await fs.readFile(junit, 'utf8'), /type="threshold"/);

  for (const [args, message] of [
    [['--concurrency', '99'], /from 1 to 50/],
    [['--mode', 'preformance'], /Did you mean “performance”/],
    [['--duration', '1', '-d', 'x.csv'], /does not take a data file/],
    [['--mode', 'collection', '--concurrency', '2'], /are for --mode benchmark or performance/],
  ] as const) {
    const result = await cli(['run', team, ...args]);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.err}`);
    assert.match(result.err, message);
  }
});

test('scripts run only with --allow-scripts, and set variables, change requests, and test responses', async () => {
  const file = path.join(root, 'scripted.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      requests: [
        {
          name: 'Signed user',
          folder: 'Scripted',
          method: 'GET',
          url: `${base}/users/{{user_id}}`,
          scripts: {
            pre: `aw.vars.set('user_id', '2');
              aw.request.headers.set('X-Name', 'sig-' + aw.crypto.sha256('2').slice(0, 8));
              aw.log('signing', aw.request.url);`,
            post: `const body = aw.response.json();
              aw.test('is user 2', () => aw.expect(body.id).toBe('2'));
              aw.vars.set('next_id', '1');`,
          },
        },
        {
          name: 'Next user',
          folder: 'Scripted',
          method: 'GET',
          url: `${base}/users/{{next_id}}`,
          scripts: {
            post: "aw.test('fails on purpose', () => aw.expect(aw.response.status).toBe(500));",
          },
        },
      ],
    }),
  );
  const refused = await cli(['run', file]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /2 requests have scripts.*--allow-scripts.*--skip-scripts/);

  const skipped = await cli(['run', file, '--skip-scripts']);
  // Without the pre-request script, {{user_id}} is never set.
  assert.match(skipped.out, /Signed user/);
  assert.notEqual(seen.at(-2)?.url, '/users/2');

  const before = seen.length;
  const result = await cli(['run', file, '--allow-scripts']);
  assert.equal(result.code, 1, result.out + result.err);
  const sent = seen.slice(before);
  assert.equal(sent[0].url, '/users/2', 'the pre-request script set user_id');
  assert.match(sent[0].name ?? '', /^sig-[0-9a-f]{8}$/, 'the pre-request script added a header');
  assert.equal(
    sent[1].url,
    '/users/1',
    'the post-response script set next_id for the next request',
  );
  assert.match(result.out, /✓ GET\s+Signed user\s+200/);
  assert.match(
    result.out,
    /pre-request › signing http:\/\/127\.0\.0\.1:\d+\/users\/\{\{user_id\}\}/,
  );
  assert.match(result.out, /✗ fails on purpose: Expected: 200 to be 500/);
});

test('a pre-request script cannot send the request to another host', async () => {
  const file = path.join(root, 'moved.json');
  const elsewhere = base.replace('127.0.0.1', 'localhost');
  await fs.writeFile(
    file,
    JSON.stringify({
      requests: [
        {
          name: 'Moved by URL',
          folder: 'Moved',
          method: 'GET',
          url: `${base}/users/1`,
          scripts: { pre: `aw.request.url = ${JSON.stringify(`${elsewhere}/users/1`)};` },
        },
        {
          name: 'Moved by variable',
          folder: 'Moved',
          method: 'GET',
          url: '{{host}}/users/1',
          scripts: { pre: `aw.vars.set('host', ${JSON.stringify(elsewhere)});` },
        },
      ],
    }),
  );
  const before = seen.length;
  const result = await cli(['run', file, '--allow-scripts']);
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(seen.length, before, 'neither request was sent');
  assert.equal(result.out.match(/changed where this request is sent/g)?.length, 2, result.out);
});

test('workspace, collection, and folder scripts run around each request, outside in', async () => {
  const file = path.join(root, 'collection-scripted.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      requests: [
        {
          name: 'Tenant user',
          folder: 'Tenants/Users',
          method: 'GET',
          url: `${base}/users/{{user_id}}`,
          scripts: { pre: "aw.request.headers.set('X-Name', aw.vars.get('path'));" },
        },
      ],
      workspaceScripts: { pre: "aw.vars.set('path', 'workspace');" },
      collectionScripts: {
        Tenants: {
          pre: "aw.vars.set('path', aw.vars.get('path') + '>collection'); aw.vars.set('user_id', '1');",
          post: "aw.test('collection sees 200', () => aw.expect(aw.response.status).toBe(200));",
        },
        'Tenants/Users': {
          pre: "aw.vars.set('path', aw.vars.get('path') + '>folder'); aw.log('folder ran');",
        },
      },
    }),
  );
  const refused = await cli(['run', file]);
  assert.equal(refused.code, 2, 'collection scripts also need a choice');
  const before = seen.length;
  const result = await cli(['run', file, '--allow-scripts']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual(seen.slice(before), [
    { url: '/users/1', authorization: undefined, name: 'workspace>collection>folder' },
  ]);
  assert.match(result.out, /✓ Tenants · Post-response script|collection sees 200/);
  assert.match(result.out, /pre-request › Tenants \/ Users: folder ran/);
});

test('library modules from a workspace folder are shared with its scripts', async () => {
  const folder = path.join(root, 'library-workspace');
  const store = new WorkspaceStore(path.join(root, 'library-data'));
  await store.list();
  await store.openFolder(
    folder,
    {
      requests: [
        request('lib', {
          name: 'Signed',
          folder: 'Library',
          url: `${base}/users/1`,
          scripts: {
            pre: "aw.request.headers.set('X-Name', aw.require('naming').name('lib'));",
          },
        }),
      ],
      active: 'lib',
      tabs: ['lib'],
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
      scriptLibrary: [{ name: 'naming', source: "exports.name = (value) => 'from-' + value;" }],
    },
    'CI',
    'share',
  );
  store.close();
  const before = seen.length;
  const result = await cli(['run', folder, '--allow-scripts']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(seen[before].name, 'from-lib');
});

test('--tag, --all-tags, and --exclude-tag choose requests by their tags', async () => {
  const file = path.join(root, 'tagged.json');
  const tagged = (name: string, id: string, tags: string[]) => ({
    name,
    folder: 'Tagged',
    method: 'GET',
    url: `${base}/users/${id}`,
    tags,
  });
  await fs.writeFile(
    file,
    JSON.stringify({
      requests: [
        tagged('One', '1', ['smoke', 'users']),
        tagged('Two', '2', ['users', 'slow']),
        tagged('Plain', '1', []),
      ],
    }),
  );
  const ran = async (...args: string[]) => {
    const before = seen.length;
    const result = await cli(['run', file, ...args]);
    assert.equal(result.code, 0, result.out + result.err);
    return seen.slice(before).map((entry) => entry.url);
  };
  assert.deepEqual(await ran('--tag', 'smoke'), ['/users/1']);
  assert.deepEqual(await ran('-t', 'smoke,slow'), ['/users/1', '/users/2'], 'any of them');
  assert.deepEqual(await ran('-t', 'users', '-t', 'SLOW', '--all-tags'), ['/users/2']);
  assert.deepEqual(await ran('--exclude-tag', 'slow'), ['/users/1', '/users/1'], 'untagged kept');
  const typo = await cli(['run', file, '--tag', 'smok']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /tagged “smok”.*Did you mean “smoke”.*Tags: slow, smoke, users/);
  const none = await cli(['run', file, '-t', 'smoke', '--exclude-tag', 'users']);
  assert.match(none.err, /No request is tagged smoke, not users/);
  const json = path.join(root, 'tagged-report.json');
  await cli(['run', file, '-t', 'smoke', '--report-json', json]);
  assert.equal(JSON.parse(await fs.readFile(json, 'utf8')).tags, 'smoke');

  const listed = await cli(['list', file, '--tag', 'users']);
  assert.match(listed.out, /One {2}#smoke #users/);
  assert.doesNotMatch(listed.out, /Plain/);
  const listedJson = JSON.parse((await cli(['list', file, '--json'])).out);
  assert.deepEqual(listedJson.requests[0].tags, ['smoke', 'users']);
});

test('collection and folder tags choose the requests inside them', async () => {
  const file = path.join(root, 'folder-tagged.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      requests: [
        { name: 'Read', folder: 'Shop/Read', method: 'GET', url: `${base}/users/1` },
        { name: 'Other', folder: 'Shop', method: 'GET', url: `${base}/users/2`, tags: ['own'] },
      ],
      collectionTags: { Shop: ['shop'], 'Shop/Read': ['reads'] },
    }),
  );
  const before = seen.length;
  const result = await cli(['run', file, '--tag', 'reads']);
  assert.equal(result.code, 0, result.out + result.err);
  assert.deepEqual(
    seen.slice(before).map((entry) => entry.url),
    ['/users/1'],
  );
  const all = await cli(['run', file, '--tag', 'shop']);
  assert.match(all.out, /2 requests: 2 passed/, 'the collection tag is on every request in it');
  const listed = await cli(['list', file]);
  assert.match(listed.out, /Read {2}#shop #reads/);
  assert.match(listed.out, /Other {2}#shop #own/);
});
