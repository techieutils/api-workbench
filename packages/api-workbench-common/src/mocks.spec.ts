import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpec, blankSpec } from './api-specs';
import {
  DEFAULT_MOCK_CORS,
  MOCK_SECURITY_HEADERS,
  mergeMockHeaders,
  missingSecurityHeaders,
  mockCorsHeaders,
  describeMockRule,
  explainMockMatch,
  freeMockGrpcPort,
  freeMockPort,
  mockStreamFrame,
  mockAnswer,
  newMockResponse,
  jsonPathValue,
  mockRulePasses,
  mockRuleProblem,
  matchMockRoute,
  mockPathOf,
  mockRoutesFromRequests,
  mockRoutesFromSpec,
  newMock,
  newMockRoute,
  normalizeMock,
  renderMockBody,
  MOCK_METHODS,
  freeMockMqttPort,
} from './mocks';
import { mockCollectionRequests } from './mock-export';
import { mockDocOperations } from './mock-docs';
import { defaultMQTT } from './protocol-config';
import type { ApiRequest } from './types';

test('routes match by method and path, preferring fixed segments', () => {
  const routes = [
    newMockRoute({ id: 'any', method: 'ANY', path: '/users/:id' }),
    newMockRoute({ id: 'get', method: 'GET', path: '/users/:id' }),
    newMockRoute({ id: 'me', method: 'GET', path: '/users/me' }),
    newMockRoute({ id: 'files', method: 'GET', path: '/files/*' }),
    newMockRoute({ id: 'off', method: 'GET', path: '/off', enabled: false }),
  ];
  assert.equal(matchMockRoute(routes, 'GET', '/users/me')?.route.id, 'me');
  assert.deepEqual(matchMockRoute(routes, 'get', '/users/42/')?.params, { id: '42' });
  assert.equal(matchMockRoute(routes, 'GET', '/users/42')?.route.id, 'get');
  assert.equal(matchMockRoute(routes, 'DELETE', '/users/42')?.route.id, 'any');
  assert.equal(matchMockRoute(routes, 'HEAD', '/users/me')?.route.id, 'me');
  assert.deepEqual(matchMockRoute(routes, 'GET', '/files/a/b%20c')?.params, { '*': 'a/b c' });
  assert.equal(matchMockRoute(routes, 'GET', '/off'), undefined);
  assert.equal(matchMockRoute(routes, 'GET', '/users'), undefined);
});

test('bodies take values from the request', () => {
  assert.equal(
    renderMockBody(
      '{"id":"{{params.id}}","q":"{{ query.q }}","h":"{{headers.X-Trace}}","n":"{{params.none}}"}',
      {
        params: { id: '7' },
        query: new URLSearchParams('q=find'),
        headers: { 'x-trace': 'abc' },
      },
    ),
    '{"id":"7","q":"find","h":"abc","n":""}',
  );
});

test('request URLs become route paths', () => {
  assert.equal(mockPathOf('{{base_url}}/users/{{id}}?x=1'), '/users/:id');
  assert.equal(mockPathOf('https://api.example.com/v1/items/{id}#top'), '/v1/items/:id');
  assert.equal(mockPathOf('example.com/users'), '/users');
  assert.equal(mockPathOf('localhost:3000'), '/');
});

