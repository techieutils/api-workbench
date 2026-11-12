import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import {
  analyzeSpec,
  blankSpec,
  requestsFromSpec,
  specFormat,
  specFromRequests,
} from './api-specs';
import type { ApiRequest } from './types';

test('a blank specification is valid and lists its operations', () => {
  const analysis = analyzeSpec(blankSpec('Shop'));
  assert.equal(analysis.version, 'OpenAPI 3.0.3');
  assert.equal(analysis.title, 'Shop');
  assert.deepEqual(analysis.problems, []);
  assert.deepEqual(
    analysis.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.tag}`),
    ['GET /items Items', 'GET /items/{id} Items'],
  );
  assert.equal(specFormat(blankSpec('Shop', 'json')), 'json');
  assert.deepEqual(analyzeSpec(blankSpec('Shop', 'json')).problems, []);
});

test('syntax errors are reported with their line', () => {
  const analysis = analyzeSpec('openapi: 3.0.3\ninfo:\n  title: [unclosed\npaths: {}\n');
  assert.equal(analysis.problems[0].severity, 'error');
  assert.ok(analysis.problems[0].line! >= 3);
  assert.equal(analysis.document, undefined);
});

test('structural problems and broken references are found', () => {
  const analysis = analyzeSpec(
    [
      'openapi: 3.0.3',
      'info:',
      '  version: 1.0.0',
      'paths:',
      '  items:',
      '    get: {}',
      '  /users:',
      '    get:',
      '      operationId: list',
      '      responses:',
      "        '200':",
      "          $ref: '#/components/responses/Missing'",
      '    post:',
      '      operationId: list',
      '',
    ].join('\n'),
  );
  const messages = analysis.problems.map(
    (problem) => `${problem.severity}:${problem.line}:${problem.message}`,
  );
  assert.ok(messages.some((message) => message.startsWith('error:2:info.title is required')));
  assert.ok(messages.some((message) => message.startsWith('error:5:Path "items" must start')));
  assert.ok(
    messages.some((message) =>
      /^error:12:Reference #\/components\/responses\/Missing/.test(message),
    ),
  );
  assert.ok(messages.some((message) => /^warning:\d+:POST \/users has no responses/.test(message)));
  assert.ok(messages.some((message) => /reuses operationId "list"/.test(message)));
});

test('unsupported documents are explained', () => {
  assert.match(analyzeSpec('name: not a spec\n').problems[0].message, /openapi: 3\.x/);
  assert.match(analyzeSpec('').problems[0].message, /empty/);
});

const request = (overrides: Partial<ApiRequest>): ApiRequest =>
  ({
    id: 'r1',
    name: 'List users',
    method: 'GET',
    folder: 'People',
    url: '{{base_url}}/users',
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
    response: null,
    ...overrides,
  }) as ApiRequest;

test('a collection becomes a specification, and a specification becomes requests', () => {
  const text = specFromRequests('People', [
    request({}),
    request({ id: 'r2', name: 'Get user', url: '{{base_url}}/users/{{id}}' }),
  ]);
  const document = parse(text);
  assert.equal(document.openapi, '3.0.3');
  assert.deepEqual(Object.keys(document.paths), ['/users', '/users/{id}']);
  assert.deepEqual(analyzeSpec(text).problems, []);
  const requests = requestsFromSpec(analyzeSpec(blankSpec('Shop')).document!, 'Shop API');
  assert.deepEqual(
    requests.map((item) => `${item.folder} ${item.method} ${item.url}`),
    [
      'Shop API/Items GET http://localhost:4010/items',
      'Shop API/Items GET http://localhost:4010/items/{{id}}',
    ],
  );
});

test('an alias with no anchor, or too many aliases, is a problem with the text, not a crash', () => {
  // Found by fuzzing: the spec editor analyzes as you type, and `*a` threw a ReferenceError.
  const bomb = [
    'a: &a [x, x, x, x, x, x, x, x, x]',
    ...'bcdefghij'
      .split('')
      .map((k, i) => `${k}: &${k} [${Array(9).fill(`*${'abcdefghij'[i]}`).join(', ')}]`),
  ].join('\n');
  for (const content of ['<<: *a', 'openapi: 3.0.0\ninfo: *missing', bomb]) {
    const analysis = analyzeSpec(content);
    assert.equal(analysis.endpoints.length, 0);
    assert.equal(analysis.problems[0]?.severity, 'error', content.slice(0, 30));
  }
});
