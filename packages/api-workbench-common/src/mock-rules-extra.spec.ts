import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMockRule, mockRulePasses, mockRuleProblem, ruleRegExp } from './mocks';
import { validateJsonSchema, validateMockRequest } from './mock-validation';
import { mockCollectionRequests } from './mock-export';
import { newMock, newMockRoute } from './mocks';
import type { MockRule, MockRuleOperator, MockValidation } from './types';

const rule = (operator: MockRuleOperator, value = '', name = 'q'): MockRule => ({
  enabled: true,
  target: 'query',
  name,
  operator,
  value,
});
const passes = (operator: MockRuleOperator, value: string, actual: string | string[]) =>
  mockRulePasses(rule(operator, value), {
    query: new URLSearchParams(([] as string[]).concat(actual).map((item) => ['q', item])),
    headers: {},
    body: '',
  });

test('regular expressions accept /pattern/flags literals and a negated form', () => {
  assert.equal(ruleRegExp('/^ab+c$/i').test('ABBC'), true);
  assert.equal(ruleRegExp('^ab+c$').test('ABBC'), false);
  // Global flags are dropped so testing several values gives the same answer each time.
  assert.equal(ruleRegExp('/a/g').global, false);
  assert.equal(passes('matches', '/^order-\\d+$/i', 'ORDER-12'), true);
  assert.equal(passes('not-matches', '^\\d+$', 'abc'), true);
  assert.equal(passes('not-matches', '^\\d+$', '42'), false);
  assert.match(mockRuleProblem(rule('not-matches', '(')) ?? '', /Invalid regular expression/);
  assert.match(mockRuleProblem(rule('matches', '')) ?? '', /Enter a regular expression/);
  assert.equal(describeMockRule(rule('matches', '/x/i')), 'query parameter q matches /x/i');
});

test('the added text, number, length, date, and kind comparisons', () => {
  assert.equal(passes('equals-ignore-case', 'Admin', 'aDMIN'), true);
  assert.equal(passes('not-starts-with', 'tmp', 'file'), true);
  assert.equal(passes('not-ends-with', '.exe', 'run.exe'), false);
  assert.equal(passes('not-between', '1..10', '11'), true);
  assert.equal(passes('not-between', '1..10', '5'), false);
  assert.equal(passes('length-equals', '3', 'abc'), true);
  // A JSON array's length is its number of items.
  assert.equal(passes('length-equals', '2', '[1,2]'), true);
  assert.equal(passes('before', '2026-01-01', '2025-12-31'), true);
  assert.equal(passes('after', 'now', '2000-01-01'), false);
  assert.match(mockRuleProblem(rule('before', 'soon')) ?? '', /Enter a date/);
  assert.equal(passes('is-url', '', 'https://example.com/a?b=1'), true);
  assert.equal(passes('is-url', '', 'example.com'), false);
  assert.equal(passes('is-ip', '', '192.168.0.1'), true);
  assert.equal(passes('is-ip', '', '::1'), true);
  assert.equal(passes('is-ip', '', '999.1.1.1'), false);
  assert.equal(passes('is-json', '', '{"a":1}'), true);
  assert.equal(passes('is-array', '', '[1]'), true);
  assert.equal(passes('is-object', '', '[1]'), false);
  assert.equal(passes('is-alphanumeric', '', 'abc123'), true);
  assert.equal(passes('is-alphanumeric', '', 'abc-123'), false);
});

const validation = (patch: Partial<MockValidation>): MockValidation => ({
  enabled: true,
  checks: [],
  status: 422,
  ...patch,
});

