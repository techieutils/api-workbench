import { draftFrom } from './editing';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SendResult } from './report';
import {
  jsonTokens,
  mockDetailsView,
  mockLine,
  networkEntry,
  networkView,
  queryParams,
  requestView,
  responseView,
  shortName,
} from './views';

const sent = (extra: Partial<SendResult> = {}): SendResult => ({
  request: { id: 'list', name: 'List users', method: 'GET', folder: 'Users' },
  url: 'https://api.example.com/v1/users?limit=2',
  status: 200,
  statusText: 'OK',
  httpVersion: '2',
  durationMs: 182.4,
  size: 2458,
  tests: [
    { label: 'status 200', pass: true, message: '' },
    { label: 'body.users exists', pass: false, message: 'missing' },
  ],
  captures: [{ variable: 'userId' }, { variable: 'token', error: 'no match' }],
  passed: false,
  headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': '<hidden>' },
  body: '{"users":[{"id":1,"name":"Ada"}],"more":true}',
  ...extra,
});

test('a response as the webview shows it', () => {
  const view = responseView(sent());
  assert.equal(view.status, '200 OK');
  assert.equal(view.ok, true);
  assert.deepEqual(view.timing, ['182 ms', '2.4 KB', 'HTTP/2']);
  assert.equal(view.json, true);
  assert.match(view.body, /^\{\n {2}"users": \[/);
  assert.equal(view.testSummary, '1/2 passed');
  assert.deepEqual(view.captures, [
    { name: 'userId', ok: true, message: 'captured' },
    { name: 'token', ok: false, message: 'no match' },
  ]);
  // Hidden header values stay hidden.
  assert.deepEqual(view.headers[1], { key: 'set-cookie', value: '<hidden>' });
});

test('a send that got no response', () => {
  const view = responseView(sent({ error: 'connect ECONNREFUSED', status: undefined, body: '' }));
  assert.equal(view.status, 'No response');
  assert.equal(view.ok, false);
  assert.equal(view.error, 'connect ECONNREFUSED');
  assert.deepEqual(view.timing, ['182 ms', '2.4 KB']);
});

test('text bodies are not taken for JSON', () => {
  const view = responseView(sent({ headers: { 'content-type': 'text/plain' }, body: '{oops' }));
  assert.equal(view.json, false);
  assert.equal(view.body, '{oops');
});

test('JSON tokens join back into the text', () => {
  const text = '{\n  "id": "cus_8f",\n  "n": -1.5e3,\n  "ok": true,\n  "q": "a \\"b\\""\n}';
  const tokens = jsonTokens(text);
  assert.equal(tokens.map((token) => token.text).join(''), text);
  assert.deepEqual(
    tokens.filter((token) => token.kind !== 'punctuation').map((token) => token.kind),
    ['key', 'string', 'key', 'number', 'key', 'literal', 'key', 'string'],
  );
});

test('query parameters as written, variables and all', () => {
  assert.deepEqual(queryParams('{{base}}/v1/customers?limit=20&status=active&q=a%20b&flag'), [
    { key: 'limit', value: '20' },
    { key: 'status', value: 'active' },
    { key: 'q', value: 'a b' },
    { key: 'flag', value: '' },
  ]);
  assert.deepEqual(queryParams('https://example.com/'), []);
  assert.deepEqual(queryParams('x?bad=%E0%A4%A'), [{ key: 'bad', value: '%E0%A4%A' }]);
});

test('the request editor', () => {
  const view = requestView(
    {
      id: 'list',
      name: 'List customers',
      folder: 'Payments API/Customers',
      method: 'GET',
      protocol: 'http',
      url: '{{baseUrl}}/v1/customers?limit=20',
      auth: 'Bearer',
      tags: ['smoke'],
      inheritedTags: [{ tag: 'payments', from: 'Payments API' }],
      headers: [{ key: 'Authorization', value: '<hidden>', enabled: true }],
      tests: ['status 200'],
      captures: [],
    },
    { environment: 'Staging', hasFile: true },
  );
  assert.deepEqual(view.breadcrumb, ['Payments API', 'Customers', 'List customers']);
  assert.deepEqual(view.params, [{ key: 'limit', value: '20' }]);
  assert.deepEqual(view.tags, ['smoke', 'payments']);
  assert.equal(view.sendable, true);
  assert.equal(view.environment, 'Staging');
});

test('what mock start prints', () => {
  assert.deepEqual(mockLine('Mock “Shop” on http://127.0.0.1:4010. Ctrl+C to stop.'), {
    started: 'http://127.0.0.1:4010',
  });
  assert.deepEqual(
    mockLine('Mock “Shop” on https://127.0.0.1:4443, gRPC on 50051. Ctrl+C to stop.'),
    {
      started: 'https://127.0.0.1:4443',
    },
  );
  assert.deepEqual(mockLine('12:04:31  GET    /orders?limit=10  200'), {
    entry: { time: '12:04:31', method: 'GET', path: '/orders?limit=10', status: '200' },
  });
  assert.deepEqual(mockLine('Stopped.'), { stopped: true });
  assert.equal(mockLine('something else'), undefined);
});

test('the network log places each send on a waterfall', () => {
  const first = networkEntry(sent({ durationMs: 100 }), 1000);
  const second = networkEntry(
    sent({ url: 'https://api.example.com/v1/orders', status: 409, durationMs: 100 }),
    1100,
  );
  const view = networkView([first, second]);
  assert.deepEqual(
    view.entries.map((e) => [e.name, e.status, e.ok, e.type, e.left, e.width]),
    [
      ['v1/users?limit=2', '200', true, 'application/json', 0, 50],
      ['v1/orders', '409', false, 'application/json', 50, 50],
    ],
  );
  assert.deepEqual(networkView([]).entries, []);
});

test('short names for URLs', () => {
  assert.equal(shortName('https://x.example.com/orders/ord_5?x=1'), 'orders/ord_5?x=1');
  assert.equal(shortName('https://x.example.com/'), 'x.example.com');
  assert.equal(shortName('not a url'), 'not a url');
});

test('a response keeps its raw body, captured values, and hidden cookies apart', () => {
  const view = responseView(
    sent({
      captures: [
        { variable: 'orderId', value: 'ord_1' },
        { variable: 'accessToken', value: 'secret-value' },
        { variable: 'missing', error: 'no match' },
      ],
    }),
  );
  assert.equal(view.rawBody, '{"users":[{"id":1,"name":"Ada"}],"more":true}');
  assert.notEqual(view.body, view.rawBody, 'the body shown is formatted');
  assert.deepEqual(view.captured, [
    { name: 'orderId', value: 'ord_1' },
    { name: 'accessToken', value: 'hidden' },
  ]);
  assert.deepEqual(view.cookies, []);
  assert.equal(view.cookiesHidden, true);
  assert.ok(view.timeline.length > 2);
});

test('a request editor starts from the request as saved', () => {
  const view = requestView(
    {
      id: 'r',
      name: 'Create',
      folder: 'Orders',
      method: 'POST',
      protocol: 'http',
      url: '{{base}}/orders',
      auth: 'None',
      tags: [],
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: '9 bytes',
      bodyText: '{"a": 1}',
      bodyType: 'raw',
      tests: [],
      captures: [],
    },
    { hasFile: true, revision: 3 },
  );
  assert.equal(view.kind, 'saved');
  assert.equal(view.revision, 3);
  assert.deepEqual(view.saved, {
    method: 'POST',
    url: '{{base}}/orders',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: '{"a": 1}',
    tests: '',
    tags: [],
    captures: [],
    bodyType: 'raw',
    form: [],
    auth: {
      type: 'None',
      username: '',
      secret: '',
      apiKeyIn: 'header',
      credentialId: '',
      options: {},
      secrets: {},
    },
  });
  assert.equal(view.bodyEditable, true);
  // A form's settings come in; others the command line shows (an API key's place) do not, as the
  // editor posts the draft back and `draftFrom` takes only the forms' fields.
  const signed = requestView(
    {
      ...(view as never as object),
      id: 'r',
      folder: 'Orders',
      headers: [],
      tests: [],
      captures: [],
      tags: [],
      auth: 'AWS Signature',
      authDetails: {
        type: 'AWS Signature',
        username: 'AKID',
        hasSecret: true,
        apiKeyIn: 'query',
        options: { apiKeyIn: 'query', awsRegion: 'eu-west-1', future: 'x' },
        saved: ['password'],
      },
    } as never,
    { hasFile: false },
  );
  assert.deepEqual(signed.saved.auth.options, { awsRegion: 'eu-west-1' });
  assert.deepEqual(signed.savedSecrets, ['password']);
  assert.ok(draftFrom(signed.saved), 'the editor’s draft is accepted back as it is');
  // A file body is edited here too, with its file's name; the file is chosen with VS Code's dialog.
  const file = requestView(
    { ...view, id: 'r', folder: 'Orders', bodyType: 'binary', binaryName: 'export.csv' } as never,
    { hasFile: false },
  );
  assert.equal(file.bodyEditable, true);
  assert.equal(file.saved.bodyType, 'binary');
  assert.equal(file.saved.binaryName, 'export.csv');
  // A form's file fields are rows of the form, with their files' names.
  const form = requestView(
    {
      ...view,
      id: 'r',
      folder: 'Orders',
      bodyType: 'form-data',
      formFields: [
        { key: 'avatar', value: '', enabled: true, kind: 'file', fileName: 'photo.png' },
        { key: 'name', value: 'Ada', enabled: true, kind: 'text' },
      ],
    } as never,
    { hasFile: false },
  );
  assert.deepEqual(form.saved.form, [
    { key: 'avatar', value: '', enabled: true, kind: 'file', fileName: 'photo.png' },
    { key: 'name', value: 'Ada', enabled: true },
  ]);
});

test('a mock server’s routes and settings', () => {
  const shown = mockDetailsView({
    id: 'm',
    name: 'Shop mock',
    port: 4010,
    https: false,
    cors: true,
    corsOrigins: 'http://localhost:5173',
    defaultHeaders: 3,
    source: { kind: 'spec', name: 'Shop API' },
    routes: [
      {
        enabled: true,
        kind: 'http',
        method: 'POST',
        path: '/orders',
        status: 201,
        name: 'Create order',
        delayMs: 0,
        rules: 1,
        responses: 0,
        validates: true,
      },
      {
        enabled: false,
        kind: 'websocket',
        method: 'GET',
        path: '/ticker',
        status: 101,
        name: '',
        delayMs: 300,
        rules: 0,
        responses: 2,
        validates: false,
      },
    ],
  });
  assert.deepEqual(shown.chips, [
    'CORS: http://localhost:5173',
    '3 default headers',
    'From spec Shop API',
  ]);
  assert.deepEqual(shown.routeList, [
    {
      method: 'POST',
      path: '/orders',
      status: '201',
      ok: true,
      note: 'Create order · 1 rule · validates requests',
      details: 'Create order · 1 rule · validates requests',
      enabled: true,
      delayMs: 0,
    },
    {
      method: 'WEBSOCKET',
      path: '/ticker',
      status: '101',
      ok: true,
      note: 'Off · 2 other answers · delay 300 ms',
      // The switch and delay have columns of their own on the page.
      details: '2 other answers',
      enabled: false,
      delayMs: 300,
    },
  ]);
});
