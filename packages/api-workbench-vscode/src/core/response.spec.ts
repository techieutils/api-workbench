import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBody, renderResponse, responseTitle } from './response';
import type { SendResult } from './report';

const result: SendResult = {
  request: { id: 'list', name: 'List users', method: 'GET', folder: 'Users' },
  url: 'https://api.example.com/users',
  status: 200,
  statusText: 'OK',
  httpVersion: '1.1',
  durationMs: 84.2,
  size: 33,
  headers: { 'content-type': 'application/json', 'set-cookie': '<hidden>' },
  body: '{"users":[{"id":1}]}',
  tests: [
    { label: 'status 200', pass: true, message: '' },
    { label: 'json $.users exists', pass: false, message: 'no value' },
  ],
  captures: [{ variable: 'user_id' }, { variable: 'token', error: 'no match' }],
  passed: false,
};

test('the response reads as the command line prints it', () => {
  assert.equal(
    renderResponse(result, 'GET'),
    [
      '200 OK · 84 ms · 33 B · HTTP/1.1',
      'GET https://api.example.com/users',
      '',
      'content-type: application/json',
      'set-cookie: <hidden>',
      '',
      '✓ status 200',
      '✗ json $.users exists — no value',
      'captured user_id',
      '✗ capture token: no match',
      '',
      '{',
      '  "users": [',
      '    {',
      '      "id": 1',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n'),
  );
});

test('a request with no response says why, without a body', () => {
  const text = renderResponse(
    {
      ...result,
      status: undefined,
      headers: undefined,
      body: undefined,
      error: 'fetch failed',
      tests: [],
      captures: [],
    },
    'POST',
  );
  assert.equal(text, 'No response · fetch failed\nPOST https://api.example.com/users\n');
});

test('only JSON is reformatted', () => {
  assert.equal(formatBody('<p>hi</p>', 'text/html'), '<p>hi</p>');
  assert.equal(formatBody('{not json', 'application/json'), '{not json');
  assert.equal(formatBody('[1,2]'), '[\n  1,\n  2\n]');
});

test('the tab is titled by the request and status, safely', () => {
  assert.equal(responseTitle(result), 'List users · 200');
  assert.equal(
    responseTitle({ ...result, request: { ...result.request, name: 'a/b:c' }, error: 'x' }),
    'a-b-c · no response',
  );
});
