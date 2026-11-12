import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './script-engine';
import {
  SCRIPT_SNIPPETS,
  SNIPPET_GROUPS,
  normalizedSnippets,
  snippetInsertion,
  snippetProblem,
  snippetsFor,
} from './script-snippets';
import type { ScriptInput } from './scripts';

const request = {
  name: 'Create order',
  method: 'POST',
  url: 'https://api.example.test/orders',
  headers: [{ enabled: true, key: 'X-Debug', value: '1' }],
  body: '{"item":"book"}',
};
const response = {
  status: 201,
  statusText: 'Created',
  headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc' },
  body: '{"id":42,"status":"active","items":[{"sku":"b1"}]}',
  time: 85,
  size: 52,
  url: 'https://api.example.test/orders',
};
const libraries = [{ name: 'helpers', source: 'exports.functionName = (value) => value;' }];

test('every snippet runs where it is offered, without an error', async () => {
  for (const snippet of SCRIPT_SNIPPETS)
    for (const place of snippet.places) {
      // A module's snippet runs as a library module required by a script.
      const input: ScriptInput =
        place === 'module'
          ? {
              phase: 'post',
              source: "aw.require('snippet');",
              request,
              response,
              variables: { token: 'a.eyJzdWIiOiIxIn0.c' },
            }
          : {
              phase: place,
              source: snippet.code,
              request,
              ...(place === 'post' ? { response } : {}),
              variables: { token: 'a.eyJzdWIiOiIxIn0.c', username: 'ada', password: 'pw' },
            };
      const output = await runScript({
        ...input,
        libraries: [
          ...libraries,
          ...(place === 'module' ? [{ name: 'snippet', source: snippet.code }] : []),
        ],
      });
      assert.equal(output.ok, true, `${snippet.id} in ${place}: ${output.error}`);
    }
});

test('snippets have unique ids, known groups, and a place', () => {
  const ids = SCRIPT_SNIPPETS.map((snippet) => snippet.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const snippet of SCRIPT_SNIPPETS) {
    assert.ok((SNIPPET_GROUPS as readonly string[]).includes(snippet.group), snippet.id);
    assert.ok(snippet.places.length, snippet.id);
  }
});

test('snippets are found by place and by words in any order', () => {
  assert.ok(snippetsFor('pre').some((snippet) => snippet.id === 'set-header'));
  assert.ok(!snippetsFor('post').some((snippet) => snippet.id === 'set-header'));
  assert.ok(!snippetsFor('pre').some((snippet) => snippet.id === 'status-200'));
  const found = snippetsFor('post', 'json VALUE').map((snippet) => snippet.id);
  assert.ok(found.includes('json-value') && found.includes('save-json'), found.join());
  assert.ok(!found.includes('status-200'));
  assert.deepEqual(snippetsFor('post', 'no such snippet'), []);
  assert.deepEqual(
    snippetsFor('module', 'export function').map((snippet) => snippet.id),
    ['require-module', 'export-function', 'export-checks'],
  );
});

test('a snippet goes on a line of its own', () => {
  assert.equal(snippetInsertion('', 0, 'a();'), 'a();\n');
  assert.equal(snippetInsertion('x();', 4, 'a();'), '\na();\n');
  assert.equal(snippetInsertion('x();\n', 5, 'a();'), 'a();\n');
  assert.equal(snippetInsertion('x();\n  ', 7, 'a();'), 'a();\n');
});

test('saved snippets come first, for their places, and are found by search', () => {
  const custom = [
    {
      id: 's1',
      title: 'Check our error format',
      places: ['post' as const],
      code: 'aw.test("x", () => {});',
    },
    {
      id: 's2',
      title: 'Sign with our key',
      description: 'HMAC',
      places: ['pre' as const, 'module' as const],
      code: 'x();',
    },
  ];
  const post = snippetsFor('post', '', custom);
  assert.deepEqual(post[0], { ...custom[0], group: 'My snippets', description: '', custom: true });
  assert.ok(!post.some((snippet) => snippet.id === 's2'), 'only where it is meant to be used');
  assert.deepEqual(
    snippetsFor('pre', 'hmac', custom).map((snippet) => snippet.id),
    ['s2', 'hmac-body'],
  );
});

test('a saved snippet needs a title, a place, and code; a file keeps only valid ones', () => {
  const valid = { title: 'A', places: ['pre' as const], code: 'x();' };
  assert.equal(snippetProblem(valid), undefined);
  assert.match(snippetProblem({ ...valid, title: ' ' })!, /title/);
  assert.match(snippetProblem({ ...valid, places: [] })!, /place/);
  assert.match(snippetProblem({ ...valid, code: '' })!, /code/);
  assert.deepEqual(
    normalizedSnippets([
      { id: 'a', ...valid, places: ['pre', 'elsewhere'] },
      { id: 'a', ...valid, title: 'duplicate id' },
      { id: 'b', ...valid, code: 1 },
      { id: 'c', ...valid, places: ['elsewhere'] },
      'junk',
    ]),
    [{ id: 'a', ...valid }],
  );
  assert.equal(normalizedSnippets({}), undefined);
});
