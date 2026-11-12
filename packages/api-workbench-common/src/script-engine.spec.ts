import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runScript } from './script-engine';
import {
  applyScriptVariables,
  moduleNameProblem,
  normalizedLibrary,
  scriptInputProblem,
  runScriptSteps,
  scriptHostProblem,
  scriptAssertions,
  scriptSteps,
  stepScope,
  withScriptRequest,
  type ScriptInput,
} from './scripts';
import type { ApiRequest } from './types';

const request = {
  name: 'Create order',
  method: 'POST',
  url: 'https://api.example.test/orders?limit=5',
  headers: [{ enabled: true, key: 'Accept', value: 'application/json' }],
  body: '{"item":"book"}',
};
const response = {
  status: 201,
  statusText: 'Created',
  headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc' },
  body: '{"id":42,"items":[{"sku":"b1"}],"total":12.5}',
  time: 85,
  size: 44,
  url: 'https://api.example.test/orders',
};
const pre = (source: string, variables: Record<string, string> = {}): ScriptInput => ({
  phase: 'pre',
  source,
  request,
  variables,
});
const post = (source: string, variables: Record<string, string> = {}): ScriptInput => ({
  phase: 'post',
  source,
  request,
  response,
  variables,
});

test('a pre-request script reads and sets variables and changes the request', async () => {
  const output = await runScript(
    pre(
      `
      const token = aw.vars.get('token');
      aw.vars.set('stamp', 1700000000);
      aw.vars.unset('old');
      aw.request.headers.set('Authorization', 'Bearer ' + token);
      aw.request.headers.set('accept', 'text/plain');
      aw.request.url = aw.request.url.replace('limit=5', 'limit=10');
      aw.request.method = 'put';
      aw.request.body = { item: 'pen' };
      aw.log('signed', { token });
    `,
      { token: 't-1', old: 'x' },
    ),
  );
  assert.equal(output.ok, true, output.error ?? '');
  assert.deepEqual(output.variables, { stamp: '1700000000', old: null });
  assert.equal(output.request?.method, 'PUT');
  assert.equal(output.request?.url, 'https://api.example.test/orders?limit=10');
  assert.deepEqual(output.request?.headers, [
    { enabled: true, key: 'Accept', value: 'text/plain' },
    { enabled: true, key: 'Authorization', value: 'Bearer t-1' },
  ]);
  assert.equal(output.request?.body, '{"item":"pen"}');
  assert.deepEqual(output.logs, [{ level: 'log', message: 'signed {"token":"t-1"}' }]);
});

test('a script that changes nothing leaves the request alone', async () => {
  const output = await runScript(pre('aw.vars.set("a", "b")'));
  assert.equal(output.ok, true);
  assert.equal(output.request, undefined);
});

test('post-response tests pass and fail with readable messages', async () => {
  const output = await runScript(
    post(`
      const body = aw.response.json();
      aw.test('created', () => aw.expect(aw.response.status).toBe(201));
      aw.test('has id', () => aw.expect(body).toHaveProperty('id', 42));
      aw.test('json header', () => aw.expect(aw.response.headers.get('content-type')).toContain('json'));
      aw.test('fast', () => aw.expect(aw.response.time).toBeLessThan(50));
      aw.test('not empty', () => aw.expect(body.items).not.toHaveLength(0));
      aw.test('sku', () => aw.expect(body.items[0]).toEqual({ sku: 'b1' }));
      aw.test('assert', () => aw.assert(body.total > 100, 'total too small'));
      aw.vars.set('order_id', body.id);
    `),
  );
  assert.equal(output.ok, true, output.error ?? '');
  assert.deepEqual(
    output.tests.map((item) => [item.name, item.pass]),
    [
      ['created', true],
      ['has id', true],
      ['json header', true],
      ['fast', false],
      ['not empty', true],
      ['sku', true],
      ['assert', false],
    ],
  );
  assert.equal(output.tests[3].message, 'Expected: 85 < 50');
  assert.equal(output.tests[6].message, 'total too small');
  assert.deepEqual(output.variables, { order_id: '42' });
});

test('the request cannot be changed after the response', async () => {
  const output = await runScript(post('aw.request.url = "https://elsewhere.test"'));
  assert.equal(output.ok, false);
  assert.match(output.error!, /only in a pre-request script/);
});

