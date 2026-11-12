import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  betweenCaptureFor,
  captureSourceForAssertion,
  captureVariableName,
  formatJSONPath,
  jsonPathAt,
  MAX_JSON_DEPTH,
  jsonPathAtLine,
} from './capture-suggestions';
import { captureValue } from './variables';
import type { HttpResponse } from './types';

const response = (body: string): HttpResponse => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  body,
  time: 1,
  size: body.length,
  url: 'http://localhost',
});
/** The path at the first occurrence of `marker` (or a character into it). */
const pathAt = (text: string, marker: string, into = 1) =>
  jsonPathAt(text, text.indexOf(marker) + into);

test('a click in JSON names the value under it, its key included', () => {
  const text = JSON.stringify(
    {
      data: { token: 'abc', items: [{ id: 7, tags: ['x', 'y'] }], 'first name': 'Ada' },
      ok: true,
      count: -1.5e3,
    },
    null,
    2,
  );
  assert.equal(pathAt(text, '"abc"'), '$.data.token');
  // The key and the colon belong to the property's value.
  assert.equal(pathAt(text, '"token"'), '$.data.token');
  assert.equal(pathAt(text, '"token":', 7), '$.data.token');
  assert.equal(pathAt(text, ': 7', 2), '$.data.items[0].id');
  assert.equal(pathAt(text, '"y"'), '$.data.items[0].tags[1]');
  assert.equal(pathAt(text, '"Ada"'), '$.data["first name"]');
  assert.equal(pathAt(text, 'true'), '$.ok');
  assert.equal(pathAt(text, '-1500', 3), '$.count');
  // Between values, the click is in the object that holds them.
  assert.equal(pathAt(text, '[\n', 1), '$.data.items');
  assert.equal(jsonPathAt(text, 0), '$');
  assert.equal(jsonPathAt('{"a": 1}\n', 9), '$');
  // A selection names the value that holds all of it.
  const from = text.indexOf('"x"');
  assert.equal(jsonPathAt(text, from, text.indexOf('"y"') + 3), '$.data.items[0].tags');
  // Compact JSON works the same.
  const compact = '{"a":[1,{"b":null}]}';
  assert.equal(pathAt(compact, 'null'), '$.a[1].b');
  assert.equal(pathAt('{"n": -1.5e+3, "m": 2}', '1.5e'), '$.n');
});

test('text that is not JSON has no path', () => {
  assert.equal(jsonPathAt('<html></html>', 2), undefined);
  assert.equal(jsonPathAt('{"a": 1} trailing', 2), undefined);
  assert.equal(jsonPathAt('{"a": }', 2), undefined);
  assert.equal(jsonPathAt('', 0), undefined);
});

test('paths quote keys that are not plain names', () => {
  assert.equal(
    formatJSONPath(['a', 0, 'b-c', 'with space', 'x.y']),
    '$.a[0].b-c["with space"]["x.y"]',
  );
  assert.equal(formatJSONPath([]), '$');
});

test('a selection in text becomes between markers that read it back', () => {
  const body = '<form><input name="csrf" value="tok-123"><input name="id" value="9"></form>';
  for (const selected of ['tok-123', '9', 'csrf']) {
    const from = body.indexOf(selected);
    const source = betweenCaptureFor(body, from, from + selected.length);
    assert.ok(source, selected);
    assert.equal(captureValue(source, response(body)), selected, source);
  }
  // Nothing before the selection, or nothing selected, cannot be captured this way.
  assert.equal(betweenCaptureFor(body, 0, 5), undefined);
  assert.equal(betweenCaptureFor(body, 4, 4), undefined);
});

test('the shortest unique markers are chosen', () => {
  const body = 'id=1;id=2;name=Ada;';
  const from = body.indexOf('2');
  const source = betweenCaptureFor(body, from, from + 1)!;
  assert.equal(source, 'between ";id=" ";"');
  assert.equal(captureValue(source, response(body)), '2');
  const at = body.indexOf('Ada');
  assert.equal(betweenCaptureFor(body, at, at + 3), 'between "e=" ";"');
});

