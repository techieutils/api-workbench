import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { buildDocument, collectionRequests, serialize, swaggerDocument } from './documentation';
import type { ApiRequest } from './types';
function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id: 'test-id',
    name: 'Create item',
    method: 'POST',
    folder: 'Items',
    url: 'https://example.com/items/{{id}}?existing=keep',
    params: [
      { key: 'tag', value: 'one', enabled: true, description: 'Tag filter' },
      { key: 'tag', value: 'two', enabled: true },
      { key: 'disabled', value: 'skip', enabled: false },
    ],
    headers: [{ key: 'X-Trace', value: 'trace', enabled: true }],
    body: '{"name":"Example","password":"BODY-SECRET"}',
    auth: 'Bearer token',
    token: 'TOKEN-SECRET',
    username: '',
    password: 'PASSWORD-SECRET',
    tests: '',
    response: null,
    ...overrides,
  };
}
test('collection documentation creates OpenAPI paths, descriptions, repeated params, body and auth', () => {
  const source = request();
  const before = JSON.stringify(source);
  const doc = buildDocument('Items', [source]) as {
    openapi: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  assert.equal(doc.openapi, '3.0.3');
  const op = doc.paths['/items/{id}'].post;
  const parameters = op.parameters as {
    name: string;
    in: string;
    required: boolean;
    example?: unknown;
    description: string;
  }[];
  assert.equal(parameters.find((row) => row.name === 'id')?.required, true);
  assert.deepEqual(parameters.find((row) => row.name === 'tag')?.example, ['one', 'two']);
  assert.equal(parameters.find((row) => row.name === 'tag')?.description, 'Tag filter');
  assert.equal(
    parameters.some((row) => row.name === 'disabled'),
    false,
  );
  assert.equal(
    parameters.some((row) => row.name === 'existing'),
    true,
  );
  assert.ok(op.requestBody);
  assert.ok(op.security);
  assert.equal(JSON.stringify(source), before, 'generation never mutates saved requests');
  const text = JSON.stringify(doc);
  assert.equal(text.includes('BODY-SECRET'), false);
  assert.equal(text.includes('TOKEN-SECRET'), false);
  assert.deepEqual(
    parse(serialize(doc, true)),
    JSON.parse(JSON.stringify(doc)),
    'YAML and JSON describe the same document',
  );
});
test('documentation keeps variables unresolved and masks query/header credentials', () => {
  const source = request({
    url: '{{base_url}}/items?api_key=QUERY-SECRET',
    params: [{ key: 'token', value: 'PARAM-SECRET', enabled: true }],
    headers: [{ key: 'Authorization', value: 'Bearer HEADER-SECRET', enabled: true }],
  });
  const collection = collectionRequests([source]);
  const text = JSON.stringify(collection);
  for (const secret of [
    'QUERY-SECRET',
    'PARAM-SECRET',
    'HEADER-SECRET',
    'PASSWORD-SECRET',
    'TOKEN-SECRET',
    'BODY-SECRET',
  ])
    assert.equal(text.includes(secret), false, secret);
  assert.ok(collection[0].url.startsWith('{{base_url}}'));
  const doc = buildDocument('Items', [source]) as {
    servers: { url: string; variables: Record<string, { default: string }> }[];
  };
  assert.equal(doc.servers[0].url, '{base_url}');
  assert.equal(doc.servers[0].variables.base_url.default, 'https://example.com');
});
test('Swagger JSON converts multipart fields, auth schemes, and query examples', () => {
  const doc = swaggerDocument(
    buildDocument('Items', [
      request({
        auth: 'Basic auth',
        bodyType: 'form-data',
        bodyFields: [
          { key: 'file', value: '', enabled: true, kind: 'file' },
          { key: 'caption', value: 'hello', enabled: true },
        ],
      }),
    ]),
  ) as {
    swagger: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    securityDefinitions: Record<string, unknown>;
  };
  assert.equal(doc.swagger, '2.0');
  const op = doc.paths['/items/{id}'].post;
  const parameters = op.parameters as {
    name: string;
    in: string;
    type: string;
    'x-example'?: unknown;
  }[];
  assert.equal(parameters.find((row) => row.name === 'file')?.type, 'file');
  assert.equal(parameters.find((row) => row.name === 'caption')?.in, 'formData');
  assert.deepEqual(parameters.find((row) => row.name === 'tag')?.['x-example'], ['one', 'two']);
  assert.equal('requestBody' in op, false);
  assert.deepEqual(Object.values(doc.securityDefinitions), [{ type: 'basic' }]);
});
test('alternate saved requests with the same path/method remain documented', () => {
  const doc = buildDocument('Items', [
    request(),
    request({ id: 'another', name: 'Other example' }),
  ]) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  assert.equal((doc.paths['/items/{id}'].post['x-workbench-variants'] as unknown[]).length, 1);
});

test('OpenAPI omits non-HTTP transports while collection JSON keeps live protocol settings', () => {
  const source = request({
    protocol: 'grpc',
    url: 'localhost:50051',
    grpc: { proto: 'syntax="proto3";', method: '/test.Echo/Unary', tls: true },
  });
  const live = collectionRequests([source])[0];
  assert.equal(live.protocol, 'grpc');
  assert.deepEqual(live.grpc, source.grpc);
  assert.deepEqual(Object.keys(buildDocument('Live', [source]).paths as object), []);
  const websocket = request({ protocol: 'websocket', url: 'wss://example.com/ws' });
  assert.deepEqual(Object.keys(buildDocument('Live', [websocket]).paths as object), []);
});

test('operations are tagged with the collection, then the request’s own tags', () => {
  const document = buildDocument('Items', [request({ tags: ['beta'] })], {
    tagsOf: (item) => ['items', ...(item.tags ?? [])],
  });
  const operation = Object.values(
    document.paths as Record<string, Record<string, { tags: string[] }>>,
  )[0].post;
  assert.deepEqual(operation.tags, ['Items', 'beta'], 'the collection name is not repeated');
  const plain = buildDocument('Items', [request()]);
  assert.deepEqual(
    Object.values(plain.paths as Record<string, Record<string, { tags: string[] }>>)[0].post.tags,
    ['Items'],
  );
});