test('a specification becomes routes with its examples', () => {
  const routes = mockRoutesFromSpec(analyzeSpec(blankSpec('Shop')).document!);
  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path} ${route.status}`),
    ['GET /items 200', 'GET /items/:id 200'],
  );
  assert.deepEqual(JSON.parse(routes[1].body), { id: 1, name: 'First item' });
  assert.equal(routes[1].headers[0].value, 'application/json');
  const swagger = mockRoutesFromSpec({
    swagger: '2.0',
    info: { title: 'Old', version: '1' },
    basePath: '/api/',
    paths: {
      '/pets': {
        post: {
          responses: {
            '201': {
              description: 'Made',
              schema: { type: 'object', properties: { id: { type: 'integer' } } },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(
    swagger.map(
      (route) => `${route.method} ${route.path} ${route.status} ${route.body.replace(/\s/g, '')}`,
    ),
    ['POST /api/pets 201 {"id":0}'],
  );
});

test('a collection becomes routes with its saved responses', () => {
  const base = {
    folder: 'People',
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
  };
  const routes = mockRoutesFromRequests([
    {
      ...base,
      id: '1',
      name: 'Get user',
      method: 'GET',
      url: '{{base_url}}/users/{{id}}',
      response: {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'text/plain' },
        body: 'missing',
        time: 1,
        size: 7,
        url: '',
      },
    },
    {
      ...base,
      id: '2',
      name: 'Again',
      method: 'GET',
      url: '{{base_url}}/users/{{id}}',
      response: null,
    },
    {
      ...base,
      id: '3',
      name: 'Socket',
      method: 'GET',
      url: 'ws://x/y',
      protocol: 'websocket',
      body: '{"hello": true}',
      response: null,
    },
    { ...base, id: '4', name: 'Create', method: 'POST', url: '{{base_url}}/users', response: null },
    {
      ...base,
      id: '5',
      name: 'Watch',
      method: 'POST',
      url: 'localhost:50051',
      protocol: 'grpc',
      grpc: { proto: '', method: 'shop.Orders/Watch', tls: false },
      response: null,
    },
    {
      ...base,
      id: '6',
      name: 'Events',
      method: 'GET',
      url: '{{base_url}}/events',
      protocol: 'sse',
    },
  ] as ApiRequest[]);
  assert.deepEqual(
    routes.map((route) =>
      route.kind
        ? `${route.name}|${route.kind} ${route.path} ${route.stream!.messages.length}`
        : `${route.name}|${route.method} ${route.path} ${route.status} ${route.body}`,
    ),
    [
      'Get user|GET /users/:id 404 missing',
      'Socket|websocket /y 1',
      'Create|POST /users 200 {}',
      'Watch|grpc /shop.Orders/Watch 1',
      'Events|sse /events 2',
    ],
    'live requests become streaming routes with sample messages',
  );
  assert.equal(routes[0].headers[0].value, 'text/plain');
  assert.equal(
    routes[1].stream!.messages[0].data,
    '{"hello": true}',
    'a saved WebSocket message is the first',
  );
});

test('new mocks take free ports and files are normalized', () => {
  const first = newMock('One', []);
  assert.equal(first.port, 4010);
  assert.equal(freeMockPort([first, { ...first, port: 4011 }]), 4012);
  const mock = normalizeMock(
    {
      name: '  ',
      port: 'x',
      routes: [{ method: 'post', delayMs: -5 }, null],
      source: { kind: 'bad' },
    },
    'From file',
  )!;
  assert.equal(mock.name, 'From file');
  assert.equal(mock.port, 4010);
  assert.equal(mock.cors, true);
  assert.equal(mock.routes.length, 1);
  assert.equal(mock.routes[0].method, 'POST');
  assert.equal(mock.routes[0].delayMs, 0);
  assert.equal(mock.source, undefined);
  assert.equal(normalizeMock('text', 'x'), undefined);
});

test('rules choose between routes on the same path', () => {
  const details = (query = '', headers: Record<string, string> = {}, body = '') => ({
    query: new URLSearchParams(query),
    headers,
    body,
  });
  const rule = (overrides: Partial<import('./types').MockRule>): import('./types').MockRule => ({
    enabled: true,
    target: 'query',
    name: '',
    operator: 'equals',
    value: '',
    ...overrides,
  });
  const routes = [
    newMockRoute({ id: 'default', method: 'POST', path: '/orders/:id' }),
    newMockRoute({
      id: 'premium',
      method: 'POST',
      path: '/orders/:id',
      rules: [
        rule({ target: 'header', name: 'X-Plan', value: 'premium' }),
        rule({ target: 'body', name: 'items[0].sku', operator: 'matches', value: '^A-\\d+$' }),
      ],
    }),
    newMockRoute({
      id: 'either',
      method: 'POST',
      path: '/orders/:id',
      ruleMode: 'any',
      rules: [
        rule({ target: 'query', name: 'debug', operator: 'exists' }),
        rule({ target: 'param', name: 'id', value: '0' }),
        rule({ target: 'query', name: 'off', operator: 'exists', enabled: false }),
      ],
    }),
  ];
  const match = (
    query: string,
    headers: Record<string, string>,
    body: string,
    path = '/orders/7',
  ) => matchMockRoute(routes, 'POST', path, details(query, headers, body))?.route.id;
  const order = JSON.stringify({ items: [{ sku: 'A-12' }] });
  assert.equal(match('', { 'x-plan': 'premium' }, order), 'premium');
  assert.equal(match('', { 'x-plan': 'premium' }, '{"items":[{"sku":"B-1"}]}'), 'default');
  assert.equal(match('', { 'x-plan': 'basic' }, order), 'default');
  assert.equal(match('debug=1', {}, ''), 'either');
  assert.equal(match('', {}, '', '/orders/0'), 'either');
  assert.equal(match('off=1', {}, ''), 'default');
  assert.equal(matchMockRoute(routes, 'POST', '/orders/7')?.route.id, 'default');
  const unnamed = newMockRoute({
    id: 'unnamed',
    method: 'POST',
    path: '/orders/:id',
    rules: [rule({ name: ' ', operator: 'exists' })],
  });
  assert.equal(
    matchMockRoute([unnamed], 'POST', '/orders/7')?.route.id,
    'unnamed',
    'a rule still being written does not stop the route answering',
  );
});

test('rule operators and problems', () => {
  const request = {
    query: new URLSearchParams('tag=a&tag=b'),
    headers: { accept: 'application/json' },
    body: '{"user":{"id":5,"name":"Ada"},"odd key":true}',
  };
  const passes = (overrides: Partial<import('./types').MockRule>) =>
    mockRulePasses(
      { enabled: true, target: 'query', name: 'tag', operator: 'equals', value: '', ...overrides },
      request,
    );
  assert.equal(passes({ value: 'b' }), true);
  assert.equal(passes({ operator: 'not-equals', value: 'c' }), true);
  assert.equal(passes({ operator: 'not-equals', value: 'a' }), false);
  assert.equal(
    passes({ target: 'header', name: 'Accept', operator: 'contains', value: 'json' }),
    true,
  );
  assert.equal(passes({ target: 'body', name: 'user.id', value: '5' }), true);
  assert.equal(
    passes({ target: 'body', name: 'user', operator: 'contains', value: '"Ada"' }),
    true,
  );
  assert.equal(passes({ target: 'body', name: '["odd key"]', value: 'true' }), true);
  assert.equal(passes({ target: 'body', name: '', operator: 'contains', value: 'Ada' }), true);
  assert.equal(passes({ target: 'body', name: 'user.email', operator: 'missing' }), true);
  assert.equal(passes({ operator: 'matches', value: '(' }), false);
  assert.equal(jsonPathValue({ a: [{ b: 1 }] }, 'a[0].b'), 1);
  assert.match(
    mockRuleProblem({
      enabled: true,
      target: 'query',
      name: 'q',
      operator: 'matches',
      value: '(',
    })!,
    /Invalid regular expression/,
  );
  assert.equal(
    mockRuleProblem({ enabled: true, target: 'query', name: ' ', operator: 'exists', value: '' }),
    'Name what to check; the rule is ignored until then.',
  );
  const mock = normalizeMock(
    {
      routes: [
        { rules: [{ target: 'nope', operator: 'nope', name: 'x', value: 3 }], ruleMode: 'any' },
      ],
    },
    'Rules',
  )!;
  assert.deepEqual(mock.routes[0].rules, [
    { enabled: true, target: 'query', name: 'x', operator: 'equals', value: '3' },
  ]);
  assert.equal(mock.routes[0].ruleMode, 'any');
});

test('a route answers with the first response whose rules pass, otherwise its own', () => {
  const route = newMockRoute({ path: '/stock/:sku', status: 200, body: 'in stock' });
  route.responses = [
    newMockResponse(route, { id: 'empty', status: 410, body: 'never chosen' }),
    newMockResponse(route, {
      id: 'out',
      status: 409,
      body: 'out of stock',
      rules: [{ enabled: true, target: 'param', name: 'sku', operator: 'matches', value: '^X' }],
    }),
    newMockResponse(route, {
      id: 'slow',
      status: 503,
      delayMs: 50,
      rules: [{ enabled: true, target: 'query', name: 'slow', operator: 'exists', value: '' }],
    }),
  ];
  const answer = (sku: string, query = '') =>
    mockAnswer(route, { query: new URLSearchParams(query), headers: {}, body: '' }, { sku });
  assert.deepEqual(
    [answer('A1').status, answer('A1').responseId, answer('A1').body],
    [200, undefined, 'in stock'],
  );
  assert.deepEqual([answer('X9').status, answer('X9').responseId], [409, 'out']);
  assert.deepEqual([answer('A1', 'slow').status, answer('A1', 'slow').delayMs], [503, 50]);
  assert.equal(route.responses[0].headers[0].value, 'application/json');
  const mock = normalizeMock(
    {
      routes: [
        { path: '/x', responses: [{ status: 'x', rules: [{ name: 'q' }], ruleMode: 'any' }, null] },
      ],
    },
    'Responses',
  )!;
  assert.equal(mock.routes[0].responses!.length, 1);
  assert.equal(mock.routes[0].responses![0].status, 200);
  assert.equal(mock.routes[0].responses![0].ruleMode, 'any');
  assert.equal(mock.routes[0].responses![0].rules[0].operator, 'equals');
});

test('matches and misses are explained in words', () => {
  const details = (query = '', headers: Record<string, string> = {}) => ({
    query: new URLSearchParams(query),
    headers,
    body: '',
  });
  const route = newMockRoute({
    id: 'orders',
    method: 'GET',
    path: '/orders/:id',
    name: 'Get order',
    rules: [{ enabled: true, target: 'header', name: 'X-Plan', operator: 'equals', value: 'pro' }],
  });
  route.responses = [
    newMockResponse(route, {
      name: 'Missing',
      rules: [{ enabled: true, target: 'param', name: 'id', operator: 'equals', value: '0' }],
    }),
    newMockResponse(route, { name: 'Unused' }),
  ];
  const routes = [
    route,
    newMockRoute({ method: 'POST', path: '/orders/:id' }),
    newMockRoute({ path: '/off/:id', enabled: false }),
  ];
  assert.deepEqual(explainMockMatch(routes, 'GET', '/orders/7', details('', { 'x-plan': 'pro' })), [
    'Route GET /orders/:id (Get order) answered.',
    'Its rules passed: header X-Plan equals "pro".',
    'Response "Missing" did not answer: path parameter id equals "0" did not pass.',
    'Response "Unused" has no rules, so it is never used.',
    'So the default response answered.',
  ]);
  assert.equal(
    explainMockMatch(routes, 'GET', '/orders/0', details('', { 'x-plan': 'pro' }))[2],
    'Response "Missing" answered: its rules passed.',
  );
  assert.deepEqual(explainMockMatch(routes, 'GET', '/orders/7', details()), [
    'Route GET /orders/:id (Get order) matches, but its rules did not pass: header X-Plan equals "pro".',
    'Route POST /orders/:id has this path, but answers POST, not GET.',
  ]);
  assert.deepEqual(explainMockMatch(routes, 'GET', '/off/1', details()), [
    'Route GET /off/:id matches, but it is switched off.',
  ]);
  assert.deepEqual(explainMockMatch(routes, 'GET', '/nothing', details()), [
    'No route has the path /nothing.',
  ]);
  assert.equal(
    describeMockRule({ enabled: true, target: 'body', name: '', operator: 'matches', value: '^a' }),
    'body matches /^a/',
  );
});

test('CORS headers follow the mock server’s settings', () => {
  const permissive = mockCorsHeaders(undefined, { origin: 'http://app.test', preflight: true });
  assert.equal(permissive['Access-Control-Allow-Origin'], '*');
  assert.equal(permissive['Access-Control-Allow-Headers'], '*');
  assert.equal(permissive['Access-Control-Allow-Credentials'], undefined);
  const listed = {
    ...DEFAULT_MOCK_CORS,
    origins: 'http://app.test, https://admin.test/',
    maxAge: 600,
  };
  assert.deepEqual(mockCorsHeaders(listed, { origin: 'http://evil.test', preflight: true }), {});
  assert.deepEqual(mockCorsHeaders(listed, { preflight: false }), {});
  const allowed = mockCorsHeaders(listed, { origin: 'https://admin.test', preflight: true });
  assert.equal(allowed['Access-Control-Allow-Origin'], 'https://admin.test');
  assert.equal(allowed.Vary, 'Origin');
  assert.equal(allowed['Access-Control-Max-Age'], '600');
  const credentials = mockCorsHeaders(
    { ...DEFAULT_MOCK_CORS, credentials: true, headers: '*', exposeHeaders: '*' },
    { origin: 'http://app.test', requestHeaders: 'authorization, x-trace', preflight: true },
  );
  assert.equal(credentials['Access-Control-Allow-Origin'], 'http://app.test');
  assert.equal(credentials['Access-Control-Allow-Credentials'], 'true');
  assert.equal(credentials['Access-Control-Allow-Headers'], 'authorization, x-trace');
  assert.equal(credentials['Access-Control-Expose-Headers'], undefined);
  const plain = mockCorsHeaders(
    { ...DEFAULT_MOCK_CORS, methods: 'GET,\nPOST', headers: 'Content-Type', exposeHeaders: 'ETag' },
    { origin: 'http://app.test', preflight: false },
  );
  assert.equal(plain['Access-Control-Allow-Methods'], undefined, 'only preflights get methods');
  assert.equal(plain['Access-Control-Expose-Headers'], 'ETag');
  assert.equal(
    mockCorsHeaders({ ...DEFAULT_MOCK_CORS, methods: 'GET,\nPOST' }, { preflight: true })[
      'Access-Control-Allow-Methods'
    ],
    'GET, POST',
  );
  const read = normalizeMock(
    { corsOptions: { origins: 'http://a.test', maxAge: -5, credentials: 'yes' } },
    'x',
  )!;
  assert.deepEqual(read.corsOptions, { ...DEFAULT_MOCK_CORS, origins: 'http://a.test' });
  assert.equal(normalizeMock({}, 'x')!.corsOptions, undefined);
});

test('default headers: a security preset, merged under a route’s own', () => {
  const mock = newMock('Secure', []);
  assert.deepEqual(
    mock.defaultHeaders!.map((row) => row.key),
    MOCK_SECURITY_HEADERS.map((row) => row.key),
    'new mocks start with the security headers',
  );
  assert.ok(
    !mock.defaultHeaders!.some((row) => /strict-transport|cross-origin-resource/i.test(row.key)),
  );
  assert.deepEqual(
    missingSecurityHeaders([{ key: 'x-frame-options', value: 'SAMEORIGIN', enabled: true }]).map(
      (row) => row.key,
    ),
    MOCK_SECURITY_HEADERS.map((row) => row.key).filter((key) => key !== 'X-Frame-Options'),
  );
  const merged = mergeMockHeaders(
    [
      { key: 'Cache-Control', value: 'no-store', enabled: true },
      { key: 'X-Off', value: 'no', enabled: false },
      { key: 'X-Frame-Options', value: 'DENY', enabled: true },
    ],
    [{ key: 'cache-control', value: 'max-age=60', enabled: true }],
  );
  assert.deepEqual(
    merged.map((row) => `${row.key}: ${row.value}`),
    ['cache-control: max-age=60', 'X-Frame-Options: DENY'],
  );
  assert.equal(
    normalizeMock({ name: 'Old' }, 'x')!.defaultHeaders,
    undefined,
    'older mocks keep none',
  );
});

test('stream frames, route kinds, and matching by transport', () => {
  assert.equal(
    mockStreamFrame('sse', 'a\nb', { event: 'tick', id: 3 }),
    'event: tick\nid: 3\ndata: a\ndata: b\n\n',
  );
  assert.equal(mockStreamFrame('ndjson', '{\n "a": 1\n}'), '{"a":1}\n');
  assert.equal(mockStreamFrame('ndjson', 'not\njson'), 'not json\n');
  const routes = [
    newMockRoute({ id: 'ws', kind: 'websocket', path: '/live' }),
    newMockRoute({ id: 'sse', kind: 'sse', path: '/live' }),
    newMockRoute({ id: 'rpc', kind: 'grpc', path: '/shop.Orders/Get' }),
  ];
  assert.equal(matchMockRoute(routes, 'GET', '/live')?.route.id, 'sse');
  assert.equal(matchMockRoute(routes, 'GET', '/live', undefined, 'websocket')?.route.id, 'ws');
  assert.equal(
    matchMockRoute(routes, 'POST', '/shop.Orders/Get', undefined, 'grpc')?.route.id,
    'rpc',
  );
  assert.equal(matchMockRoute(routes, 'POST', '/shop.Orders/Get'), undefined);
  const mock = normalizeMock(
    {
      grpc: { proto: 'syntax = "proto3";', port: 'x' },
      routes: [
        {
          kind: 'sse',
          stream: { messages: [{ data: 'x' }, { nope: 1 }], intervalMs: -1, repeat: true },
        },
        { kind: 'carrier-pigeon' },
      ],
    },
    'Streams',
  )!;
  assert.deepEqual(mock.grpc, { proto: 'syntax = "proto3";', port: 50051 });
  assert.equal(mock.routes[0].kind, 'sse');
  assert.deepEqual(
    {
      ...mock.routes[0].stream,
      messages: mock.routes[0].stream!.messages.map((message) => message.data),
    },
    { messages: ['x'], intervalMs: 0, repeat: true },
  );
  assert.equal(mock.routes[1].kind, undefined, 'an unknown kind is plain HTTP');
  assert.equal(freeMockGrpcPort([{ ...mock, port: 50051 }]), 50052);
});

test('rules compare as text, lists, numbers, lengths, kinds, and presence', () => {
  const request = {
    query: new URLSearchParams(
      'limit=25&tag=a&tag=b&name=Ada&blank=&id=3f2c1a90-1b2c-4d5e-8f90-123456789abc&mail=ada@example.com&day=2026-11-01&on=true',
    ),
    headers: { 'x-version': '2.5' },
    body: '{"items":[],"total":7}',
  };
  const passes = (operator: string, name: string, value = '', target = 'query') =>
    mockRulePasses(
      { enabled: true, target: target as 'query', name, operator: operator as 'equals', value },
      request,
    );
  assert.equal(passes('not-contains', 'name', 'z'), true);
  assert.equal(passes('starts-with', 'name', 'Ad'), true);
  assert.equal(passes('ends-with', 'name', 'x'), false);
  assert.equal(passes('one-of', 'tag', 'b, c'), true);
  assert.equal(passes('not-one-of', 'tag', 'b'), false, 'every value must avoid the list');
  assert.equal(passes('gt', 'limit', '10'), true);
  assert.equal(passes('lte', 'limit', '20'), false);
  assert.equal(passes('gte', 'x-version', '2.5', 'header'), true);
  assert.equal(passes('lt', 'name', '5'), false, 'text is not a number');
  assert.equal(passes('between', 'limit', '1..50'), true);
  assert.equal(
    passes('between', 'total', '10,1', 'body'),
    true,
    'the ends may be given either way',
  );
  assert.equal(passes('min-length', 'name', '3'), true);
  assert.equal(passes('max-length', 'name', '2'), false);
  assert.equal(passes('is-integer', 'limit'), true);
  assert.equal(passes('is-integer', 'x-version', '', 'header'), false);
  assert.equal(passes('is-number', 'x-version', '', 'header'), true);
  assert.equal(passes('is-boolean', 'on'), true);
  assert.equal(passes('is-uuid', 'id'), true);
  assert.equal(passes('is-email', 'mail'), true);
  assert.equal(passes('is-date', 'day'), true);
  assert.equal(passes('empty', 'blank'), true);
  assert.equal(passes('empty', 'items', '', 'body'), true, 'an empty JSON array is empty');
  assert.equal(passes('not-empty', 'name'), true);
  assert.equal(passes('is-integer', 'absent'), false, 'a missing value is no kind of value');
  const rule = (operator: string, value = '') => ({
    enabled: true,
    target: 'query' as const,
    name: 'limit',
    operator: operator as 'equals',
    value,
  });
  assert.equal(describeMockRule(rule('lte', '100')), 'query parameter limit is at most 100');
  assert.equal(
    describeMockRule(rule('lte', '100'), 'must'),
    'query parameter limit must be at most 100',
  );
  assert.equal(
    describeMockRule(rule('between', '10..1'), 'must'),
    'query parameter limit must be between 1 and 10',
  );
  assert.equal(
    describeMockRule(rule('is-integer'), 'must'),
    'query parameter limit must be an integer',
  );
  assert.equal(mockRuleProblem(rule('gt', 'ten')), 'Enter a number to compare with.');
  assert.equal(
    mockRuleProblem(rule('between', '5')),
    'Enter the range as min..max, such as 1..10.',
  );
  assert.equal(mockRuleProblem(rule('min-length', '2.5')), 'Enter a length as a whole number.');
  assert.equal(mockRuleProblem(rule('one-of', ' , ')), 'List the values, separated by commas.');
  assert.equal(mockRuleProblem(rule('is-uuid')), undefined);
});

test('Socket.IO and MQTT requests become routes, and their routes become requests again', () => {
  const base = {
    folder: 'Live',
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
    response: null,
  };
  const routes = mockRoutesFromRequests([
    {
      ...base,
      id: 'io',
      name: 'Orders feed',
      method: 'GET',
      url: '{{base_url}}/orders',
      protocol: 'socketio',
      socketio: { path: '/socket.io', event: 'order', ack: false },
    },
    {
      ...base,
      id: 'mq',
      name: 'Device status',
      method: 'GET',
      url: 'mqtt://broker.example:1883',
      protocol: 'mqtt',
      mqtt: {
        ...defaultMQTT(),
        subscriptions: [{ topic: 'devices/+/status', qos: 0, enabled: true }],
      },
    },
  ] as ApiRequest[]);
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path} ${route.stream!.messages[0].event ?? ''}`),
    ['socketio /orders order', 'mqtt devices/+/status '],
  );
  const mock = normalizeMock(
    { ...newMock('Live', [], routes), port: 4100, mqtt: { port: 1884 } },
    'x',
  )!;
  assert.deepEqual(mock.mqtt, { port: 1884 });
  assert.equal(freeMockMqttPort([mock]), 1883);
  assert.equal(freeMockMqttPort([mock], 1883), 1885);
  const [io, mq] = mockCollectionRequests(
    {
      ...mock,
      routes: [
        mock.routes[0],
        {
          ...mock.routes[1],
          path: 'devices/:id/status',
          pathParams: [{ name: 'id', example: '42' }],
        },
      ],
    },
    'Live',
  );
  assert.equal(io.protocol, 'socketio');
  assert.equal(io.url, 'http://localhost:4100/orders');
  assert.equal(io.socketio?.event, 'order');
  assert.equal(mq.protocol, 'mqtt');
  assert.equal(mq.url, 'mqtt://localhost:1884');
  assert.deepEqual(mq.mqtt?.subscriptions, [{ topic: 'devices/42/status', qos: 0, enabled: true }]);
  assert.equal(mq.mqtt?.version, 4, 'the mock’s broker speaks MQTT 3.1.1');
  // OpenAPI has no words for them, so the mock's docs leave them out.
  assert.equal(mockDocOperations(mock).length, 0);
});

test('TRACE and CONNECT are mock methods, and a CONNECT route matches its host:port', () => {
  assert.ok(MOCK_METHODS.includes('TRACE') && MOCK_METHODS.includes('CONNECT'));
  const route = newMockRoute({ method: 'CONNECT', path: '/api.example.com:443' });
  assert.ok(matchMockRoute([route], 'CONNECT', '/api.example.com:443'));
  assert.equal(matchMockRoute([route], 'CONNECT', '/other.example.com:443'), undefined);
  assert.equal(matchMockRoute([route], 'GET', '/api.example.com:443'), undefined);
});
