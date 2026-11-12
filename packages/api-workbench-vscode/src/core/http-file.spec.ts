import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpFile } from '@techieutils/api-workbench-common/collection-formats/text-formats';
import {
  bodyFiles,
  createArgs,
  isSpecText,
  parseHttpFile,
  requestAtLine,
  savedBodyPlan,
} from './http-file';
import { parseJson, runCli, type Runtime } from './cli';

const FILE = `@baseUrl = http://localhost:4010
@token = abc

### List orders
GET {{baseUrl}}/orders?limit=10
Authorization: Bearer {{token}}

### Create order
# a comment
POST {{baseUrl}}/orders
Content-Type: application/json

{
  "sku": "TSHIRT-M",
  "quantity": 2
}

###
GET {{baseUrl}}/orders/1 HTTP/1.1

### Not a request, only notes
`;

test('finds each request, its name, and the lines it covers', () => {
  const file = parseHttpFile(FILE);
  assert.deepEqual(file.variables, { baseUrl: 'http://localhost:4010', token: 'abc' });
  assert.deepEqual(
    file.requests.map((r) => [r.id, r.name, r.method, r.url, r.startLine, r.requestLine]),
    [
      ['1', 'List orders', 'GET', '{{baseUrl}}/orders?limit=10', 3, 4],
      ['2', 'Create order', 'POST', '{{baseUrl}}/orders', 7, 9],
      ['3', 'Request 3', 'GET', '{{baseUrl}}/orders/1', 17, 18],
    ],
  );
  assert.deepEqual(file.requests[0].headers, [{ key: 'Authorization', value: 'Bearer {{token}}' }]);
  assert.equal(file.requests[1].body, '{\n  "sku": "TSHIRT-M",\n  "quantity": 2\n}');
  assert.equal(file.problem, undefined);
});

test('reads requests as the command line does', () => {
  const ours = parseHttpFile(FILE).requests;
  const theirs = httpFile(FILE).requests;
  assert.deepEqual(
    ours.map((r) => [r.name, r.method, r.url, r.body]),
    theirs.map((r) => [r.name, r.method, r.url, r.body]),
  );
});

test('the request at the cursor', () => {
  const file = parseHttpFile(FILE);
  assert.equal(requestAtLine(file, 0)?.id, '1');
  assert.equal(requestAtLine(file, 5)?.id, '1');
  assert.equal(requestAtLine(file, 12)?.id, '2');
  assert.equal(requestAtLine(file, 18)?.id, '3');
  // The notes after the last request belong to no request.
  assert.equal(requestAtLine(file, 21), undefined);
});

test('a header line the command line refuses is a problem at its line', () => {
  const file = parseHttpFile('GET https://example.com\nnot a header\n');
  assert.deepEqual(file.problem, { line: 1, message: 'Invalid HTTP header: not a header' });
});

test('saves a request with its variables as written', () => {
  const [, create] = parseHttpFile(FILE).requests;
  assert.deepEqual(createArgs(create, 'Orders'), [
    'Create order',
    '--collection=Orders',
    '--method=POST',
    '--url={{baseUrl}}/orders',
    '--header=Content-Type: application/json',
    '--body={\n  "sku": "TSHIRT-M",\n  "quantity": 2\n}',
  ]);
});

test('tells OpenAPI documents from other YAML and JSON', () => {
  assert.ok(isSpecText('openapi: 3.1.0\ninfo:\n  title: Shop'));
  assert.ok(isSpecText('{\n  "swagger": "2.0"'));
  assert.ok(isSpecText('{"openapi":"3.0.0"}'));
  assert.ok(!isSpecText('name: build\non: push'));
  assert.ok(!isSpecText('{"name": "api-workbench"}'));
});

// The ids CodeLens passes are the ones `request send --file` takes.
const cliPath = path.resolve(__dirname, '../../../api-workbench-cli/dist/api-workbench.cjs');
const runtime: Runtime = {
  command: process.execPath,
  env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  version: process.versions.node,
};
test('its ids are the command line’s', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-http-'));
  try {
    const file = path.join(folder, 'orders.http');
    await writeFile(file, FILE);
    const listed = parseJson<{ id: string; name: string }[]>(
      await runCli(runtime, cliPath, ['request', 'list', '--file', file, '--json']),
    );
    assert.deepEqual(
      listed.map((r) => [r.id, r.name]),
      parseHttpFile(FILE).requests.map((r) => [r.id, r.name]),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a `< ./path` body and a multipart form are files, saved into a collection as such', () => {
  const file = parseHttpFile(
    [
      '### Import',
      'POST {{baseUrl}}/import',
      'Content-Type: text/csv',
      '',
      '< ./data/export.csv',
      '',
      '### Avatar',
      'POST {{baseUrl}}/avatar',
      'Content-Type: multipart/form-data; boundary=B',
      'Accept: application/json',
      '',
      '--B',
      'Content-Disposition: form-data; name="title"',
      '',
      'Me',
      '--B',
      'Content-Disposition: form-data; name="photo"; filename="me.png"',
      '',
      '< ./me.png',
      '--B--',
      '',
      '### Plain',
      'POST {{baseUrl}}/plain',
      '',
      '{"a": 1}',
    ].join('\n'),
  );
  const [csv, avatar, plain] = file.requests;
  assert.deepEqual(bodyFiles(csv), {
    bodyType: 'binary',
    binaryName: 'export.csv',
    form: [],
    files: { binary: './data/export.csv', fields: {} },
  });
  assert.deepEqual(bodyFiles(avatar)?.form, [
    { key: 'title', value: 'Me', enabled: true },
    { key: 'photo', value: '', enabled: true, kind: 'file', fileName: 'me.png' },
  ]);
  assert.deepEqual(bodyFiles(avatar)?.files, { fields: { photo: './me.png' } });
  assert.equal(bodyFiles(plain), undefined);
  // Saved into a collection: the file's name and the form, never the `< ./path` text.
  assert.ok(!createArgs(csv, 'Files').some((arg) => arg.startsWith('--body=')));
  assert.deepEqual(savedBodyPlan(csv), {
    args: ['--body-type=binary', '--binary-name=export.csv'],
  });
  assert.ok(
    !createArgs(avatar, 'Files').some((arg) => /^--header=content-type/i.test(arg)),
    'a multipart boundary is chosen again when it is sent',
  );
  assert.deepEqual(JSON.parse(savedBodyPlan(avatar)!.input!), [
    { key: 'title', value: 'Me', enabled: true, kind: 'text' },
    { key: 'photo', value: '', enabled: true, kind: 'file', fileName: 'me.png' },
  ]);
  assert.equal(savedBodyPlan(plain), undefined);
});

test('a request line with a stray carriage return or line separator is read, not a crash', () => {
  // Found by fuzzing (npm run test:fuzz): the line's pattern did not match across them.
  for (const text of ['GET https://a.test/x\rY', 'POST https://a.test/ x\nA: b\n\n{}']) {
    const [request] = parseHttpFile(text).requests;
    assert.ok(request.url.startsWith('https://a.test/'), JSON.stringify(text));
  }
});