test('capture names come from the last key, as snake_case, numbered when taken', () => {
  assert.equal(captureVariableName('$.data.accessToken', []), 'access_token');
  assert.equal(captureVariableName('$.items[0].id', []), 'id');
  assert.equal(captureVariableName('$.items[0].tags[1]', []), 'tags');
  assert.equal(captureVariableName('$["first name"]', []), 'first_name');
  assert.equal(captureVariableName('$', []), 'value');
  assert.equal(captureVariableName(undefined, [], 'selection'), 'selection');
  assert.equal(captureVariableName('$.id', ['id', 'id_2']), 'id_3');
});

test('a line of formatted JSON names the value on it', () => {
  const text = JSON.stringify({ user: { id: 7, tags: ['a'] }, ok: true }, null, 2);
  // {, "user": {, "id": 7,, "tags": [, "a", ], }, "ok": true, }
  assert.equal(jsonPathAtLine(text, 1), '$');
  assert.equal(jsonPathAtLine(text, 2), '$.user');
  assert.equal(jsonPathAtLine(text, 3), '$.user.id');
  assert.equal(jsonPathAtLine(text, 5), '$.user.tags[0]');
  // A closing bracket belongs to the value it closes.
  assert.equal(jsonPathAtLine(text, 6), '$.user.tags');
  assert.equal(jsonPathAtLine(text, 8), '$.ok');
  assert.equal(jsonPathAtLine(text, 99), undefined);
  assert.equal(jsonPathAtLine('not json', 1), undefined);
});

test('a test assertion names the capture of the value it checks', () => {
  const cases: [string, ReturnType<typeof captureSourceForAssertion>][] = [
    ['status 200', { source: 'status', name: 'status' }],
    ['status between 200 299', { source: 'status', name: 'status' }],
    ['response-time < 3000', { source: 'time', name: 'time_ms' }],
    ['response-size <= 1048576', { source: 'size', name: 'size_bytes' }],
    ['body-length between 1 10', { source: 'body | length', name: 'body_length' }],
    ['content-type application/json', { source: 'header content-type', name: 'content_type' }],
    ['header-exists ETag', { source: 'header ETag', name: 'ETag' }],
    [
      'header cache-control equals "no-store"',
      { source: 'header cache-control', name: 'cache-control' },
    ],
    ['body-contains ok', { source: 'body', name: 'body' }],
    ['body matches /x/', { source: 'body', name: 'body' }],
    ['json $.data.id equals 7', { source: '$.data.id', path: '$.data.id' }],
    ['json $["a b"] not-in [1, 2]', { source: '$["a b"]', path: '$["a b"]' }],
    [
      'json data.items[0].name contains "x y"',
      { source: '$.data.items[0].name', path: '$.data.items[0].name' },
    ],
    ['json-exists $.token', { source: '$.token', path: '$.token' }],
    ['json-type $.items array', { source: '$.items', path: '$.items' }],
    ['json-length $.items > 0', { source: '$.items | length', path: '$.items' }],
    ['json-schema {"type":"object"}', { source: '$', path: '$' }],
    ['json-schema $.data {"type":"object"}', { source: '$.data', path: '$.data' }],
    ['json-valid', undefined],
    ['unknown thing', undefined],
  ];
  for (const [assertion, expected] of cases)
    assert.deepEqual(captureSourceForAssertion(assertion), expected, assertion);
});

test('captures named for assertions read the value the assertion checked', () => {
  const res = response('{"data":{"id":7,"items":[1,2,3]}}');
  for (const [assertion, value] of [
    ['json $.data.id == 7', '7'],
    ['json-length $.data.items > 0', '3'],
    ['json data.id equals 7', '7'],
  ] as const)
    assert.equal(captureValue(captureSourceForAssertion(assertion)!.source, res), value, assertion);
});

test('a deeply nested body gets no path, quickly, instead of exhausting memory', () => {
  // Found by fuzzing: 23,000 `[` took more than 1 GB, as each level copied its path.
  const deep = '['.repeat(50_000) + ']'.repeat(50_000);
  const started = Date.now();
  assert.equal(jsonPathAt(deep, 25_000), undefined);
  assert.ok(Date.now() - started < 1000);
  // Real nesting still works, up to the limit.
  const nested = '['.repeat(MAX_JSON_DEPTH) + '7' + ']'.repeat(MAX_JSON_DEPTH);
  assert.equal(jsonPathAt(nested, MAX_JSON_DEPTH), `$${'[0]'.repeat(MAX_JSON_DEPTH)}`);
});
