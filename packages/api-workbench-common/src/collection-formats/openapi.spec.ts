import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiRequest } from '../types';
import { openAPICollection } from './openapi';
const convert = (source: Record<string, unknown>): { requests: ApiRequest[] } =>
  openAPICollection(source) as { requests: ApiRequest[] };
test('Swagger imports host/base path, grouped operations, parameter descriptions and body examples', () => {
  const {
    requests: [request],
  } = convert({
    swagger: '2.0',
    host: 'api.example.com',
    basePath: '/v1',
    schemes: ['https'],
    info: { title: 'Shop' },
    paths: {
      '/pets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, default: 'a b' }],
        post: {
          tags: ['Pets'],
          summary: 'Update pet',
          consumes: ['application/json'],
          parameters: [
            { name: 'limit', in: 'query', type: 'integer', default: 0, description: 'Page size' },
            { name: 'body', in: 'body', schema: { example: { active: false } } },
          ],
        },
      },
    },
  });
  assert.equal(request.url, 'https://api.example.com/v1/pets/a%20b');
  assert.equal(request.folder, 'Pets');
  assert.deepEqual(request.params[0], {
    key: 'limit',
    value: '0',
    enabled: true,
    description: 'Page size',
  });
  assert.equal(JSON.parse(request.body).active, false);
  assert.equal(request.headers[0].value, 'application/json');
});
test('OpenAPI resolves references, operation overrides, server variables and falsy examples', () => {
  const {
    requests: [request],
  } = convert({
    openapi: '3.1.0',
    servers: [{ url: 'https://{region}.example.com/v1', variables: { region: { default: 'eu' } } }],
    components: {
      parameters: {
        Trace: {
          name: 'X-Trace',
          in: 'header',
          required: true,
          description: 'Trace ID',
          example: false,
        },
      },
      requestBodies: {
        Pet: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
      },
      schemas: { Pet: { example: { name: 'Cat' } } },
    },
    paths: {
      '/pets/{id}': {
        parameters: [{ name: 'q', in: 'query', description: 'Inherited', example: 'old' }],
        put: {
          parameters: [
            { $ref: '#/components/parameters/Trace' },
            { name: 'q', in: 'query', description: 'Override', example: '' },
          ],
          requestBody: { $ref: '#/components/requestBodies/Pet' },
        },
      },
    },
  });
  assert.equal(request.url, 'https://eu.example.com/v1/pets/{{id}}');
  assert.equal(request.params.length, 1);
  assert.equal(request.params[0].description, 'Override');
  assert.equal(request.params[0].value, '');
  assert.equal(request.headers[0].value, 'false');
  assert.equal(JSON.parse(request.body).name, 'Cat');
});
test('unsupported or unresolved references and empty specifications fail explicitly', () => {
  assert.throws(() => convert({ openapi: '4.0.0', paths: {} }), /Supported specifications/);
  assert.throws(() => convert({ swagger: '2.0', paths: {} }), /No supported HTTP operations/);
  for (const reference of ['other.yaml#/parameter', '#/missing']) {
    assert.throws(
      () =>
        convert({
          openapi: '3.0.0',
          paths: { '/pets': { get: { parameters: [{ $ref: reference }] } } },
        }),
      /references|reference/,
    );
  }
});
