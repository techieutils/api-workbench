import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionsAt, scriptPath, scriptRef, syntaxProblem } from './scripts';

test('a script’s document path names its request and phase, and reads back', () => {
  const ref = { source: 'team:/repo/api', request: 'list/1', phase: 'pre' as const };
  const path = scriptPath(ref, 'List users: all/active');
  assert.match(path, /\/List users- all-active · pre-request\.js$/);
  assert.deepEqual(scriptRef(path), ref);
  assert.equal(scriptRef('/x/y/during/name.js'), undefined);
  assert.equal(scriptRef('/'), undefined);
});

test('suggestions are the app’s: aw members, then names in string arguments', () => {
  const context = {
    phase: 'post' as const,
    variables: ['base_url', 'token'],
    modules: [],
    requestHeaders: ['Accept'],
    responseHeaders: ['content-type'],
    responseJson: { users: [{ id: 1 }] },
  };
  const members = completionsAt('aw.', context, false);
  assert.ok(members?.items.some((item) => item.label === 'response'));
  assert.equal(members?.from, 3);
  const names = completionsAt("aw.vars.get('to", context, false);
  assert.deepEqual(
    names?.items.map((item) => item.label),
    ['token'],
  );
  const calls = completionsAt('aw.response.', context, false);
  assert.ok(
    calls?.items.some((item) => item.call),
    'functions are inserted with parentheses',
  );
});

test('syntax errors are found by parsing, never by running', () => {
  assert.equal(syntaxProblem("aw.vars.set('a', 1);"), undefined);
  const problem = syntaxProblem('aw.vars.set(\n  ;');
  assert.equal(problem?.line, 2);
  // Text that would loop forever if run is only parsed.
  assert.equal(syntaxProblem('while (true) {}'), undefined);
});
