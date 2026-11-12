import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ListedRequest } from './model';
import type { SendResult } from './report';
import {
  BODY_LIMIT,
  CREDENTIALS_OFF_HINT,
  VAULT_LOCKED_HINT,
  credentialNote,
  field,
  pick,
  requestsText,
  runText,
  sendText,
} from './tools';

test('a tool’s input fields are checked like any untrusted input', () => {
  assert.equal(field({ request: '  List users ' }, 'request'), 'List users');
  assert.equal(field({}, 'workspace'), undefined);
  assert.throws(() => field({}, 'request', { required: true }), /Give “request”/);
  assert.throws(() => field({ request: 7 }, 'request'), /must be text/);
  assert.throws(() => field({ request: 'a\nb' }, 'request'), /not valid/);
  assert.throws(() => field({ request: 'x'.repeat(501) }, 'request'), /not valid/);
  assert.equal(field(null, 'request'), undefined);
});

test('an item is picked by id, name, or name in any case, and a miss lists what there is', () => {
  const items = [
    { id: 'a1', name: 'List users' },
    { id: 'b2', name: 'Create user' },
  ];
  const options = {
    what: 'request',
    id: (item: { id: string }) => item.id,
    name: (item: { name: string }) => item.name,
  };
  assert.equal(pick(items, 'b2', options).name, 'Create user');
  assert.equal(pick(items, 'list USERS', options).id, 'a1');
  assert.throws(
    () => pick(items, 'Nope', options),
    /No request “Nope”\. Requests: List users, Create user\./,
  );
  assert.throws(() => pick(items, undefined, options), /Say which request/);
  assert.equal(pick([items[0]], undefined, options).id, 'a1', 'the only one needs no name');
});

const request = (extra: Partial<ListedRequest>): ListedRequest => ({
  id: 'list',
  name: 'List users',
  folder: 'Users',
  method: 'GET',
  protocol: 'http',
  runnable: true,
  ...extra,
});

test('requests are listed for a model with what to call them by', () => {
  assert.equal(
    requestsText('Shop', 'Local', [
      request({ tags: ['smoke'] }),
      request({ id: 'ws', name: 'Ticker', protocol: 'websocket', runnable: false }),
    ]),
    [
      'Workspace “Shop”, environment “Local”: 2 requests.',
      '- GET Users/List users (id list) #smoke',
      '- websocket Users/Ticker (id ws) — a live connection, opened by the person in its editor',
    ].join('\n'),
  );
});

const sent = (extra: Partial<SendResult>): SendResult => ({
  request: { id: 'list', name: 'List users', method: 'GET', folder: 'Users' },
  url: 'http://127.0.0.1/users',
  status: 200,
  statusText: 'OK',
  durationMs: 10,
  size: 20,
  tests: [{ label: 'status 200', pass: true, message: '' }],
  captures: [],
  passed: true,
  headers: { authorization: '<hidden>', 'content-type': 'application/json' },
  body: '{"ok":true}',
  ...extra,
});

test('a send is described with its hidden headers kept hidden and a long body cut', () => {
  const short = sendText(sent({}));
  assert.match(short, /Result: 200 OK · 10 ms · 20 B/);
  assert.match(short, /Test passed: status 200/);
  assert.match(short, /authorization: <hidden>/);
  assert.match(short, /Body:\n\{"ok":true\}$/);
  const long = sendText(sent({ body: 'x'.repeat(BODY_LIMIT + 2048), passed: false }));
  assert.match(long, /\(did not pass\)/);
  assert.match(long, /… \(2\.0 KB more not shown\)$/);
  assert.ok(long.length < BODY_LIMIT + 1000);
});

test('a run is summed up with each failure', () => {
  const text = runText({
    passed: false,
    summary: { requests: 2, failed: 1, skipped: 0, tests: 2, testsFailed: 1, elapsedMs: 31.6 },
    results: [
      sent({}),
      sent({
        request: { id: 'miss', name: 'Missing', method: 'GET', folder: 'Users' },
        status: 404,
        statusText: 'Not Found',
        passed: false,
        tests: [{ label: 'status 200', pass: false, message: 'was 404' }],
      }),
    ],
  });
  assert.equal(
    text,
    [
      'Failed: 2 requests, 1 failed, 1/2 tests passed, 32 ms.',
      '- Users/Missing: 404 Not Found · 10 ms · 20 B',
      '  failed: status 200 — was 404',
    ].join('\n'),
  );
});

test('saved credentials are explained before a send, and a locked vault tells the model to ask', () => {
  assert.match(
    credentialNote('unlocked'),
    /applied from your unlocked vault; their secrets are never given to the model/,
  );
  assert.match(credentialNote('locked'), /vault is locked/);
  assert.match(credentialNote('off'), /kept away from tools by your settings/);
  const locked = sendText(
    sent({
      status: undefined,
      error: 'The vault is locked. Set API_WORKBENCH_VAULT_PASSWORD…',
      passed: false,
    }),
  );
  assert.ok(locked.includes(VAULT_LOCKED_HINT));
  assert.match(VAULT_LOCKED_HINT, /Never ask for the vault password/);
  assert.ok(!sendText(sent({})).includes(VAULT_LOCKED_HINT));
  const run = runText({
    passed: false,
    summary: { requests: 1, failed: 1, skipped: 0, tests: 0, testsFailed: 0, elapsedMs: 3 },
    results: [sent({ status: undefined, error: 'The vault is locked.', passed: false })],
  });
  assert.equal(run.split(VAULT_LOCKED_HINT).length, 2, 'said once for the run');
});

test('with credentials kept from tools, the model is not told to ask for the vault to be unlocked', () => {
  const error = 'The vault is locked. Set API_WORKBENCH_VAULT_PASSWORD…';
  const text = sendText(sent({ status: undefined, error, passed: false }), 'off');
  assert.ok(text.includes(CREDENTIALS_OFF_HINT));
  assert.ok(!text.includes(VAULT_LOCKED_HINT));
  assert.match(CREDENTIALS_OFF_HINT, /never ask for a password, token, or credential/);
  const run = runText(
    {
      passed: false,
      summary: { requests: 2, failed: 2, skipped: 0, tests: 0, testsFailed: 0, elapsedMs: 3 },
      results: [
        sent({ status: undefined, error, passed: false }),
        sent({ status: undefined, error, passed: false }),
      ],
    },
    'off',
  );
  assert.equal(run.split(CREDENTIALS_OFF_HINT).length, 2, 'said once for the run');
  assert.ok(!run.includes(VAULT_LOCKED_HINT));
});
