import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeValidation,
  mockSchemaProblem,
  pathParamProblem,
  pathParamSetupProblem,
  validateJsonSchema,
  validateMockRequest,
  validationFailureBody,
} from './mock-validation';
import {
  addPathParam,
  mockExamplePath,
  mockPathParamNames,
  mockPathParams,
  mockRoutesFromSpec,
  removePathParam,
  renamePathParam,
  validPathParamName,
} from './mocks';
import type { MockValidation } from './types';

const ORDER = {
  type: 'object',
  required: ['sku', 'quantity'],
  additionalProperties: false,
  properties: {
    sku: { type: 'string', pattern: '^[A-Z]+-\\d+$' },
    quantity: { type: 'integer', minimum: 1, maximum: 10 },
    email: { type: 'string', format: 'email' },
    size: { enum: ['S', 'M', 'L'] },
    tags: { type: 'array', maxItems: 2, items: { type: 'string', minLength: 2 } },
    note: { type: 'string', nullable: true },
  },
};

test('JSON Schema checks report each problem with its path', () => {
  assert.deepEqual(validateJsonSchema({ sku: 'TSHIRT-1', quantity: 2, note: null }, ORDER), []);
  assert.deepEqual(
    validateJsonSchema(
      { sku: 'shirt', quantity: 11, email: 'nope', size: 'XL', tags: ['a', 'bb', 'cc'], extra: 1 },
      ORDER,
    ),
    [
      { path: 'sku', message: 'must match /^[A-Z]+-\\d+$/' },
      { path: 'quantity', message: 'must be at most 10' },
      { path: 'email', message: 'must be a valid email' },
      { path: 'size', message: 'must be one of "S", "M", "L"' },
      { path: 'tags', message: 'must have at most 2 items' },
      { path: 'tags[0]', message: 'must be at least 2 characters' },
      { path: 'extra', message: 'is not allowed' },
    ],
  );
  assert.deepEqual(validateJsonSchema({ quantity: 1.5 }, ORDER), [
    { path: 'sku', message: 'is required' },
    { path: 'quantity', message: 'must be integer, not number' },
  ]);
  assert.deepEqual(validateJsonSchema(3, { oneOf: [{ type: 'integer' }, { type: 'number' }] }), [
    { path: '', message: 'must match exactly one of the allowed shapes' },
  ]);
  assert.equal(mockSchemaProblem('[1]'), 'The schema must be a JSON object.');
  assert.match(mockSchemaProblem('{') ?? '', /not valid JSON/);
  assert.equal(mockSchemaProblem(''), undefined);
});

test('requests are validated by checks and the body schema', () => {
  const validation: MockValidation = {
    enabled: true,
    status: 400,
    checks: [
      { enabled: true, target: 'header', name: 'X-Api-Key', operator: 'exists', value: '' },
      { enabled: true, target: 'query', name: 'version', operator: 'equals', value: '2' },
      { enabled: false, target: 'query', name: 'off', operator: 'exists', value: '' },
    ],
    schema: JSON.stringify(ORDER),
  };
  const request = (query: string, headers: Record<string, string>, body: string) => ({
    query: new URLSearchParams(query),
    headers,
    body,
  });
  assert.deepEqual(
    validateMockRequest(
      validation,
      request('version=2', { 'x-api-key': 'k' }, '{"sku":"A-1","quantity":1}'),
    ),
    [],
  );
  assert.deepEqual(
    validateMockRequest(validation, request('version=1', {}, '{"sku":"A-1"}')).map((problem) => [
      problem.in,
      problem.name,
      problem.message,
    ]),
    [
      ['header', 'X-Api-Key', 'header X-Api-Key must be present'],
      ['query', 'version', 'query parameter version must equal "2"'],
      ['body', 'quantity', 'body quantity is required'],
    ],
  );
  assert.deepEqual(
    validateMockRequest(validation, request('version=2', { 'x-api-key': 'k' }, '{oops')),
    [{ in: 'body', name: '', message: 'body must be valid JSON' }],
  );
  assert.deepEqual(validateMockRequest({ ...validation, enabled: false }, request('', {}, '')), []);
  const problems = validateMockRequest(validation, request('version=2', { 'x-api-key': 'k' }, ''));
  assert.deepEqual(JSON.parse(validationFailureBody(validation, problems)), {
    error: 'Request validation failed',
    problems: [{ in: 'body', name: '', message: 'body is required' }],
  });
  assert.equal(
    validationFailureBody({ ...validation, body: '{"errors": {{problems}}}' }, problems),
    '{"errors": [{"in":"body","name":"","message":"body is required"}]}',
  );
  assert.equal(describeValidation(validation), '2 checks and a body schema; failures get 400');
  assert.equal(describeValidation(undefined), 'Off: every matched request is answered');
});

