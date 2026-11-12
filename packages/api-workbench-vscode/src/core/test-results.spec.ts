import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testResultsView } from './test-results';

test('a finished run becomes the Test results page: summary, outcomes, and plain output', () => {
  const view = testResultsView(
    {
      passed: false,
      summary: { requests: 3, failed: 2, skipped: 1, tests: 3, testsFailed: 1, elapsedMs: 250 },
      results: [
        {
          request: { id: 'a', name: 'List', method: 'GET', folder: 'Users' },
          status: 200,
          statusText: 'OK',
          durationMs: 50,
          tests: [{ label: 'status 200', pass: true, message: '' }],
          captures: [],
          passed: true,
        },
        {
          request: { id: 'b', name: 'Create', method: 'POST', folder: 'Users' },
          status: 422,
          statusText: 'Unprocessable Entity',
          tests: [{ label: 'status 201', pass: false, message: 'was 422', line: 1 }],
          captures: [],
          passed: false,
        },
        {
          request: { id: 'c', name: 'Gone', method: 'GET', folder: 'Users' },
          error: 'ECONNREFUSED',
          tests: [],
          captures: [],
          passed: false,
        },
      ],
    },
    '\u001b[32m✓\u001b[0m List',
    { workspace: 'Shop', scope: 'Users', environment: 'Staging', finishedAt: '10:00' },
  );
  assert.deepEqual(view.summary, {
    requests: 3,
    passed: 1,
    failed: 1,
    errored: 1,
    skipped: 1,
    tests: 3,
    testsFailed: 1,
    durationMs: 250,
  });
  assert.deepEqual(
    view.results.map((row) => [row.state, row.status]),
    [
      ['passed', '200 OK'],
      ['failed', '422 Unprocessable Entity'],
      ['errored', 'No response'],
    ],
  );
  assert.deepEqual(view.results[1].tests, [
    { label: 'status 201', pass: false, message: 'was 422' },
  ]);
  assert.equal(view.output, '✓ List', 'colour codes left out');
});