test('helpers hash, sign, and encode through the host', async () => {
  const output = await runScript(
    pre(`
      aw.vars.set('sha', aw.crypto.sha256('abc'));
      aw.vars.set('hmac', aw.crypto.hmac('sha256', 'key', 'data', 'base64'));
      aw.vars.set('b64', btoa('héllo'));
      aw.vars.set('back', atob(aw.base64.encode('héllo')));
      aw.vars.set('uuid', aw.uuid());
      aw.vars.set('random', aw.crypto.randomBytes(8));
    `),
  );
  assert.equal(output.ok, true, output.error ?? '');
  assert.equal(
    output.variables.sha,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(output.variables.hmac, createHmac('sha256', 'key').update('data').digest('base64'));
  assert.equal(output.variables.b64, Buffer.from('héllo').toString('base64'));
  assert.equal(output.variables.back, 'héllo');
  assert.match(output.variables.uuid!, /^[0-9a-f-]{36}$/);
  assert.match(output.variables.random!, /^[0-9a-f]{16}$/);
});

test('scripts have no Node.js, network, files, or timers', async () => {
  const output = await runScript(
    pre(`
      aw.vars.set('kinds', [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof __host, typeof __input, typeof XMLHttpRequest].join(','));
    `),
  );
  assert.equal(output.ok, true, output.error ?? '');
  assert.equal(
    output.variables.kinds,
    'undefined,undefined,undefined,undefined,undefined,undefined,undefined',
  );
});

test('a runaway script is stopped, and what it logged is kept', async () => {
  const started = Date.now();
  const output = await runScript(pre('aw.log("starting"); for (;;) {}'));
  assert.equal(output.ok, false);
  assert.match(output.error!, /ran longer than 2 seconds/);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(output.logs, [{ level: 'log', message: 'starting' }]);
});

test('a script that uses too much memory is stopped', async () => {
  const output = await runScript(
    pre('const parts = []; for (;;) parts.push("x".repeat(1e6) + parts.length);'),
  );
  assert.equal(output.ok, false);
  assert.match(output.error!, /memory|longer than/);
});

test('a thrown error reports its line, and earlier tests still count', async () => {
  const output = await runScript(
    post(`aw.test('first', () => {});
      const missing = undefined;
      missing.value;`),
  );
  assert.equal(output.ok, false);
  assert.match(output.error!, /TypeError: .*\(line 3\)/);
  assert.deepEqual(output.tests, [{ name: 'first', pass: true }]);
  const results = scriptAssertions('post', output);
  assert.deepEqual(
    results.map((item) => [item.name, item.pass]),
    [
      ['first', true],
      ['Post-response script error', false],
    ],
  );
});

test('a syntax error fails the script without running it', async () => {
  const output = await runScript(pre('aw.vars.set("a", 1'));
  assert.equal(output.ok, false);
  assert.match(output.error!, /SyntaxError/);
  assert.deepEqual(output.variables, {});
});

test('async test functions are refused rather than passing early', async () => {
  const output = await runScript(post('aw.test("later", async () => { throw new Error("no"); });'));
  assert.equal(output.tests[0].pass, false);
  assert.match(output.tests[0].message!, /synchronously/);
});

test('script changes apply to environments and request copies', () => {
  const variables = [
    { enabled: false, key: 'a', value: '1' },
    { enabled: true, key: 'b', value: '2' },
  ];
  assert.deepEqual(applyScriptVariables(variables, { a: 'x', b: null, c: 'y' }), ['a', 'b', 'c']);
  assert.deepEqual(variables, [
    { enabled: true, key: 'a', value: 'x' },
    { enabled: true, key: 'c', value: 'y' },
  ]);
  const saved = {
    id: 'r1',
    name: 'Create order',
    method: 'POST',
    url: 'https://api.example.test/orders?limit=5',
    folder: 'Shop',
    params: [{ enabled: true, key: 'limit', value: '5' }],
    headers: [],
    body: '{}',
    bodyType: 'raw',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
    response: null,
  } as ApiRequest;
  const copy = withScriptRequest(saved, {
    ...request,
    url: 'https://api.example.test/orders?limit=9&page=2',
  });
  assert.deepEqual(
    copy.params.map((param) => [param.key, param.value]),
    [
      ['limit', '9'],
      ['page', '2'],
    ],
  );
  assert.equal(saved.url, 'https://api.example.test/orders?limit=5');
  assert.equal(copy.body, '{"item":"book"}');
});

test('collection and folder scripts run before the request, outside in, and pass changes along', async () => {
  const workspace = {
    collectionScripts: {
      Shop: {
        pre: "aw.vars.set('order', ['shop']); aw.request.headers.set('X-Tenant', 'acme');",
        post: "aw.test('shop check', () => aw.expect(aw.response.status).toBe(201));",
      },
      'Shop/Orders': {
        pre: "aw.vars.set('order', [...JSON.parse(aw.vars.get('order')), 'orders']); aw.request.url += '&tenant=' + aw.request.headers.get('x-tenant');",
        post: "aw.test('folder fails', () => aw.expect(1).toBe(2));",
      },
      Elsewhere: { pre: "aw.vars.set('wrong', 'yes');" },
    },
  };
  const saved = {
    id: 'r',
    name: 'Create order',
    folder: 'Shop/Orders',
    scripts: {
      pre: "aw.vars.set('order', [...JSON.parse(aw.vars.get('order')), 'request']);",
      post: "aw.test('request check', () => aw.expect(aw.response.json().id).toBe(42));",
    },
  } as ApiRequest;
  const steps = scriptSteps(workspace, saved, 'pre');
  assert.deepEqual(
    steps.map((step) => stepScope(step) ?? 'request'),
    ['Shop', 'Shop / Orders', 'request'],
  );
  const variables: Record<string, string> = {};
  const pre = await runScriptSteps(steps, {
    request,
    variables: () => ({ ...variables }),
    run: runScript,
    applied: ({ output }) => Object.assign(variables, output.variables),
  });
  assert.equal(pre.failed, undefined);
  assert.equal(variables.order, '["shop","orders","request"]');
  assert.equal(variables.wrong, undefined, 'only the request’s own collection and folders run');
  assert.equal(pre.request?.url, 'https://api.example.test/orders?limit=5&tenant=acme');
  assert.ok(pre.request?.headers.some((header) => header.key === 'X-Tenant'));

  // After the response, every script runs, even after one fails.
  const post = await runScriptSteps(scriptSteps(workspace, saved, 'post'), {
    request,
    response,
    variables: () => ({}),
    run: runScript,
    applied: () => undefined,
  });
  assert.deepEqual(
    post.results.flatMap(({ step, output }) =>
      scriptAssertions('post', output, stepScope(step)).map((item) => [item.label, item.pass]),
    ),
    [
      ['Shop · Post-response script', true],
      ['Shop / Orders · Post-response script', false],
      ['Post-response script', true],
    ],
  );

  // Before sending, the first failure stops the rest.
  const stopped = await runScriptSteps(
    scriptSteps({ collectionScripts: { Shop: { pre: 'throw new Error("no")' } } }, saved, 'pre'),
    { request, variables: () => ({}), run: runScript, applied: () => undefined },
  );
  assert.equal(stopped.results.length, 1);
  assert.equal(stopped.failed?.step.folder, 'Shop');
});

test('the workspace script runs first, before collection, folder, and request scripts', () => {
  const steps = scriptSteps(
    {
      workspaceScripts: { pre: 'aw.vars.set("a", "1")', post: '  ' },
      collectionScripts: { Shop: { pre: '1' } },
    },
    { folder: 'Shop/Orders', scripts: { pre: '2' } } as ApiRequest,
    'pre',
  );
  assert.deepEqual(
    steps.map((step) => stepScope(step) ?? 'request'),
    ['Workspace', 'Shop', 'request'],
  );
  assert.deepEqual(
    scriptSteps({ workspaceScripts: { post: '  ' } }, { folder: 'Shop' } as ApiRequest, 'post'),
    [],
    'a blank workspace script is not run',
  );
});

test('aw.log, aw.info, aw.warn, and aw.error write lines at their level; there is no console', async () => {
  const output = await runScript(
    pre(
      "aw.log('a', 1); aw.info('b'); aw.warn('c'); aw.error('d', { e: 1 }); aw.vars.set('console', typeof console);",
    ),
  );
  assert.equal(output.ok, true, output.error ?? '');
  assert.deepEqual(output.logs, [
    { level: 'log', message: 'a 1' },
    { level: 'info', message: 'b' },
    { level: 'warn', message: 'c' },
    { level: 'error', message: 'd {"e":1}' },
  ]);
  assert.equal(output.variables.console, 'undefined');
  const old = await runScript(pre("console.log('x')"));
  assert.equal(old.ok, false);
  assert.equal(
    old.error,
    "ReferenceError: 'console' is not defined (line 1). Write to the console with aw.log, aw.info, aw.warn, or aw.error.",
  );
});

test('library modules are shared with aw.require, once per script, and can require each other', async () => {
  const libraries = [
    {
      name: 'signing',
      source:
        "const { hex } = require('format');\nexports.calls = 0;\nexports.sign = (text) => { exports.calls++; return hex(aw.crypto.hmac('sha256', 'key', text)); };",
    },
    { name: 'format', source: "module.exports = { hex: (value) => 'hex:' + value.slice(0, 8) };" },
    { name: 'broken', source: 'exports.x = ;' },
  ];
  const output = await runScript({
    ...pre(`
      const { sign } = aw.require('signing');
      aw.vars.set('signature', sign('body'));
      sign('again');
      aw.vars.set('calls', aw.require('signing').calls);
    `),
    libraries,
  });
  assert.equal(output.ok, true, output.error ?? '');
  assert.equal(
    output.variables.signature,
    'hex:' + createHmac('sha256', 'key').update('body').digest('hex').slice(0, 8),
  );
  assert.equal(output.variables.calls, '2', 'a module runs once and keeps its state');

  const missing = await runScript({ ...pre("aw.require('nope')"), libraries });
  assert.match(missing.error!, /no library module named nope/);
  const broken = await runScript({ ...pre("aw.require('broken')"), libraries });
  assert.match(broken.error!, /library module broken has an error: SyntaxError/);

  const thrown = await runScript({
    ...pre("aw.require('fails').run()"),
    libraries: [{ name: 'fails', source: '\nexports.run = () => {\n  null.x;\n};' }],
  });
  assert.match(thrown.error!, /TypeError: .*\(library fails, line 3\)/);
});

test('requiring a paused library module pauses the script', async () => {
  const output = await runScript({
    ...pre("aw.vars.set('before', '1'); try { aw.require('helpers'); } catch {} "),
    libraries: [{ name: 'helpers', paused: true }],
  });
  assert.equal(output.ok, false);
  assert.equal(output.paused, true);
  assert.match(output.error!, /helpers came from outside API Workbench/);
  // A paused module that is never required does not matter.
  const unused = await runScript({
    ...pre("aw.vars.set('a', '1')"),
    libraries: [{ name: 'helpers', paused: true }],
  });
  assert.equal(unused.ok, true);
});

test('library names are file names; a library from a file keeps only valid modules', () => {
  assert.equal(moduleNameProblem('signing-v2'), undefined);
  assert.match(moduleNameProblem('../x')!, /Start with a letter/);
  assert.match(moduleNameProblem('Signing', ['signing'])!, /already a module/);
  assert.deepEqual(
    normalizedLibrary([
      { name: 'a', source: 'x' },
      { name: 'A', source: 'duplicate' },
      { name: 'b/c', source: 'bad name' },
      { name: 'd', source: 1 },
    ]),
    [{ name: 'a', source: 'x' }],
  );
  assert.equal(
    scriptInputProblem({ ...pre('1'), libraries: [{ name: '../escape', source: '' }] }),
    'The script library is not valid.',
  );
});

test('pre-request scripts may change a request but not the host it goes to', () => {
  const api = 'https://api.example.test';
  // Path, query, and port-less spellings of the same origin are fine.
  assert.equal(scriptHostProblem(`${api}/users`, `${api}/users/2?expand=1`), undefined);
  assert.equal(
    scriptHostProblem('api.example.test/users', 'http://api.example.test/v2'),
    undefined,
  );
  assert.equal(scriptHostProblem('https://api.example.test:443/a', `${api}/b`), undefined);
  // Another host, scheme, or port is refused, and so is a host a script supplied itself.
  for (const after of [
    'https://collector.example.test/users',
    'http://api.example.test/users',
    'https://api.example.test:8443/users',
    'https://user:pass@collector.example.test/',
  ])
    assert.match(
      scriptHostProblem(`${api}/users`, after) ?? '',
      /changed where this request is sent/,
    );
  assert.match(
    scriptHostProblem('{{base_url}}/users', 'https://collector.example.test/users') ?? '',
    /sent to https:\/\/collector\.example\.test\./,
  );
  // A URL with no host yet is left to the request's own validation.
  assert.equal(scriptHostProblem(`${api}/users`, '{{base_url}}/users'), undefined);
});
