import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedSpan,
  diffHeaders,
  diffLines,
  foldRows,
  normalizeBody,
  sideBySide,
  unifiedDiff,
} from './diff';

test('Myers line diff produces a minimal edit script', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])!;
  assert.deepEqual(
    ops.map((op) => `${op.type[0]}${op.text}`),
    ['ea', 'db', 'ix', 'ec', 'ed', 'ie'],
  );
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(
    diffLines(['x'], [])!.map((op) => op.type),
    ['delete'],
  );
  assert.deepEqual(
    diffLines([], ['x'])!.map((op) => op.type),
    ['insert'],
  );
  assert.equal(
    diffLines(
      Array.from({ length: 50 }, (_, i) => `a${i}`),
      Array.from({ length: 50 }, (_, i) => `b${i}`),
      10,
    ),
    undefined,
    'large edit distances bail out',
  );
});

test('side-by-side rows pair changes and count additions and removals', () => {
  const result = sideBySide(
    '{\n  "id": 1,\n  "name": "Ada",\n  "old": true\n}',
    '{\n  "id": 1,\n  "name": "Grace",\n  "new": 2,\n  "extra": 3\n}',
  );
  assert.deepEqual(
    result.rows.map((row) => row.kind),
    ['equal', 'equal', 'change', 'change', 'insert', 'equal'],
  );
  assert.deepEqual([result.added, result.removed, result.truncated], [3, 2, false]);
  const change = result.rows[2];
  assert.deepEqual(
    [change.left!.line, change.right!.line, change.left!.text, change.right!.text],
    [3, 3, '  "name": "Ada",', '  "name": "Grace",'],
  );
  assert.deepEqual(result.rows.at(-1)!.left!.line, 5);
  assert.deepEqual(result.rows.at(-1)!.right!.line, 6);
  const fallback = sideBySide('a\nb', 'c\nd\ne', 1);
  assert.equal(fallback.truncated, true);
  assert.equal(fallback.rows.length, 3);
});

test('changed spans, folding, JSON normalization, headers, and unified output', () => {
  assert.deepEqual(changedSpan('"name": "Ada",', '"name": "Grace",'), { prefix: 9, suffix: 2 });
  assert.deepEqual(changedSpan('same', 'same'), { prefix: 4, suffix: 0 });
  const rows = sideBySide(
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
    Array.from({ length: 20 }, (_, i) => (i === 10 ? 'changed' : `line ${i}`)).join('\n'),
  ).rows;
  const folded = foldRows(rows, 2);
  assert.deepEqual(
    folded.map((row) => ('hidden' in row ? `fold${row.hidden}` : row.kind)),
    ['fold8', 'equal', 'equal', 'change', 'equal', 'equal', 'fold7'],
  );
  assert.deepEqual(normalizeBody('{"b":1,"a":{"d":1,"c":2}}', true), {
    text: '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}',
    json: true,
  });
  assert.deepEqual(normalizeBody('not json'), { text: 'not json', json: false });
  assert.deepEqual(
    diffHeaders(
      { 'Content-Type': 'json', ETag: 'a', Date: 'x', Old: '1' },
      { 'content-type': 'json', etag: 'b', date: 'y', new: '2' },
      ['date'],
    ),
    [
      { name: 'content-type', kind: 'same', before: 'json', after: 'json' },
      { name: 'etag', kind: 'changed', before: 'a', after: 'b' },
      { name: 'new', kind: 'added', before: undefined, after: '2' },
      { name: 'old', kind: 'removed', before: '1', after: undefined },
    ],
  );
  assert.equal(
    unifiedDiff(sideBySide('a\nb', 'a\nc').rows, 'before', 'after'),
    '--- before\n+++ after\n a\n-b\n+c',
  );
});
