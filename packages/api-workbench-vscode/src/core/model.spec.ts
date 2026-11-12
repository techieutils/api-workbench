import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  badgeOf,
  buildTree,
  requestDescription,
  requestsUnder,
  runArgs,
  sourceKey,
  tagsOf,
  workspaceArgs,
  type ListOutput,
  type ListedRequest,
  type Node,
} from './model';

const request = (
  id: string,
  folder: string,
  extra: Partial<ListedRequest> = {},
): ListedRequest => ({
  id,
  name: id,
  folder,
  method: 'GET',
  protocol: 'http',
  runnable: true,
  ...extra,
});
// As `list --json` gives it: subfolders can come before their collection.
const list: ListOutput = {
  name: 'Shop',
  kind: 'team folder',
  collections: ['Orders/Refunds', 'Orders', 'Users', 'Empty'],
  requests: [
    request('refund', 'Orders/Refunds', { method: 'POST', tags: ['slow'] }),
    request('order', 'Orders', { tags: ['smoke', 'orders'] }),
    request('deep', 'Orders/Refunds/Old'),
    request('users', 'Users', { tags: ['smoke'] }),
    request('socket', 'Users', { protocol: 'websocket', runnable: false }),
  ],
  environments: ['Local'],
};
const shape = (nodes: Node[]): unknown =>
  nodes.map((node) =>
    node.kind === 'request' ? node.request.id : { [node.name]: shape(node.children) },
  );

test('collections, folders, and requests become a tree in the app’s order', () => {
  assert.deepEqual(shape(buildTree(list)), [
    { Orders: [{ Refunds: ['refund', { Old: ['deep'] }] }, 'order'] },
    { Users: ['users', 'socket'] },
    { Empty: [] },
  ]);
  const [orders] = buildTree(list);
  assert.equal(orders.path, 'Orders');
  assert.equal((orders.children[0] as { path: string }).path, 'Orders/Refunds');
});

test('the requests under a folder, its tags, and a request’s description', () => {
  const [orders] = buildTree(list);
  assert.deepEqual(
    requestsUnder(orders).map((r) => r.id),
    ['refund', 'deep', 'order'],
  );
  assert.deepEqual(tagsOf(list), ['orders', 'slow', 'smoke']);
  assert.equal(requestDescription(list.requests[1]), 'GET · #smoke #orders');
  assert.equal(requestDescription(list.requests[4]), 'websocket');
});

test('each request has a badge for its method or protocol, and every badge has its icons', () => {
  assert.equal(badgeOf({ method: 'PATCH', protocol: 'http' }), 'patch');
  assert.equal(badgeOf({ method: 'PROPFIND', protocol: 'http' }), 'other');
  assert.equal(badgeOf({ method: 'GET', protocol: 'grpc' }), 'grpc');
  const media = path.resolve(__dirname, '../../media/methods');
  for (const badge of [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'head',
    'options',
    'other',
    'websocket',
    'sse',
    'ndjson',
    'grpc',
    'socketio',
    'mqtt',
  ])
    for (const theme of ['light', 'dark'])
      assert.ok(existsSync(path.join(media, `${badge}-${theme}.svg`)), `${badge}-${theme}`);
});

test('a source is given to each command as it takes it', () => {
  const team = { kind: 'team', folder: '/repo/api', name: 'Shop' } as const;
  const app = { kind: 'app', id: 'abc', name: 'Personal' } as const;
  assert.deepEqual(workspaceArgs(team), ['--dir', '/repo/api']);
  assert.deepEqual(runArgs(team), ['/repo/api']);
  assert.deepEqual(workspaceArgs(app), ['-w', 'abc']);
  assert.deepEqual(runArgs(app), ['-w', 'abc']);
  assert.notEqual(sourceKey(team), sourceKey(app));
});
