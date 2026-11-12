import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate';
import {
  convertDocument,
  importFiles,
  exportCollection,
  exportFormats,
  parseImportDocument,
  parseText,
} from './collection-transfer';
import type { ApiRequest, WorkspaceState } from './types';
const file = (name: string, source: unknown) => ({
  name,
  data: strToU8(typeof source === 'string' ? source : JSON.stringify(source)),
});
const request = (extra: Partial<ApiRequest> = {}): ApiRequest => ({
  id: 'one',
  name: 'List pets',
  folder: 'Shop/Pets',
  method: 'POST',
  url: 'https://api.example.com/pets',
  params: [{ key: 'limit', value: '5', enabled: true, description: 'Limit' }],
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
  body: '{"name":"Ada"}',
  bodyType: 'raw',
  rawContentType: 'application/json',
  auth: 'Basic auth',
  token: '',
  username: 'dev',
  password: 'PASSWORD-SECRET',
  credentialId: 'vault-id',
  tests: '',
  response: null,
  ...extra,
});
const workspace = (requests = [request()]): WorkspaceState => ({
  requests,
  environments: [
    {
      name: 'Development',
      variables: [{ key: 'base_url', value: 'https://api.example.com', enabled: true }],
    },
    {
      name: 'Production',
      variables: [{ key: 'base_url', value: 'https://prod.example.com', enabled: true }],
    },
  ],
  environment: 0,
  tabs: ['one'],
  history: [],
});
test('detects nested Postman collections, inherited auth, disabled rows, forms, environments and scripts', () => {
  const result = importFiles([
    file('anything.json', {
      info: { name: 'Store' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}' }] },
      variable: [{ key: 'base_url', value: 'https://api.example.com' }],
      item: [
        {
          name: 'Pets',
          item: [
            {
              name: 'Create',
              event: [{ listen: 'test' }],
              request: {
                method: 'POST',
                url: {
                  raw: '{{base_url}}/pets',
                  query: [{ key: 'hidden', value: 'x', disabled: true }],
                },
                header: [{ key: 'X-Test', value: 'one', description: 'Trace', disabled: true }],
                body: {
                  mode: 'formdata',
                  formdata: [
                    { key: 'name', value: 'Ada', type: 'text' },
                    { key: 'photo', type: 'file', src: 'cat.png' },
                  ],
                },
              },
            },
          ],
        },
      ],
    }),
  ]);
  const r = result.data.requests[0];
  assert.equal(r.folder, 'Store/Pets');
  assert.equal(r.auth, 'Bearer token');
  assert.equal(r.token, '{{access_token}}');
  assert.equal(r.headers![0].enabled, false);
  assert.equal(r.params![0].enabled, false);
  assert.equal(r.bodyFields![1].fileName, 'cat.png');
  assert.equal(result.data.environments![0].variables[0].key, 'base_url');
  assert.ok(result.warnings.some((w) => /scripts/.test(w)));
  assert.equal(
    importFiles([
      file('env.json', {
        _postman_variable_scope: 'environment',
        name: 'Only env',
        values: [{ key: 'a', value: false, enabled: false }],
      }),
    ]).data.environments![0].variables[0].value,
    'false',
  );
});
test('reads native Bruno grammar including JSON braces, disabled values, collection auth and environments from ZIP', () => {
  const source =
    'meta {\n name: Create\n type: http\n seq: 1\n}\npost {\n url: {{base_url}}/pets\n body: json\n auth: inherit\n}\nheaders {\n ~X-Trace: disabled\n}\nbody:json {\n {"nested":{"name":"Ada"}}\n}\n';
  const archive = zipSync({
    'store/bruno.json': strToU8('{"name":"Store","version":"1","type":"collection"}'),
    'store/collection.bru': strToU8(
      'auth {\n mode: bearer\n}\nauth:bearer {\n token: {{access_token}}\n}\n',
    ),
    'store/Pets/folder.bru': strToU8('auth {\n mode: inherit\n}\n'),
    'store/Pets/create.bru': strToU8(source),
    'store/environments/dev.bru': strToU8(
      'vars {\n base_url: https://api.example.com\n ~disabled: value\n}\n',
    ),
  });
  const result = importFiles([{ name: 'store.zip', data: archive }]);
  const r = result.data.requests[0];
  assert.equal(r.folder, 'store/Pets');
  assert.equal(JSON.parse(r.body!).nested.name, 'Ada');
  assert.equal(r.headers![0].enabled, false);
  assert.equal(r.auth, 'Bearer token');
  assert.equal(r.token, '{{access_token}}');
  assert.equal(result.data.environments![0].variables[1].enabled, false);
});
test('imports Bruno JSON exports and GraphQL bodies', () => {
  const result = convertDocument({
    name: 'Graph API',
    version: '1',
    items: [
      {
        name: 'People',
        type: 'http-request',
        request: {
          method: 'POST',
          url: 'https://api.example.com/graphql',
          params: [],
          headers: [],
          body: {
            mode: 'graphql',
            graphql: { query: '{ people { name } }', variables: '{"first":3}' },
          },
          auth: { mode: 'basic', basic: { username: 'dev', password: '{{password}}' } },
        },
      },
    ],
  });
  assert.equal(JSON.parse(result.data.requests[0].body!).variables.first, 3);
  assert.equal(result.data.requests[0].username, 'dev');
});
test('imports Hoppscotch collections, folders, inherited auth and headers, and environments', () => {
  const collections = [
    {
      v: 6,
      name: 'Store',
      auth: { authType: 'bearer', authActive: true, token: '<<token>>' },
      headers: [{ key: 'X-Team', value: 'web', active: true }],
      variables: [{ key: 'region', value: 'eu', active: true }],
      requests: [
        {
          v: '11',
          name: 'Health',
          method: 'GET',
          endpoint: '<<base_url>>/health',
          params: [{ key: 'verbose', value: '1', active: false }],
          headers: [],
          auth: { authType: 'none', authActive: true },
          body: { contentType: null, body: null },
          preRequestScript: '',
          testScript: '',
          requestVariables: [],
        },
      ],
      folders: [
        {
          v: 6,
          name: 'Pets',
          auth: { authType: 'inherit', authActive: true },
          headers: [{ key: 'x-team', value: 'pets', active: true }],
          folders: [],
          requests: [
            {
              name: 'Create',
              method: 'POST',
              endpoint: '<<base_url>>/pets',
              params: [],
              headers: [],
              auth: { authType: 'inherit', authActive: true },
              body: { contentType: 'application/json', body: '{"name":"Ada"}' },
              preRequestScript: '',
              testScript: 'pw.test("ok", () => {});',
              requestVariables: [{ key: 'id', value: '1', active: true }],
            },
            {
              name: 'Search',
              method: 'POST',
              endpoint: 'https://api.example.com/search',
              params: [],
              headers: [],
              auth: {
                authType: 'api-key',
                authActive: true,
                key: 'X-Key',
                value: 'k',
                addTo: 'QUERY_PARAMS',
              },
              body: { contentType: 'application/x-www-form-urlencoded', body: 'q: cats\n#page: 2' },
            },
            {
              name: 'Upload',
              method: 'PUT',
              endpoint: 'https://api.example.com/upload',
              auth: { authType: 'basic', authActive: false, username: 'a', password: 'b' },
              body: {
                contentType: 'multipart/form-data',
                body: [
                  { key: 'title', value: 'Rex', active: true, isFile: false },
                  { key: 'photo', value: [], active: true, isFile: true },
                ],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Catalog',
      folders: [],
      requests: [
        {
          name: 'Products',
          url: 'https://api.example.com/graphql',
          query: '{ products { sku } }',
          variables: '{"first":2}',
          headers: [],
          auth: {
            authType: 'oauth-2',
            authActive: true,
            grantTypeInfo: {
              grantType: 'CLIENT_CREDENTIALS',
              tokenEndpoint: 'https://auth.example.com/token',
              clientID: 'app',
              clientSecret: 's',
              scopes: 'read',
            },
          },
        },
      ],
    },
  ];
  const result = importFiles([file('hoppscotch-collections.json', collections)]);
  assert.equal(result.format, 'Hoppscotch');
  const [health, create, search, upload, products] = result.data.requests;
  assert.equal(health.url, '{{base_url}}/health');
  assert.equal(health.folder, 'Store');
  assert.equal(health.auth, 'None');
  assert.equal(health.params![0].enabled, false);
  assert.deepEqual(health.headers, [
    { key: 'X-Team', value: 'web', enabled: true, description: '' },
  ]);
  assert.equal(create.folder, 'Store/Pets');
  assert.equal(create.auth, 'Bearer token');
  assert.equal(create.token, '{{token}}');
  assert.equal(create.headers!.find((h) => h.key.toLowerCase() === 'x-team')!.value, 'pets');
  assert.equal(create.body, '{"name":"Ada"}');
  assert.equal(create.rawContentType, 'application/json');
  assert.deepEqual(search.params!.at(-1), { key: 'X-Key', value: 'k', enabled: true });
  assert.equal(search.bodyType, 'x-www-form-urlencoded');
  assert.deepEqual(
    search.bodyFields!.map((f) => [f.key, f.value, f.enabled]),
    [
      ['q', 'cats', true],
      ['page', '2', false],
    ],
  );
  assert.equal(upload.auth, 'None');
  assert.equal(upload.bodyType, 'form-data');
  assert.deepEqual(
    upload.bodyFields!.map((f) => f.kind),
    ['text', 'file'],
  );
  assert.equal(products.method, 'POST');
  assert.deepEqual(JSON.parse(products.body!), {
    query: '{ products { sku } }',
    variables: { first: 2 },
  });
  assert.equal(products.auth, 'OAuth 2.0 (request)');
  assert.equal(products.authOptions!.oauth2GrantType, 'client_credentials');
  assert.equal(products.authOptions!.oauth2TokenUrl, 'https://auth.example.com/token');
  assert.deepEqual(result.data.environments, [
    {
      name: 'Store variables',
      variables: [{ key: 'region', value: 'eu', enabled: true, description: '' }],
    },
  ]);
  assert.ok(result.warnings.some((w) => w.includes('scripts and tests are not executed')));
  assert.ok(result.warnings.some((w) => w.startsWith('Create: request variables')));

  const environments = importFiles([
    file('hoppscotch-environments.json', [
      {
        v: 2,
        id: 'e1',
        name: 'Staging',
        variables: [
          {
            key: 'base_url',
            initialValue: 'https://staging.example.com',
            currentValue: 'x',
            secret: false,
          },
          { key: 'token', initialValue: '', currentValue: '', secret: true },
          { key: 'login', initialValue: '<<base_url>>/login', secret: false },
        ],
      },
    ]),
  ]);
  assert.equal(environments.format, 'Hoppscotch');
  assert.deepEqual(environments.data.environments, [
    {
      name: 'Staging',
      variables: [
        { key: 'base_url', value: 'https://staging.example.com', enabled: true },
        { key: 'token', value: '', enabled: true },
        { key: 'login', value: '{{base_url}}/login', enabled: true },
      ],
    },
  ]);
  assert.ok(environments.warnings.some((w) => w.includes('secret values are not exported')));
  // A Bruno environment also flags secrets, but names its variables "name", not "key".
  const bruno = convertDocument({
    name: 'Dev',
    variables: [{ name: 'token', value: 't', secret: true }],
  });
  assert.equal(bruno.format, 'Environment');
});
test('imports Insomnia v4 parent graphs and v5 nested YAML with environments', () => {
  const v4 = {
    __export_format: 4,
    resources: [
      { _id: 'w', _type: 'workspace', name: 'Store' },
      { _id: 'f', _type: 'request_group', parentId: 'w', name: 'Pets' },
      {
        _id: 'e',
        _type: 'environment',
        name: 'Dev',
        data: { base_url: 'https://api.example.com', retries: 0 },
      },
      {
        _type: 'request',
        parentId: 'f',
        name: 'Create',
        method: 'POST',
        url: '{{ _.base_url }}/pets',
        authentication: { type: 'basic', username: 'dev', password: '{{password}}' },
        body: { mimeType: 'application/json', text: '{"name":"Ada"}' },
      },
    ],
  };
  const result = importFiles([file('insomnia.json', v4)]);
  assert.equal(result.data.requests[0].url, '{{base_url}}/pets');
  assert.equal(result.data.requests[0].folder, 'Store/Pets');
  assert.equal(result.data.environments![0].variables[1].value, '0');
  const v5 = parseText(
    'type: collection.insomnia.rest/5.0\nname: Shop\ncollection:\n  - name: Pets\n    children:\n      - name: List\n        method: GET\n        url: https://api.example.com/pets\nenvironments:\n  name: Base\n  data:\n    enabled: false\n',
  );
  assert.equal(v5.data.requests[0].folder, 'Shop/Pets');
  assert.equal(v5.data.environments![0].variables[0].value, 'false');
  assert.throws(
    () =>
      convertDocument({
        resources: [
          { _id: 'f', _type: 'request_group', parentId: 'f', name: 'Cycle' },
          { _type: 'request', parentId: 'f', url: 'https://example.com', name: 'Bad' },
        ],
      }),
    /Circular/,
  );
});
test('imports bundled OpenCollection including inherited auth and GraphQL', () => {
  const result = convertDocument({
    opencollection: '1.0.0',
    info: { name: 'Store' },
    request: { auth: { type: 'bearer', token: '{{token}}' } },
    config: {
      environments: [
        { name: 'Dev', variables: [{ name: 'base_url', value: 'https://api.example.com' }] },
      ],
    },
    items: [
      {
        info: { name: 'Pets', type: 'folder' },
        items: [
          {
            info: { name: 'List', type: 'http' },
            http: {
              method: 'GET',
              url: '{{base_url}}/pets',
              headers: [{ name: 'X-Trace', value: 'one', disabled: true }],
            },
          },
          {
            info: { name: 'Graph', type: 'graphql' },
            graphql: {
              url: 'https://api.example.com/graphql',
              body: { query: '{ pets { name } }', variables: { first: 1 } },
            },
          },
        ],
      },
    ],
  });
  assert.equal(result.data.requests[0].auth, 'Bearer token');
  assert.equal(result.data.requests[0].headers![0].enabled, false);
  assert.equal(JSON.parse(result.data.requests[1].body!).variables.first, 1);
});
const soap = `<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:pet" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" targetNamespace="urn:pet" name="PetService"><types><xsd:schema targetNamespace="urn:pet"><xsd:element name="GetPet"><xsd:complexType><xsd:sequence><xsd:element name="id" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema></types><message name="GetPetInput"><part name="parameters" element="tns:GetPet"/></message><portType name="PetPortType"><operation name="GetPet"><input message="tns:GetPetInput"/></operation></portType><binding name="PetBinding" type="tns:PetPortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/><operation name="GetPet"><soap:operation soapAction="urn:GetPet"/><input><soap:body use="literal"/></input></operation></binding><service name="PetService"><port name="PetPort" binding="tns:PetBinding"><soap:address location="https://api.example.com/soap"/></port></service></definitions>`;
test('WSDL generates endpoint-specific SOAP envelopes and rejects external entities', () => {
  const result = importFiles([file('pets.wsdl', soap)]),
    r = result.data.requests[0];
  assert.equal(r.name, 'GetPet');
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/soap');
  assert.ok(r.body!.includes('<tns:GetPet><id>{{id}}</id></tns:GetPet>'));
  assert.equal(r.headers![1].value, '"urn:GetPet"');
  assert.throws(
    () =>
      importFiles([
        file('bad.wsdl', '<!DOCTYPE x [<!ENTITY test SYSTEM "file:///etc/passwd">]><definitions/>'),
      ]),
    /entity|DTD/,
  );
  assert.throws(
    () => importFiles([file('bad.wsdl', '<definitions><bad></definitions>')]),
    /Invalid WSDL/,
  );
});
test('imports HAR, REST Client variables, and shell-quoted cURL without evaluating commands', () => {
  const result = parseText(
    "curl --url 'https://api.example.com/pets' -X POST -H 'Content-Type: application/json' --data-raw '{\"name\":\"a b\"}' -u 'user:pass'",
  );
  assert.equal(JSON.parse(result.data.requests[0].body!).name, 'a b');
  assert.equal(result.data.requests[0].username, 'user');
  assert.throws(() => parseText('curl https://example.com --output file.txt'), /Unsupported cURL/);
  assert.throws(() => parseText('curl https://example.com --data @secret.txt'), /file references/);
  const http = importFiles([
    file(
      'requests.http',
      '@base_url = https://api.example.com\n\n### Create pet\nPOST {{base_url}}/pets\nContent-Type: application/json\n\n{"name":"Ada"}\n\n### List\nGET {{base_url}}/pets\n',
    ),
  ]);
  assert.equal(http.data.requests.length, 2);
  assert.equal(http.data.requests[0].name, 'Create pet');
  assert.equal(http.data.environments![0].variables[0].key, 'base_url');
  const h = importFiles([
    file('capture.har', {
      log: {
        version: '1.2',
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://api.example.com/pets',
              queryString: [{ name: 'limit', value: '10' }],
              headers: [{ name: ':authority', value: 'example' }],
            },
          },
        ],
      },
    }),
  ]);
  assert.equal(h.data.requests[0].params![0].value, '10');
  assert.deepEqual(h.data.requests[0].headers, []);
});
test('all export formats produce imports that retain usable operations', () => {
  for (const format of exportFormats) {
    const input = workspace([
      request(
        format.id === 'wsdl'
          ? {
              body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetPet/></soap:Body></soap:Envelope>',
              headers: [{ key: 'SOAPAction', value: 'urn:GetPet', enabled: true }],
            }
          : {},
      ),
    ]);
    const output = exportCollection(input, format.id);
    const imported = importFiles([{ name: output.name, data: output.data }]);
    assert.equal(imported.data.requests.length, 1, format.id);
    assert.equal(imported.data.requests[0].url!.split('?')[0], input.requests[0].url, format.id);
    assert.equal(imported.data.requests[0].method, input.requests[0].method, format.id);
    assert.ok(!strFromU8(output.data).includes('PASSWORD-SECRET'), format.id);
  }
});
test('exports never expose vault links or recognized secrets, including ZIP members', () => {
  const state = workspace([
    request({
      token: 'TOKEN-SECRET',
      params: [{ key: 'api_key', value: 'PARAM-SECRET', enabled: true }],
      headers: [{ key: 'Authorization', value: 'HEADER-SECRET', enabled: true }],
    }),
  ]);
  state.environments[0].variables.push({
    key: 'private_token',
    value: 'ENV-SECRET',
    enabled: true,
  });
  for (const format of exportFormats.filter((f) => f.id !== 'wsdl')) {
    const out = exportCollection(state, format.id, true),
      entries = unzipSync(out.data);
    const contents = Object.values(entries)
      .map((bytes) => strFromU8(bytes))
      .join('\n');
    assert.doesNotMatch(
      contents,
      /PASSWORD-SECRET|TOKEN-SECRET|PARAM-SECRET|HEADER-SECRET|ENV-SECRET|vault-id/,
      format.id,
    );
  }
  assert.equal(
    state.requests[0].password,
    'PASSWORD-SECRET',
    'export must not mutate the live workspace',
  );
});
test('Postman ZIP contains every environment and Bruno ZIP contains every .bru request', () => {
  const out = exportCollection(workspace(), 'postman', true),
    files = unzipSync(out.data);
  assert.equal(Object.keys(files).length, 3);
  assert.equal(
    importFiles([{ name: out.name, data: out.data }]).data.environments!.length,
    2,
    'both environments without duplicate collection variables',
  );
  const bru = exportCollection(
    workspace([request(), request({ id: 'two', name: 'List pets' })]),
    'bruno',
  );
  assert.equal(Object.keys(unzipSync(bru.data)).filter((n) => n.endsWith('.bru')).length, 4);
});
test('lossy export reports unsupported protocols and duplicate specification operations', () => {
  const state = workspace([
    request(),
    request({ protocol: 'websocket', url: 'wss://example.com' }),
    request({ id: 'duplicate' }),
  ]);
  const result = exportCollection(state, 'openapi-json');
  assert.ok(result.warnings.some((w) => /WebSocket/.test(w)));
  assert.ok(result.warnings.some((w) => /duplicate/.test(w)));
  assert.throws(
    () => exportCollection(workspace([request({ protocol: 'grpc' })]), 'postman'),
    /No compatible/,
  );
  const native = exportCollection(state, 'workbench');
  assert.equal(
    importFiles([{ name: native.name, data: native.data }]).data.requests[1].protocol,
    'websocket',
  );
});
test('archives reject traversal, nested ZIPs, excessive expansion and malformed data atomically', () => {
  assert.throws(
    () => importFiles([{ name: 'evil.zip', data: zipSync({ '../evil.json': strToU8('{}') }) }]),
    /Unsafe archive/,
  );
  assert.throws(
    () => importFiles([{ name: 'evil.zip', data: zipSync({ 'C:\\evil.json': strToU8('{}') }) }]),
    /Unsafe archive/,
  );
  assert.throws(
    () => importFiles([{ name: 'nested.zip', data: zipSync({ 'other.zip': new Uint8Array() }) }]),
    /Nested ZIP/,
  );
  assert.throws(
    () =>
      importFiles([
        { name: 'large.zip', data: zipSync({ 'large.json': new Uint8Array(11 * 1024 * 1024) }) },
      ]),
    /limits/,
  );
  assert.throws(
    () => importFiles([file('good.json', workspace()), file('bad.json', '{bad')]),
    /bad.json/,
  );
  assert.throws(() => importFiles([file('same.json', '{}'), file('same.json', '{}')]), /Duplicate/);
  assert.throws(() => parseImportDocument('a: 1\na: 2'), /unique/);
  assert.throws(() => parseImportDocument('x'.repeat(10 * 1024 * 1024 + 1)), /10 MB/);
});
test('OpenAPI ZIP bundles local external references without fetching remote files', () => {
  const root = {
    openapi: '3.1.0',
    paths: {
      '/pets': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: 'schemas/pet.yaml#/Pet' } } },
          },
        },
      },
    },
  };
  const result = importFiles([
    {
      name: 'spec.zip',
      data: zipSync({
        'openapi.json': file('', root).data,
        'schemas/pet.yaml': strToU8(
          'Pet:\n  type: object\n  properties:\n    name:\n      type: string\n      example: Ada\n    friend:\n      $ref: "#/Friend"\nFriend:\n  type: object\n  properties:\n    active:\n      type: boolean\n',
        ),
      }),
    },
  ]);
  assert.deepEqual(JSON.parse(result.data.requests[0].body!), {
    name: 'Ada',
    friend: { active: false },
  });
  assert.throws(
    () =>
      importFiles([
        file('remote.json', {
          openapi: '3.1.0',
          paths: {
            '/pets': {
              get: { parameters: [{ $ref: 'https://example.com/secret.yaml#/Parameter' }] },
            },
          },
        }),
      ]),
    /not a local file/,
  );
  assert.throws(() => importFiles([file('missing.json', root)]), /Missing referenced file/);
});
test('native Bruno and OpenCollection ZIPs retain gRPC proto files and WebSocket messages', () => {
  const input = workspace([
    request({
      protocol: 'grpc',
      grpc: {
        proto:
          'syntax = "proto3"; package pet; service Pets { rpc Get(Input) returns (Input); } message Input { string id = 1; }',
        method: 'pet.Pets/Get',
        tls: false,
      },
      body: '{"id":"one"}',
    }),
    request({
      protocol: 'websocket',
      url: 'wss://api.example.com/socket',
      name: 'Echo',
      body: 'hello',
    }),
  ]);
  for (const format of ['bruno', 'opencollection']) {
    const out = exportCollection(input, format),
      imported = importFiles([{ name: out.name, data: out.data }]);
    assert.equal(imported.data.requests[0].grpc?.proto, input.requests[0].grpc!.proto, format);
    assert.equal(imported.data.requests[0].grpc?.method, 'pet.Pets/Get', format);
    assert.equal(imported.data.requests[1].protocol, 'websocket', format);
    assert.equal(imported.data.requests[1].body, 'hello', format);
    assert.ok(!imported.warnings.some((w) => /load.*proto/.test(w)), format);
  }
});
test('structured forms survive collection and specification conversion', () => {
  for (const mode of ['form-data', 'x-www-form-urlencoded'] as const) {
    const input = workspace([
      request({
        body: '',
        bodyType: mode,
        bodyFields: [{ key: 'name', value: 'Ada Lovelace', enabled: true, kind: 'text' }],
      }),
    ]);
    for (const format of [
      'postman',
      'bruno',
      'opencollection',
      'insomnia',
      'insomnia-v4',
      'openapi-json',
      'swagger',
      'har',
    ]) {
      const out = exportCollection(input, format),
        imported = importFiles([{ name: out.name, data: out.data }]);
      assert.equal(imported.data.requests[0].bodyType, mode, format);
      assert.equal(imported.data.requests[0].bodyFields![0].value, 'Ada Lovelace', format);
    }
    const out = exportCollection(input, 'curl'),
      imported = importFiles([{ name: out.name, data: out.data }]);
    if (mode === 'form-data')
      assert.equal(imported.data.requests[0].bodyFields![0].value, 'Ada Lovelace');
    else
      assert.equal(new URLSearchParams(imported.data.requests[0].body).get('name'), 'Ada Lovelace');
  }
});
test('OpenAPI auth, path placeholders, schema samples and SOAP 1.2 headers are usable', () => {
  const doc = {
    openapi: '3.1.0',
    servers: [{ url: 'https://example.com' }],
    security: [{ Bearer: [] }],
    components: { securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/pets/{id}': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { active: { type: 'boolean' }, count: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },
  };
  const r = convertDocument(doc).data.requests[0];
  assert.equal(r.auth, 'Bearer token');
  assert.equal(r.url, 'https://example.com/pets/{{id}}');
  assert.deepEqual(JSON.parse(r.body!), { active: false, count: 0 });
  for (const format of ['openapi-json', 'swagger']) {
    const out = exportCollection(
      workspace([request({ url: 'https://example.com/pets/{{id}}' })]),
      format,
    );
    assert.equal(
      importFiles([{ name: out.name, data: out.data }]).data.requests[0].url,
      'https://example.com/pets/{{id}}',
    );
  }
  const soap12 = soap.replace(
    'xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
    'xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap12/"',
  );
  const imported = importFiles([file('soap12.wsdl', soap12)]).data.requests[0];
  assert.ok(imported.headers![0].value.includes('application/soap+xml'));
  assert.ok(imported.headers![0].value.includes('action="urn:GetPet"'));
  assert.equal(imported.headers!.length, 1);
});
test('Postman digest, AWS, OAuth 1.0, and JWT auth import and export without secrets', () => {
  const kv = (values: Record<string, string>) =>
    Object.entries(values).map(([key, value]) => ({ key, value, type: 'string' }));
  const importWarnings: string[] = [];
  const imported = convertDocument(
    {
      info: {
        name: 'Signed',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Digest',
          request: {
            method: 'GET',
            url: 'https://x.test/d',
            auth: { type: 'digest', digest: kv({ username: 'u', password: 'p' }) },
          },
        },
        {
          name: 'AWS',
          request: {
            method: 'GET',
            url: 'https://x.test/a',
            auth: {
              type: 'awsv4',
              awsv4: kv({
                accessKey: 'AK',
                secretKey: 'SK',
                region: 'eu-west-1',
                service: 'execute-api',
                sessionToken: 'ST',
              }),
            },
          },
        },
        {
          name: 'OAuth',
          request: {
            method: 'GET',
            url: 'https://x.test/o',
            auth: {
              type: 'oauth1',
              oauth1: kv({
                consumerKey: 'ck',
                consumerSecret: 'cs',
                token: 't',
                tokenSecret: 'ts',
                signatureMethod: 'RSA-SHA1',
                realm: 'r',
              }),
            },
          },
        },
        {
          name: 'JWT',
          request: {
            method: 'GET',
            url: 'https://x.test/j',
            auth: {
              type: 'jwt',
              jwt: kv({
                algorithm: 'RS256',
                secret: 'pem',
                payload: '{"sub":"a"}',
                headerPrefix: 'JWT',
                isSecretBase64Encoded: 'false',
              }),
            },
          },
        },
      ],
    },
    importWarnings,
  );
  const [digest, aws, oauth, jwt] = imported.data.requests;
  assert.deepEqual([digest.auth, digest.username, digest.password], ['Digest auth', 'u', 'p']);
  assert.deepEqual(
    [
      aws.auth,
      aws.username,
      aws.password,
      aws.authOptions?.awsRegion,
      aws.authOptions?.awsService,
      aws.authOptions?.awsSessionToken,
    ],
    ['AWS Signature', 'AK', 'SK', 'eu-west-1', 'execute-api', 'ST'],
  );
  assert.deepEqual(
    [oauth.auth, oauth.authOptions?.oauth1SignatureMethod, oauth.authOptions?.oauth1Token],
    ['OAuth 1.0', 'HMAC-SHA1', 't'],
  );
  assert.deepEqual(
    [jwt.auth, jwt.authOptions?.jwtAlgorithm, jwt.authOptions?.jwtPrefix, jwt.password],
    ['JWT bearer', 'RS256', 'JWT', 'pem'],
  );
  assert.ok(
    importWarnings.some((warning) => warning.includes('RSA-SHA1')),
    'unsupported OAuth signature methods are reported',
  );
  const requests = [digest, aws, oauth, jwt].map((item, index) =>
    request({
      ...item,
      id: `r${index}`,
      name: item.name!,
      auth: item.auth!,
      authOptions: item.authOptions,
      username: item.username || '',
      password: item.password || '',
      token: '',
    }),
  );
  const exported = JSON.parse(strFromU8(exportCollection(workspace(requests), 'postman').data));
  const types = exported.item.flatMap(function walk(node: {
    item?: unknown[];
    request?: { auth?: { type: string } };
  }): unknown[] {
    return node.item
      ? node.item.flatMap((child) => walk(child as typeof node))
      : [node.request?.auth];
  });
  assert.deepEqual(
    types.map((auth: { type: string }) => auth.type),
    ['digest', 'awsv4', 'oauth1', 'jwt'],
  );
  const text = JSON.stringify(exported);
  for (const secret of ['"SK"', '"ST"', '"cs"', '"ts"', '"pem"', '"p"'])
    assert.ok(!text.includes(secret), `export excludes ${secret}`);
  assert.ok(
    text.includes('eu-west-1') && text.includes('RS256'),
    'non-secret signing settings are exported',
  );
});
test('Postman OAuth 2.0 imports as request OAuth and exports without secrets', () => {
  const kv = (values: Record<string, string>) =>
    Object.entries(values).map(([key, value]) => ({ key, value, type: 'string' }));
  const warnings: string[] = [];
  const imported = convertDocument(
    {
      info: {
        name: 'OAuth',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Client',
          request: {
            method: 'GET',
            url: 'https://x.test/a',
            auth: {
              type: 'oauth2',
              oauth2: kv({
                grant_type: 'client_credentials',
                accessTokenUrl: 'https://id.test/token',
                clientId: 'app',
                clientSecret: 'SECRET',
                scope: 'read',
                client_authentication: 'body',
                accessToken: 'TOKEN',
              }),
            },
          },
        },
        {
          name: 'Implicit',
          request: {
            method: 'GET',
            url: 'https://x.test/b',
            auth: {
              type: 'oauth2',
              oauth2: kv({
                grant_type: 'implicit',
                authUrl: 'https://id.test/authorize',
                clientId: 'spa',
              }),
            },
          },
        },
      ],
    },
    warnings,
  );
  const [client, implicit] = imported.data.requests;
  assert.equal(client.auth, 'OAuth 2.0 (request)');
  assert.equal(client.token, 'TOKEN');
  assert.deepEqual(client.authOptions, {
    oauth2GrantType: 'client_credentials',
    oauth2AuthorizationUrl: '',
    oauth2TokenUrl: 'https://id.test/token',
    oauth2ClientId: 'app',
    oauth2ClientSecret: 'SECRET',
    oauth2ClientAuth: 'body',
    oauth2Scope: 'read',
    oauth2Audience: '',
  });
  assert.equal(implicit.authOptions?.oauth2GrantType, 'authorization_code');
  assert.ok(warnings.some((warning) => warning.includes('implicit grant')));
  const out = JSON.parse(
    strFromU8(
      exportCollection(
        workspace([
          request({
            ...client,
            id: 'c',
            name: 'Client',
            auth: 'OAuth 2.0 (request)',
            authOptions: client.authOptions,
            token: 'TOKEN',
            username: '',
            password: '',
          }),
        ]),
        'postman',
      ).data,
    ),
  );
  const text = JSON.stringify(out);
  assert.ok(
    text.includes('"oauth2"') &&
      text.includes('https://id.test/token') &&
      text.includes('client_credentials'),
  );
  assert.ok(
    !text.includes('SECRET') && !text.includes('TOKEN'),
    'client secrets and tokens are not exported',
  );
});

test('Postman path variables become {{variables}}, and ports stay ports', () => {
  const imported = convertDocument({
    info: {
      name: 'Ports',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      { name: 'Port', request: { method: 'GET', url: 'http://127.0.0.1:8080/users/:id' } },
      {
        name: 'Variable host',
        request: { method: 'GET', url: '{{base}}:9000/orders/:orderId?x=1' },
      },
    ],
  });
  assert.deepEqual(
    imported.data.requests.map((request) => request.url),
    ['http://127.0.0.1:8080/users/{{id}}', '{{base}}:9000/orders/{{orderId}}?x=1'],
  );
});