test('routes from a specification validate required parameters and the JSON body', () => {
  const routes = mockRoutesFromSpec({
    openapi: '3.0.3',
    paths: {
      '/orders': {
        post: {
          parameters: [
            { name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } },
          },
          responses: { '201': { description: 'Created' } },
        },
        get: {
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: {
      schemas: {
        NewOrder: {
          type: 'object',
          required: ['sku'],
          properties: { sku: { type: 'string' }, line: { $ref: '#/components/schemas/Line' } },
        },
        Line: { type: 'object', properties: { quantity: { type: 'integer', example: 2 } } },
      },
    },
  });
  const create = routes.find((route) => route.method === 'POST')!;
  const list = routes.find((route) => route.method === 'GET')!;
  assert.deepEqual(
    create.validation?.checks.map((check) => `${check.target} ${check.name} ${check.operator}`),
    ['header X-Tenant exists'],
  );
  assert.deepEqual(JSON.parse(create.validation!.schema!), {
    type: 'object',
    required: ['sku'],
    properties: {
      sku: { type: 'string' },
      line: { type: 'object', properties: { quantity: { type: 'integer' } } },
    },
  });
  assert.equal(list.validation, undefined, 'an operation that requires nothing is not validated');
});

test('path parameters are checked against their types', () => {
  assert.equal(pathParamProblem({ name: 'id', type: 'integer' }, '42'), undefined);
  assert.equal(
    pathParamProblem({ name: 'id', type: 'integer' }, 'abc'),
    'path parameter id must be an integer',
  );
  assert.equal(pathParamProblem({ name: 'n', type: 'number' }, '1.5'), undefined);
  assert.equal(
    pathParamProblem({ name: 'f', type: 'boolean' }, 'yes'),
    'path parameter f must be true or false',
  );
  assert.equal(
    pathParamProblem({ name: 'id', type: 'uuid' }, '123'),
    'path parameter id must be a UUID',
  );
  assert.equal(pathParamProblem({ name: 'day', type: 'date' }, '2026-11-01'), undefined);
  assert.equal(
    pathParamProblem({ name: 'size', type: 'enum', values: 'S, M ,L' }, 'XL'),
    'path parameter size must be one of S, M, L',
  );
  assert.equal(
    pathParamProblem({ name: 'sku', type: 'pattern', values: '^[A-Z]+-\\d+$' }, 'a1'),
    'path parameter sku must match /^[A-Z]+-\\d+$/',
  );
  assert.equal(pathParamProblem({ name: 'x' }, 'anything'), undefined);
  assert.equal(
    pathParamProblem({ name: 'x', type: 'enum' }, 'v'),
    undefined,
    'an empty list checks nothing',
  );
  assert.match(
    pathParamSetupProblem({ name: 'x', type: 'pattern', values: '(' }) ?? '',
    /not a regular expression/,
  );
  assert.match(pathParamSetupProblem({ name: 'x', type: 'enum' }) ?? '', /List the values/);
  const validation: MockValidation = { enabled: true, status: 422, checks: [] };
  const request = { query: new URLSearchParams(), headers: {}, body: '' };
  assert.deepEqual(
    validateMockRequest(validation, request, { id: 'abc' }, [{ name: 'id', type: 'integer' }]),
    [{ in: 'param', name: 'id', message: 'path parameter id must be an integer' }],
  );
  assert.deepEqual(
    validateMockRequest({ ...validation, enabled: false }, request, { id: 'abc' }, [
      { name: 'id', type: 'integer' },
    ]),
    [],
    'path parameters are checked only while the route validates',
  );
  assert.equal(
    describeValidation(validation, [{ name: 'id', type: 'integer' }, { name: 'x' }]),
    '1 path parameter; failures get 422',
  );
});

test('routes list their path parameters, try them with examples, and take them from specifications', () => {
  assert.deepEqual(mockPathParamNames('/users/:id/items/:sku/:id'), ['id', 'sku']);
  assert.deepEqual(
    mockPathParams({
      path: '/users/:id',
      pathParams: [
        { name: 'gone', type: 'uuid' },
        { name: 'id', example: '7' },
      ],
    }),
    [{ name: 'id', example: '7' }],
  );
  assert.equal(
    mockExamplePath({
      path: '/users/:id/items/:sku',
      pathParams: [{ name: 'id', example: 'a b' }],
    }),
    '/users/a%20b/items/sku',
  );
  const [route] = mockRoutesFromSpec({
    openapi: '3.0.3',
    paths: {
      '/orders/{id}/{size}': {
        parameters: [{ name: 'size', in: 'path', required: true, schema: { enum: ['S', 'M'] } }],
        get: {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Order number',
              schema: { type: 'integer', example: 42 },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
  assert.equal(route.path, '/orders/:id/:size');
  assert.deepEqual(route.pathParams, [
    { name: 'id', type: 'integer', example: '42', description: 'Order number' },
    { name: 'size', type: 'enum', values: 'S, M' },
  ]);
  assert.equal(route.validation?.enabled, true, 'typed path parameters turn validation on');
});

test('path parameters are added to, renamed in, and removed from the path', () => {
  assert.equal(addPathParam('/', 'id'), '/:id');
  assert.equal(addPathParam('/users/', 'id'), '/users/:id');
  assert.equal(addPathParam('/files/*', 'name'), '/files/:name/*');
  assert.equal(
    renamePathParam('/users/:id/items/:id2', 'id', 'userId'),
    '/users/:userId/items/:id2',
  );
  assert.equal(removePathParam('/users/:id/items', 'id'), '/users/items');
  assert.equal(removePathParam('/:id', 'id'), '/');
  assert.equal(validPathParamName('user_id'), true);
  assert.equal(validPathParamName('1st'), false);
  assert.equal(validPathParamName('a-b'), false);
});