test('validation checks the content type, body size, and unknown query parameters', () => {
  const request = (headers: Record<string, string>, body: string, query = '') => ({
    query: new URLSearchParams(query),
    headers,
    body,
  });
  const json = validation({ contentTypes: 'application/json' });
  assert.deepEqual(
    validateMockRequest(json, request({ 'content-type': 'application/json; charset=utf-8' }, '{}')),
    [],
  );
  assert.deepEqual(
    validateMockRequest(json, request({ 'content-type': 'application/problem+json' }, '{}')),
    [],
  );
  assert.match(
    validateMockRequest(json, request({ 'content-type': 'text/plain' }, 'x'))[0].message,
    /Content-Type must be application\/json, not text\/plain/,
  );
  // A request without a body is not held to a content type.
  assert.deepEqual(validateMockRequest(json, request({}, '')), []);
  const small = validation({ maxBodyBytes: 4 });
  assert.match(
    validateMockRequest(small, request({}, '12345'))[0].message,
    /at most 4 bytes, not 5/,
  );
  assert.match(
    validateMockRequest(small, request({ 'content-length': '5000000' }, '1'))[0].message,
    /not 5000000/,
  );
  const strict = validation({ strictQuery: true, checks: [rule('exists', '', 'limit')] });
  const problems = validateMockRequest(
    strict,
    request({}, '', 'limit=1&page=2&debug=1'),
    {},
    undefined,
    [rule('equals', '2', 'page')],
  );
  assert.deepEqual(
    problems.map((problem) => problem.name),
    ['debug'],
  );
});

test('form bodies are validated against the schema with typed fields', () => {
  const schema = JSON.stringify({
    type: 'object',
    required: ['name', 'age'],
    properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 18 } },
  });
  const form = (body: string) =>
    validateMockRequest(validation({ schema }), {
      query: new URLSearchParams(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }).map((problem) => problem.message);
  assert.deepEqual(form('name=Ada&age=36'), []);
  assert.deepEqual(form('name=Ada&age=12'), ['body age must be at least 18']);
});

test('JSON Schema supports $ref, not, if/then/else, patternProperties, contains, and tuples', () => {
  const messages = (value: unknown, schema: unknown) =>
    validateJsonSchema(value, schema).map((problem) => `${problem.path}: ${problem.message}`);
  const withRef = {
    $defs: { sku: { type: 'string', pattern: '^[A-Z]+-\\d+$' } },
    type: 'object',
    properties: { sku: { $ref: '#/$defs/sku' } },
  };
  assert.deepEqual(messages({ sku: 'bad' }, withRef), ['sku: must match /^[A-Z]+-\\d+$/']);
  assert.deepEqual(messages('x', { not: { type: 'string' } }), [
    ': must not match the excluded shape',
  ]);
  const conditional = {
    if: { properties: { kind: { const: 'card' } } },
    then: { required: ['number'] },
    else: { required: ['iban'] },
  };
  assert.deepEqual(messages({ kind: 'card' }, conditional), ['number: is required']);
  assert.deepEqual(messages({ kind: 'bank' }, conditional), ['iban: is required']);
  assert.deepEqual(
    messages(
      { x_a: 1, y: 2 },
      {
        patternProperties: { '^x_': { type: 'string' } },
        additionalProperties: false,
      },
    ),
    ['x_a: must be string, not integer', 'y: is not allowed'],
  );
  assert.deepEqual(messages([1, 2], { contains: { type: 'string' } }), [
    ': must contain a matching item',
  ]);
  assert.deepEqual(
    messages(['a', 1, true], {
      prefixItems: [{ type: 'string' }, { type: 'integer' }],
      items: false,
    }),
    ['[2]: is not allowed'],
  );
  assert.deepEqual(messages({ card: '1' }, { dependentRequired: { card: ['cvv'] } }), [
    'cvv: is required when card is present',
  ]);
  assert.deepEqual(messages('not-a-host!', { format: 'hostname' }), [': must be a valid hostname']);
});

