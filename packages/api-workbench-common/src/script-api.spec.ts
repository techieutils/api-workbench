import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './script-engine';
import {
  SCRIPT_API,
  SCRIPT_GLOBALS,
  scriptCompletions,
  type ScriptApiTypeName,
  type ScriptCompletionContext,
} from './script-api';

const context: ScriptCompletionContext = {
  phase: 'post',
  variables: ['base_url', 'token', 'user_id'],
  modules: ['signing', 'dates'],
  requestHeaders: ['Accept', 'Content-Type'],
  responseHeaders: ['content-type', 'x-request-id'],
  responseJson: { users: [{ id: 1, name: 'Ada', 'first-name': 'Ada' }], total: 1 },
};
/** The labels suggested with the cursor at the end of `text`. */
const labels = (text: string, more: Partial<ScriptCompletionContext> = {}) =>
  scriptCompletions(text, { ...context, ...more })?.options.map((option) => option.label);

// The description must match what scripts can really reach, or the editor suggests what fails.
test('the description lists exactly what the engine gives scripts', async () => {
  const keys = (expression: string) => `Object.keys(${expression}).sort().join(',')`;
  const objects: Record<ScriptApiTypeName, string> = {
    aw: 'aw',
    request: 'aw.request',
    requestHeaders: 'aw.request.headers',
    response: 'aw.response',
    responseHeaders: 'aw.response.headers',
    vars: 'aw.vars',
    crypto: 'aw.crypto',
    base64: 'aw.base64',
    expectation: 'aw.expect(1)',
  };
  const source = Object.entries(objects)
    .map(([type, expression]) => `aw.vars.set('${type}', ${keys(expression)});`)
    .join('\n');
  const output = await runScript({
    phase: 'post',
    source: `${source}\naw.vars.set('globals', ['aw', 'btoa', 'atob'].filter((name) => typeof globalThis[name] !== 'undefined').join(','));`,
    request: { name: 'r', method: 'GET', url: 'https://example.test', headers: [], body: '' },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      time: 1,
      size: 2,
      url: 'https://example.test',
    },
    variables: {},
  });
  assert.equal(output.ok, true, output.error ?? '');
  for (const type of Object.keys(objects) as ScriptApiTypeName[])
    assert.equal(
      output.variables[type],
      SCRIPT_API[type]
        .map((member) => member.name)
        .sort()
        .join(','),
      `the members of ${objects[type]}`,
    );
  assert.equal(output.variables.globals, SCRIPT_GLOBALS.map((member) => member.name).join(','));
});

test('members are suggested after a dot, all the way down', () => {
  assert.deepEqual(labels('aw.')?.slice(0, 3), ['phase', 'log', 'info']);
  assert.ok(labels('aw.req')?.includes('request'), 'the typed part is left to the editor to match');
  assert.deepEqual(labels('aw.request.headers.'), ['get', 'has', 'set', 'remove', 'toObject']);
  assert.deepEqual(labels('aw.base64.'), ['encode', 'decode']);
  assert.deepEqual(labels('aw?.vars.'), labels('aw.vars.'));
  assert.deepEqual(labels('aw\n  .crypto\n  .'), labels('aw.crypto.'));
});

test('suggestions describe each member', () => {
  const vars = scriptCompletions('aw.vars.', context)!;
  const get = vars.options.find((option) => option.label === 'get')!;
  assert.equal(get.kind, 'function');
  assert.equal(get.call, true);
  assert.equal(get.detail, '(name: string) => string | undefined');
  assert.match(get.doc!, /value of a variable/);
  assert.equal(vars.from, 'aw.vars.'.length);
  const typed = scriptCompletions('aw.vars.ge', context)!;
  assert.equal(typed.from, 'aw.vars.'.length, 'what was typed is replaced');
});

test('what a call returns has its own members', () => {
  assert.ok(labels('aw.expect(aw.response.status).')?.includes('toBe'));
  assert.ok(labels('aw.expect(aw.response.json().users).not.')?.includes('toContain'));
  assert.ok(labels('aw.expect(fn(a, (b)))\n  .')?.includes('toEqual'));
  assert.equal(labels('aw.log().'), undefined, 'aw.log returns nothing to suggest');
});

