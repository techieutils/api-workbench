import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ListedRequest } from './model';
import {
  formatBytes,
  outcomes,
  selectionArgs,
  statusLine,
  type RunReport,
  type SendResult,
} from './report';

const listed = (id: string, runnable = true): ListedRequest => ({
  id,
  name: id,
  folder: 'Shop',
  method: 'GET',
  protocol: runnable ? 'http' : 'websocket',
  runnable,
});
const all = [listed('a'), listed('b'), listed('c'), listed('live', false)];

test('every runnable request is a plain run; some are chosen by id', () => {
  assert.deepEqual(selectionArgs(all, all), [], 'all of them, live ones aside');
  assert.deepEqual(selectionArgs([listed('a'), listed('b'), listed('c')], all), []);
  assert.deepEqual(selectionArgs([listed('b'), listed('a'), listed('b')], all), [
    '-r',
    'b',
    '-r',
    'a',
  ]);
  // The command line cannot run live protocol requests, so they are never asked for.
  assert.deepEqual(selectionArgs([listed('a'), listed('live', false)], all), ['-r', 'a']);
  assert.equal(selectionArgs([listed('live', false)], all), undefined);
  assert.equal(selectionArgs([], all), undefined);
});

const sent = (id: string, extra: Partial<SendResult> = {}): SendResult => ({
  request: { id, name: id, method: 'GET', folder: 'Shop' },
  url: `https://api.example.com/${id}`,
  status: 200,
  statusText: 'OK',
  durationMs: 40,
  tests: [{ label: 'status 200', pass: true, message: '' }],
  captures: [],
  passed: true,
  ...extra,
});
const report = (results: SendResult[]): RunReport => ({
  passed: results.every((result) => result.passed),
  summary: {
    requests: results.length,
    failed: 0,
    skipped: 0,
    tests: 0,
    testsFailed: 0,
    elapsedMs: 1,
  },
  results,
});

test('each request’s outcome, with what failed', () => {
  const found = outcomes(
    report([
      sent('a'),
      sent('b', {
        status: 404,
        statusText: 'Not Found',
        passed: false,
        tests: [{ label: 'status 200', pass: false, message: 'Actual status: 404' }],
      }),
      sent('c', { status: undefined, error: 'fetch failed', tests: [], passed: false }),
      sent('d', { status: 500, tests: [], passed: false }),
    ]),
  );
  assert.deepEqual(found.get('a'), {
    state: 'passed',
    durationMs: 40,
    messages: [],
    summary: '200 OK · 40 ms',
  });
  assert.equal(found.get('b')?.state, 'failed');
  assert.deepEqual(found.get('b')?.messages, ['status 200 — Actual status: 404']);
  assert.equal(found.get('c')?.state, 'errored');
  assert.deepEqual(found.get('c')?.messages, ['fetch failed']);
  assert.equal(found.get('c')?.summary, 'No response · fetch failed');
  // Without tests, a request passes on 200–399.
  assert.deepEqual(found.get('d')?.messages, ['Status 500 is outside 200–399']);
});

test('a request sent several times passes only when every send passed', () => {
  const found = outcomes(
    report([
      sent('a', { iteration: 1 }),
      sent('a', {
        iteration: 2,
        passed: false,
        tests: [{ label: 'json $.id exists', pass: false, message: 'no value' }],
      }),
    ]),
  );
  assert.equal(found.get('a')?.state, 'failed');
  assert.equal(found.get('a')?.durationMs, 80);
  assert.deepEqual(found.get('a')?.messages, ['Send 2: json $.id exists — no value']);
});

test('sizes and status lines read as the app shows them', () => {
  assert.equal(formatBytes(412), '412 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(statusLine(sent('a', { size: 412, durationMs: 84.4 })), '200 OK · 84 ms · 412 B');
});