test('a mock becomes a collection of requests with saved responses', () => {
  const mock = newMock(
    'Shop',
    [],
    [
      newMockRoute({
        method: 'POST',
        path: '/orders/:id',
        status: 201,
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        body: '{"ok":true}',
        name: 'Create order',
        pathParams: [{ name: 'id', example: '7' }],
        rules: [rule('equals', 'v2', 'version')],
        validation: validation({
          checks: [
            { enabled: true, target: 'header', name: 'X-Key', operator: 'exists', value: '' },
          ],
          schema: '{"type":"object","properties":{"sku":{"type":"string","example":"A-1"}}}',
        }),
      }),
      newMockRoute({ path: '/users/:userId' }),
      newMockRoute({ kind: 'websocket', path: '/ws' }),
    ],
  );
  const [order, user, socket] = mockCollectionRequests(mock, 'Shop');
  assert.equal(order.url, `http://localhost:${mock.port}/orders/7?version=v2`);
  assert.deepEqual(
    order.headers?.map((item) => [item.key, item.value]),
    [
      ['X-Key', ''],
      ['Content-Type', 'application/json'],
    ],
  );
  assert.deepEqual(JSON.parse(order.body!), { sku: 'A-1' });
  assert.equal(order.response && 'status' in order.response && order.response.status, 201);
  assert.equal(user.url, `http://localhost:${mock.port}/users/{{userId}}`);
  assert.equal(socket.protocol, 'websocket');
  assert.equal(socket.url, `ws://localhost:${mock.port}/ws`);
});

test('cookie rules, case-insensitive and list comparisons, numeric equality, and more kinds', () => {
  const request = {
    query: new URLSearchParams('id=0x1F&tag=a'),
    headers: {
      cookie: 'plan=Pro; session=abc; id=7',
      'x-mode': 'LIVE',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
    },
    body: '{"roles":["read","write"],"note":"Hello World","count":"10"}',
  };
  const passes = (
    target: MockRule['target'],
    name: string,
    operator: MockRuleOperator,
    value = '',
  ) => mockRulePasses({ enabled: true, target, name, operator, value }, request);
  const cases: [boolean, boolean][] = [
    [passes('cookie', 'plan', 'equals', 'Pro'), true],
    [passes('cookie', 'plan', 'exists'), true],
    [passes('cookie', 'other', 'missing'), true],
    [passes('cookie', 'id', 'eq', '7'), true],
    [passes('cookie', 'id', 'ne', '7'), false],
    [passes('body', 'count', 'eq', '10.0'), true],
    [passes('cookie', 'plan', 'not-equals-ignore-case', 'pro'), false],
    [passes('body', 'note', 'contains-ignore-case', 'world'), true],
    [passes('body', 'note', 'not-contains-ignore-case', 'WORLD'), false],
    [passes('body', 'roles', 'contains-all', 'read, write'), true],
    [passes('body', 'roles', 'contains-all', 'read, admin'), false],
    [passes('body', 'roles', 'contains-any', 'admin, write'), true],
    [passes('body', 'note', 'contains-any', 'Bye, Hello'), true],
    [passes('header', 'x-mode', 'is-uppercase'), true],
    [passes('header', 'x-mode', 'is-lowercase'), false],
    [passes('query', 'id', 'is-hex'), true],
    [passes('query', 'tag', 'is-base64'), false],
    [passes('header', 'authorization', 'is-jwt'), false],
  ];
  cases.forEach(([actual, expected], index) => assert.equal(actual, expected, `case ${index}`));
  assert.equal(
    mockRulePasses(
      { enabled: true, target: 'header', name: 'authorization', operator: 'is-jwt', value: '' },
      { ...request, headers: { authorization: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' } },
    ),
    true,
  );
  assert.equal(
    describeMockRule({
      enabled: true,
      target: 'cookie',
      name: 'plan',
      operator: 'contains-any',
      value: 'pro, team',
    }),
    'cookie plan contains any of pro, team',
  );
  assert.match(
    mockRuleProblem({ enabled: true, target: 'cookie', name: 'id', operator: 'eq', value: 'x' }) ??
      '',
    /number/,
  );
  assert.match(
    mockRuleProblem({
      enabled: true,
      target: 'body',
      name: 'roles',
      operator: 'contains-all',
      value: ' ',
    }) ?? '',
    /List the values/,
  );
});
