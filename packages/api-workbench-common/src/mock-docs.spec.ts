import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { mockDocumentation, mockOpenAPIDocument, openAPIPath } from './mock-docs';
import { newMock, newMockRoute } from './mocks';
import type { MockServer } from './types';

const header = (key: string, value: string) => ({ key, value, enabled: true });
function sample(): MockServer {
  return newMock(
    'Shop',
    [],
    [
      newMockRoute({
        method: 'GET',
        path: '/users/:id',
        name: 'Get user',
        headers: [header('Content-Type', 'application/json')],
        body: '{"id": 1}',
        pathParams: [{ name: 'id', type: 'integer', example: '7' }],
        responses: [
          { id: 'r', name: 'Missing', rules: [], status: 404, headers: [], body: '', delayMs: 0 },
        ],
      }),
      newMockRoute({
        method: 'POST',
        path: '/orders',
        status: 201,
        validation: {
          enabled: true,
          checks: [
            { enabled: true, target: 'header', name: 'X-Key', operator: 'exists', value: '' },
          ],
          schema: '{"type":"object","required":["sku"]}',
          status: 422,
        },
      }),
      newMockRoute({ method: 'ANY', path: '/files/*' }),
      newMockRoute({ kind: 'websocket', path: '/ws' }),
      newMockRoute({ method: 'DELETE', path: '/off', enabled: false }),
    ],
  );
}

test('mock paths are written in OpenAPI form', () => {
  assert.equal(openAPIPath('/users/:id/posts/:post'), '/users/{id}/posts/{post}');
  assert.equal(openAPIPath('/files/*'), '/files/{wildcard}');
  assert.equal(openAPIPath(''), '/');
});

test('the OpenAPI document covers enabled HTTP routes with params, bodies, and responses', () => {
  const mock = sample();
  const document = mockOpenAPIDocument(mock) as {
    servers: { url: string }[];
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  assert.equal(document.servers[0].url, `http://localhost:${mock.port}`);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/files/{wildcard}',
    '/orders',
    '/users/{id}',
  ]);
  const getUser = document.paths['/users/{id}'].get;
  assert.deepEqual(getUser.parameters, [
    { name: 'id', in: 'path', required: true, schema: { type: 'integer', example: '7' } },
  ]);
  assert.deepEqual(getUser.responses, {
    200: { description: 'Get user', content: { 'application/json': { example: { id: 1 } } } },
    404: { description: 'Missing' },
  });
  const order = document.paths['/orders'].post;
  assert.deepEqual((order.parameters as { name: string; in: string }[])[0].name, 'X-Key');
  assert.ok(order.requestBody);
  assert.ok((order.responses as Record<string, unknown>)[422]);
  assert.deepEqual(Object.keys(document.paths['/files/{wildcard}']), [
    'get',
    'post',
    'put',
    'patch',
    'delete',
  ]);
});

test('Swagger, YAML, and Markdown formats are generated from the same operations', () => {
  const mock = sample();
  const swagger = JSON.parse(mockDocumentation(mock, 'Swagger JSON').text);
  assert.equal(swagger.swagger, '2.0');
  assert.equal(swagger.host, `localhost:${mock.port}`);
  assert.deepEqual(swagger.paths['/users/{id}'].get.produces, ['application/json']);
  assert.deepEqual(swagger.paths['/users/{id}'].get.responses['200'].examples, {
    'application/json': { id: 1 },
  });
  assert.equal(swagger.paths['/orders'].post.parameters.at(-1).in, 'body');
  const yaml = mockDocumentation(mock, 'OpenAPI YAML');
  assert.equal(yaml.extension, 'yaml');
  assert.equal(parse(yaml.text).openapi, '3.0.3');
  const markdown = mockDocumentation(mock, 'Markdown').text;
  assert.match(markdown, /^# Shop/);
  assert.match(markdown, /## GET \/users\/\{id\}/);
  assert.doesNotMatch(markdown, /\/ws|\/off/);
});