test('the last JSON response is followed into its keys', () => {
  assert.deepEqual(labels('aw.response.json().'), ['users', 'total']);
  assert.deepEqual(labels('aw.response.json().users[0].'), ['id', 'name']);
  assert.deepEqual(labels("aw.response.json()['users'][0]."), ['id', 'name']);
  assert.deepEqual(labels('aw.response.json().users.'), ['length']);
  const name = scriptCompletions('aw.response.json().users[0].', context)!.options[1];
  assert.equal(name.detail, 'string');
  assert.equal(labels('aw.response.json().missing.'), undefined);
  assert.equal(labels('aw.response.json().', { responseJson: undefined }), undefined);
});

test('names given to parts of the API keep their suggestions', () => {
  assert.deepEqual(labels('const body = aw.response.json();\nbody.users[0].'), ['id', 'name']);
  assert.ok(labels('let h = aw.request.headers\nh.')?.includes('set'));
  assert.ok(labels('const res = aw.response;\nconst data = res.json();\ndata.')?.includes('total'));
  assert.equal(labels('const x = somethingElse();\nx.'), undefined);
  // The last assignment before the cursor is the one that counts.
  assert.deepEqual(labels('let v = aw.vars;\nv = 1;\nlet v = aw.base64;\nv.'), [
    'encode',
    'decode',
  ]);
});

test('members of the other phase are marked, and ranked lower', () => {
  const pre = scriptCompletions('aw.', { ...context, phase: 'pre' })!;
  const response = pre.options.find((option) => option.label === 'response')!;
  assert.equal(response.boost, -1);
  assert.match(response.doc!, /Only in post-response scripts/);
  const set = scriptCompletions('aw.request.headers.', context)!.options.find(
    (option) => option.label === 'set',
  )!;
  assert.equal(set.boost, -1, 'headers cannot be changed after the response');
  // A library module runs in either phase, so nothing is marked there.
  const library = scriptCompletions('aw.', { ...context, phase: undefined })!;
  assert.equal(library.options.find((option) => option.label === 'response')!.boost, undefined);
});

test('a string argument lists what it names', () => {
  assert.deepEqual(labels("aw.vars.get('"), ['base_url', 'token', 'user_id']);
  assert.deepEqual(labels('aw.vars.set("us'), ['user_id']);
  assert.deepEqual(labels("aw.require('"), ['signing', 'dates']);
  assert.deepEqual(labels("aw.request.headers.get('con"), ['Content-Type']);
  assert.deepEqual(labels("aw.response.headers.has('x-"), ['x-request-id']);
  assert.ok(labels("aw.crypto.hmac('")?.includes('sha256'));
  // Names containing what was typed follow those starting with it.
  assert.deepEqual(labels("aw.vars.get('t", { variables: ['auth_token', 'token'] }), [
    'token',
    'auth_token',
  ]);
  const result = scriptCompletions("aw.vars.get('to", context)!;
  assert.equal(result.from, "aw.vars.get('".length);
  assert.equal(result.filtered, true);
});

test('arguments that name nothing listable get no suggestions', () => {
  assert.equal(labels("aw.test('"), undefined);
  assert.equal(labels("aw.vars.set('a', '"), undefined, 'only the first argument');
  assert.equal(labels("aw.vars.get('a') + '"), undefined);
  assert.equal(labels("aw.vars.get('zzz"), undefined);
});

test('the start of a name offers the globals, and Ctrl+Space with nothing typed', () => {
  assert.deepEqual(labels('a'), ['aw', 'btoa', 'atob']);
  assert.equal(labels('const x = '), undefined);
  assert.deepEqual(
    scriptCompletions('const x = ', context, true)?.options.map((option) => option.label),
    ['aw', 'btoa', 'atob'],
  );
});

test('numbers, spreads, and unknown objects suggest nothing', () => {
  assert.equal(labels('1.'), undefined);
  assert.equal(labels('[...'), undefined);
  assert.equal(labels('Math.'), undefined);
  assert.equal(labels('aw.nothing.'), undefined);
  assert.equal(labels('aw.request.method.'), undefined);
});

test('a long script is read only near the cursor', () => {
  const long = `${'// filler\n'.repeat(5000)}aw.vars.`;
  const result = scriptCompletions(long, context)!;
  assert.equal(result.from, long.length);
  assert.ok(result.options.some((option) => option.label === 'get'));
});
