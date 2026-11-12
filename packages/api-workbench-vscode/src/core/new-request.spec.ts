import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_PROTOCOLS } from '@techieutils/api-workbench-common/types';
import {
  REQUEST_TYPES,
  folderChoices,
  newRequestArgs,
  newRequestFrom,
  urlHint,
  type NewRequestTarget,
} from './new-request';

const targets: NewRequestTarget[] = [
  { key: 'team:/repo/api', label: 'Shop', kind: 'team', folders: ['Orders', 'Orders/Admin'] },
];
const form = {
  workspace: 'team:/repo/api',
  protocol: 'http',
  folder: ' Orders / Admin ',
  name: ' List orders ',
  method: 'post',
  url: '{{baseUrl}}/orders',
  tags: '#smoke, orders smoke',
};

test('every request protocol the app has can be chosen, each described', () => {
  assert.deepEqual(
    REQUEST_TYPES.map((type) => type.protocol).filter((protocol) => protocol !== 'graphql'),
    [...REQUEST_PROTOCOLS],
  );
  for (const type of REQUEST_TYPES)
    assert.ok(type.summary && type.useFor && type.inVsCode && type.placeholder, type.protocol);
});

test('the form is checked, then made into request create arguments', () => {
  const input = newRequestFrom(form, targets);
  assert.deepEqual(input, {
    workspace: 'team:/repo/api',
    protocol: 'http',
    folder: 'Orders/Admin',
    name: 'List orders',
    method: 'POST',
    url: '{{baseUrl}}/orders',
    tags: ['smoke', 'orders'],
  });
  assert.deepEqual(newRequestArgs(input as never), [
    'List orders',
    '--collection=Orders/Admin',
    '--url={{baseUrl}}/orders',
    '--protocol=http',
    '--method=POST',
    '--tag=smoke',
    '--tag=orders',
  ]);
  // A live request has no method; a name starting with a dash is never read as an option.
  const live = newRequestFrom({ ...form, protocol: 'mqtt', name: '--help', tags: '' }, targets);
  assert.deepEqual(newRequestArgs(live as never), [
    'help',
    '--collection=Orders/Admin',
    '--url={{baseUrl}}/orders',
    '--protocol=mqtt',
  ]);
  for (const [change, reason] of [
    [{ workspace: 'app:other' }, /workspace/],
    [{ protocol: 'ftp' }, /kind/],
    [{ folder: 'Orders//Admin' }, /empty parts/],
    [{ folder: '' }, /collection/],
    [{ name: '' }, /name/],
    [{ method: 'BREW' }, /method/],
    [{ url: '' }, /URL/],
    [{ url: 'https://a\nb' }, /one line/],
    [{ tags: 'a/b' }, /not a tag/],
  ] as const)
    assert.match(String(newRequestFrom({ ...form, ...change }, targets)), reason);
  assert.match(String(newRequestFrom(null, targets)), /could not be read/);
});

test('a GraphQL request is a POST with a JSON body of its query, as the app keeps it', () => {
  const input = newRequestFrom(
    { ...form, protocol: 'graphql', method: 'GET', url: 'https://api.example.com/graphql' },
    targets,
  );
  const args = newRequestArgs(input as never);
  assert.ok(args.includes('--protocol=http'));
  assert.ok(args.includes('--method=POST'));
  assert.ok(args.includes('--header=Content-Type: application/json'));
  const body = args.find((arg) => arg.startsWith('--body='))!.slice('--body='.length);
  assert.deepEqual(Object.keys(JSON.parse(body)), ['query', 'variables']);
});

test('a URL that does not suit the kind of request gets a hint', () => {
  assert.equal(urlHint('http', 'https://api.example.com'), undefined);
  assert.equal(urlHint('http', '{{baseUrl}}/orders'), undefined, 'a variable may hold the scheme');
  assert.match(urlHint('http', 'api.example.com')!, /http:\/\/ or https:\/\//);
  assert.match(urlHint('websocket', 'https://example.com')!, /ws:\/\/ or wss:\/\/, not https/);
  assert.equal(urlHint('mqtt', 'mqtts://broker:8883'), undefined);
  assert.equal(urlHint('grpc', 'localhost:50051'), undefined);
  assert.match(urlHint('grpc', 'https://api.example.com:443')!, /host:port/);
  assert.match(urlHint('grpc', 'localhost')!, /port/);
  assert.equal(urlHint('http', ''), undefined);
});

test('folders are offered collections first, each folder after its collection', () => {
  assert.deepEqual(folderChoices(['Users', 'Orders'], ['Orders/Admin/Audit', 'Users', 'Orders']), [
    'Users',
    'Orders',
    'Orders/Admin',
    'Orders/Admin/Audit',
  ]);
});
