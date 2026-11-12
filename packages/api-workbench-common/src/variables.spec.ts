import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureAll,
  captureValue,
  decodeJWT,
  dynamicValue,
  dynamicVariables,
  queryJSON,
  readsFailures,
  responseCookies,
} from './variables';
import type { HttpResponse, RequestResponse } from './types';

const response = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status: 201,
  statusText: 'Created',
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  time: 42,
  size: 10,
  url: 'http://localhost',
});

test('every documented dynamic variable produces a value', () => {
  const now = new Date('2026-03-04T05:06:07.890Z');
  for (const { name } of dynamicVariables)
    assert.equal(
      typeof dynamicValue(
        name,
        now,
        () => 0.5,
        () => 'fixed-uuid',
      ),
      'string',
      name,
    );
  assert.equal(dynamicValue('$timestamp', now), '1772600767');
  assert.equal(dynamicValue('$timestampMs', now), String(now.getTime()));
  assert.equal(dynamicValue('$isoDate', now), '2026-03-04');
  assert.equal(
    dynamicValue('$guid', now, Math.random, () => 'fixed-uuid'),
    'fixed-uuid',
  );
  assert.match(dynamicValue('$randomEmail')!, /^[a-z]{8}@example\.com$/);
  assert.match(dynamicValue('$randomIP')!, /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.equal(dynamicValue('$unknown'), undefined);
  assert.equal(dynamicValue('base_url'), undefined);
});

test('captures read JSON paths, headers, status, body, and time', () => {
  const res = response(
    { data: { token: 'abc', user: { id: 7 }, tags: ['a'] } },
    { 'X-Request-Id': 'r-1' },
  );
  assert.equal(captureValue('$.data.token', res), 'abc');
  assert.equal(captureValue('json $.data.user.id', res), '7');
  assert.equal(captureValue('$.data.user', res), '{"id":7}');
  assert.equal(captureValue('$.data.tags[0]', res), 'a');
  assert.equal(captureValue('header x-request-id', res), 'r-1');
  assert.equal(captureValue('status', res), '201');
  assert.equal(captureValue('time', res), '42');
  assert.equal(captureValue('body', res), res.body);
});

test('capture failures are reported per row and disabled or blank rows are skipped', () => {
  const results = captureAll(
    [
      { enabled: true, key: 'token', value: '$.token' },
      { enabled: true, key: 'missing', value: '$.nope' },
      { enabled: true, key: 'header', value: 'header x-absent' },
      { enabled: true, key: 'bad', value: 'whatever' },
      { enabled: false, key: 'off', value: '$.token' },
      { enabled: true, key: '', value: '$.token' },
    ],
    response({ token: 't' }),
  );
  assert.deepEqual(
    results.map((result) => result.variable),
    ['token', 'missing', 'header', 'bad'],
  );
  assert.equal(results[0].value, 't');
  assert.match(results[1].error!, /missing/);
  assert.match(results[2].error!, /not returned/);
  assert.match(results[3].error!, /Use body\.path, \$\.path/);
  assert.match(
    captureAll([{ enabled: true, key: 'x', value: '$.a' }], response('<html>'))[0].error!,
    /not valid JSON/,
  );
});

test('JSON queries support wildcards, negative indices, and quoted keys', () => {
  const data = {
    items: [
      { id: 1, tags: ['x'] },
      { id: 2, tags: ['y', 'z'] },
    ],
    meta: { 'a.b': true, count: 2 },
  };
  assert.deepEqual(queryJSON(data, '$'), data);
  assert.deepEqual(queryJSON(data, '$.items[*].id'), [1, 2]);
  assert.deepEqual(queryJSON(data, '$.items[*].tags[*]'), ['x', 'y', 'z']);
  assert.deepEqual(queryJSON(data, '$.meta.*'), [true, 2]);
  assert.equal(queryJSON(data, '$.items[-1].id'), 2);
  assert.equal(queryJSON(data, '$.meta["a.b"]'), true);
  assert.equal(queryJSON(data, "$.meta['a.b']"), true);
  assert.deepEqual(queryJSON(data, '$.items[*].missing'), []);
  assert.throws(() => queryJSON(data, '$.items[5]'), /No value/);
  assert.throws(() => queryJSON(data, 'items'), /start with \$/);
  // Recursive descent is not supported.
  assert.throws(() => queryJSON(data, '$..id'), /Unexpected/);
});

test('JWT decoding reads claims, expiry, and rejects non-tokens', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'user-ü', exp: 1700000000, iat: 1690000000 })}.sig`;
  const decoded = decodeJWT(`Bearer ${token}`, new Date('2026-01-01T00:00:00Z'))!;
  assert.equal(decoded.header.alg, 'HS256');
  assert.equal(decoded.payload.sub, 'user-ü');
  assert.equal(decoded.expiresAt, '2023-11-14T22:13:20.000Z');
  assert.equal(decoded.issuedAt, new Date(1690000000 * 1000).toISOString());
  assert.equal(decoded.expired, true);
  assert.equal(
    decodeJWT(`${encode({ alg: 'none' })}.${encode({ sub: 'a' })}.`)!.expired,
    undefined,
  );
  assert.equal(decodeJWT('not-a-token'), undefined);
  assert.equal(decodeJWT('a.b.c'), undefined);
  assert.equal(decodeJWT(''), undefined);
});

test('JSON path filters keep the items that pass them', () => {
  const data = {
    users: [
      { id: 1, role: 'admin', email: 'a@example.com', age: 40, active: true },
      { id: 2, role: 'user', email: 'b@other.org', age: 25, active: false },
      { id: 3, role: 'admin', email: 'c@EXAMPLE.com', age: 31 },
    ],
    flags: { a: 1, b: 5 },
  };
  assert.deepEqual(queryJSON(data, '$.users[?(@.role == "admin")].id'), [1, 3]);
  assert.deepEqual(queryJSON(data, "$.users[?(@.role != 'admin')].id"), [2]);
  assert.deepEqual(queryJSON(data, '$.users[?(@.age >= 31)].id'), [1, 3]);
  assert.deepEqual(queryJSON(data, '$.users[?(@.email =~ /@example\\.com$/i)].id'), [1, 3]);
  assert.deepEqual(queryJSON(data, '$.users[?(@.active)].id'), [1]);
  // Object values are filtered too, and a filter with no match gives an empty list.
  assert.deepEqual(queryJSON(data, '$.flags[?(@ > 2)]'), [5]);
  assert.deepEqual(queryJSON(data, '$.users[?(@.role == "owner")].id'), []);
  // A ) or ] inside quoted text does not end the filter.
  assert.deepEqual(
    queryJSON({ items: [{ name: 'a)]b' }, { name: 'c' }] }, '$.items[?(@.name == "a)]b")].name'),
    ['a)]b'],
  );
  assert.throws(() => queryJSON(data, '$.users[?(@.role == admin)]'), /Quote text/);
  assert.throws(() => queryJSON(data, '$.users[?(@.role == "admin"]'), /Close the filter/);
  assert.throws(() => queryJSON(data, '$.users[?(role)]'), /Use a filter/);
});

test('captures read more of the body: patterns, markers, forms, and every match', () => {
  const json = response(
    JSON.stringify({
      items: [
        { id: 'a1', name: 'First', role: 'admin' },
        { id: 'b2', name: 'Second', role: 'user' },
      ],
      next: 'https://api.example.com/items?cursor=Q1%3D%3D&limit=2',
    }),
  );
  assert.equal(captureValue('$.items[*].id', json), '["a1","b2"]');
  assert.equal(captureValue('$.items[-1].id', json), 'b2');
  assert.equal(captureValue('$.items[?(@.role == "admin")].name | first', json), 'First');
  assert.equal(captureValue('$.items[*].id | last', json), 'b2');
  assert.equal(captureValue('$.items[*].id | join ", "', json), 'a1, b2');
  assert.equal(captureValue('$.items | length', json), '2');
  assert.equal(captureValue('$.next | regex /cursor=([^&]+)/ | url-decode', json), 'Q1==');
  assert.equal(captureValue('$.next | between "page=" "&" | default "none"', json), 'none');

  const html = response('<form><input name="csrf" value="tok-123"></form><title>Sign in</title>');
  assert.equal(captureValue('regex /name="csrf" value="([^"]+)"/', html), 'tok-123');
  assert.equal(captureValue('regex /(?<word>Sign) in/ word', html), 'Sign');
  assert.equal(captureValue('regex /<title>(.*)<\\/title>/ 0', html), '<title>Sign in</title>');
  assert.equal(captureValue('between "<title>" "</title>" | upper', html), 'SIGN IN');
  // A | inside a pattern means "or", not a new step.
  assert.equal(captureValue('regex /(Sign|Log) in/', html), 'Sign');

  const form = response('access_token=abc%20def&token_type=bearer&expires_in=3600');
  assert.equal(captureValue('form access_token', form), 'abc def');
  assert.equal(captureValue('form "expires_in"', form), '3600');
  assert.equal(captureValue('size', form), String(form.size));
});

test('capture transforms decode tokens and values, and default replaces failures', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'HS256' })}.${encode({ sub: 'user-7', roles: ['a', 'b'] })}.sig`;
  const res = response(
    JSON.stringify({
      token,
      encoded: Buffer.from('hello wörld').toString('base64'),
      nested: '{"x":1}',
    }),
  );
  assert.equal(captureValue('$.token | jwt $.sub', res), 'user-7');
  assert.equal(captureValue('$.token | jwt $.roles | last', res), 'b');
  assert.equal(captureValue('$.encoded | base64-decode', res), 'hello wörld');
  assert.equal(captureValue('$.nested | json $.x', res), '1');
  assert.equal(captureValue('$.missing | default "fallback"', res), 'fallback');
  assert.equal(captureValue('$.missing | upper | default', res), '');
  // Steps after a default run on its value; a default after a success changes nothing.
  assert.equal(captureValue('$.missing | default "x" | upper', res), 'X');
  assert.equal(captureValue('$.token | jwt $.sub | default "no"', res), 'user-7');

  assert.throws(() => captureValue('$.token | first', res), /needs a list/);
  assert.throws(() => captureValue('$.encoded | jwt', res), /not a JWT/);
  assert.throws(() => captureValue('$.token | shuffle', res), /Unknown transform/);
  assert.throws(() => captureValue('body | regex /nope/', res), /No match/);
  assert.throws(() => captureValue('body | regex /(a/', res), /Invalid regular expression/);
  assert.throws(() => captureValue('between "<x>" | trim', res), /both markers quoted/);
  assert.throws(() => captureValue('$.token |  | trim', res), /needs a source or transform/);
  assert.throws(() => captureValue('xpath //title', res), /Use body\.path, \$\.path, header\.name/);
});

test('captures read cookies the response set, the last one winning', () => {
  const res: HttpResponse = {
    ...response('{}'),
    headers: { 'set-cookie': 'ignored=1' },
    setCookies: [
      { url: 'https://a.example/login', header: 'session=first; Path=/' },
      { url: 'https://a.example/home', header: 'session=second%3D; Path=/; HttpOnly' },
      { url: 'https://a.example/home', header: 'csrf="q w"; Secure' },
    ],
  };
  assert.equal(captureValue('cookie session', res), 'second%3D');
  assert.equal(captureValue('cookie session | url-decode', res), 'second=');
  assert.equal(captureValue('cookie "csrf"', res), '"q w"');
  assert.throws(() => captureValue('cookie ignored', res), /Cookie "ignored" was not set/);
  // Without separate headers, the combined one is split at each new cookie, not at date commas.
  const combined: HttpResponse = {
    ...response('{}'),
    headers: {
      'Set-Cookie': 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/, a=3',
    },
  };
  assert.deepEqual(responseCookies(combined), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
    { name: 'a', value: '3' },
  ]);
  assert.equal(captureValue('cookie a', combined), '3');
});

test('captures read network timing: totals, phases, and a hop of a redirect chain', () => {
  const phase = (id: string, durationMs: number) => ({ id, label: id, startMs: 0, durationMs });
  const res: HttpResponse = {
    ...response('{}'),
    timings: {
      startedAt: '2026-01-01T00:00:00.000Z',
      totalMs: 123.456,
      preparationMs: 1.5,
      requests: [
        {
          method: 'GET',
          url: 'http://a.test/old',
          status: 301,
          startMs: 0,
          durationMs: 40,
          connectionReused: false,
          phases: [phase('dns', 4.25), phase('tcp', 9), phase('waiting', 20)],
        },
        {
          method: 'GET',
          url: 'http://a.test/new',
          status: 200,
          startMs: 40,
          durationMs: 80,
          connectionReused: true,
          phases: [phase('waiting', 31.126), phase('download', 2)],
        },
      ],
    } as HttpResponse['timings'],
  };
  assert.equal(captureValue('timing total', res), '123.46');
  assert.equal(captureValue('timing preparation', res), '1.5');
  assert.equal(captureValue('timing ttfb', res), '31.13');
  assert.equal(captureValue('timing download', res), '2');
  assert.equal(captureValue('timing dns 1', res), '4.25');
  assert.equal(captureValue('timing connect 1', res), '9');
  assert.throws(() => captureValue('timing dns', res), /reused a connection/);
  assert.throws(() => captureValue('timing tcp 3', res), /2 request\(s\), not 3/);
  assert.throws(() => captureValue('timing latency', res), /Unknown timing "latency"/);
  assert.throws(() => captureValue('timing total', response('{}')), /was not recorded/);
});

test('captures read the TLS connection and its certificate chain', () => {
  const certificate = (cn: string, validTo: string) => ({
    subject: `C=US\nO=Example\nCN=${cn}`,
    issuer: 'CN=Example CA',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo,
    serialNumber: '0A1B',
    subjectAltName: `DNS:${cn}`,
    fingerprint: 'AA:BB',
    fingerprint256: 'CC:DD',
    fingerprint512: 'EE:FF',
    publicKeyType: 'rsa',
    keyBits: 2048,
    ca: false,
    pem: '-----BEGIN CERTIFICATE-----',
  });
  const validTo = new Date(Date.now() + 10.5 * 86_400_000).toISOString();
  const res: HttpResponse = {
    ...response('{}'),
    tls: {
      host: 'api.example.com',
      port: 443,
      capturedAt: '2026-01-01T00:00:00.000Z',
      authorized: true,
      protocol: 'TLSv1.3',
      cipher: { name: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' },
      alpnProtocol: 'h2',
      chain: [certificate('api.example.com', validTo), certificate('Example CA', validTo)],
    },
  };
  assert.equal(captureValue('certificate host', res), 'api.example.com');
  assert.equal(captureValue('certificate port', res), '443');
  assert.equal(captureValue('certificate protocol', res), 'TLSv1.3');
  assert.equal(captureValue('certificate cipher', res), 'TLS_AES_128_GCM_SHA256');
  assert.equal(captureValue('certificate alpn', res), 'h2');
  assert.equal(captureValue('certificate authorized', res), 'true');
  assert.equal(captureValue('certificate cn', res), 'api.example.com');
  assert.equal(captureValue('certificate cn 2', res), 'Example CA');
  assert.equal(captureValue('certificate valid-to', res), validTo);
  assert.equal(captureValue('certificate days-left', res), '10');
  assert.equal(captureValue('certificate sha256', res), 'CC:DD');
  assert.equal(captureValue('certificate public-key', res), 'RSA 2048');
  assert.equal(captureValue('certificate san | regex /DNS:(.+)/', res), 'api.example.com');
  assert.throws(() => captureValue('certificate issuer 3', res), /2 certificate\(s\), not 3/);
  assert.throws(() => captureValue('certificate owner', res), /Unknown certificate field/);
  assert.throws(() => captureValue('certificate host', response('{}')), /no TLS certificate/);
});

test('captures read a failed request: its error, timing, and certificate', () => {
  const failed: RequestResponse = {
    error: 'Request timed out after 2000 ms',
    timings: {
      startedAt: '2026-01-01T00:00:00.000Z',
      totalMs: 2000,
      preparationMs: 0,
      requests: [
        {
          method: 'GET',
          url: 'https://a.test/',
          startMs: 0,
          durationMs: 2000,
          connectionReused: false,
          phases: [{ id: 'dns', label: 'DNS', startMs: 0, durationMs: 12 }],
        },
      ],
    },
  };
  assert.equal(captureValue('error', failed), 'Request timed out after 2000 ms');
  assert.equal(captureValue('error | regex /after (\\d+) ms/', failed), '2000');
  assert.equal(captureValue('timing total', failed), '2000');
  assert.equal(captureValue('timing dns', failed), '12');
  assert.throws(() => captureValue('certificate host', failed), /no TLS certificate/);
  assert.throws(() => captureValue('$.id', failed), /request failed, so there is no response/);
  assert.equal(captureValue('$.id | default "none"', failed), 'none');
  assert.throws(() => captureValue('error', response('{}')), /did not fail/);
  assert.equal(captureValue('error | default "ok"', response('{}')), 'ok');
  // Only captures that read a failure run when a request fails.
  assert.deepEqual(
    ['error', 'error | upper', 'timing total', 'certificate cn', '$.id', 'status', 'header x'].map(
      readsFailures,
    ),
    [true, true, true, true, false, false, false],
  );
  assert.deepEqual(
    captureAll(
      [
        { enabled: true, key: 'reason', value: 'error' },
        { enabled: true, key: 'id', value: '$.id' },
      ],
      failed,
    ).map((result) => [result.variable, result.value ?? result.error]),
    [
      ['reason', 'Request timed out after 2000 ms'],
      [
        'id',
        'The request failed, so there is no response to read: use error, timing, or certificate.',
      ],
    ],
  );
});

test('HTML captures need a browser to parse the body', () => {
  // The renderer has DOMParser; the UI smoke tests read HTML there. Node has none.
  assert.throws(
    () => captureValue('html input[name="csrf"] @value', response('<input name="csrf">')),
    /HTML captures run in the app/,
  );
  // An HTML source on a failed request reads nothing, like other response sources.
  assert.throws(() => captureValue('html title', { error: 'x' }), /request failed/);
});

test('list, text, number, encoding, and time transforms', () => {
  const response = {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: 3, price: 2.5 },
        { id: 1, price: 4 },
        { id: 3, price: 1 },
      ],
      name: '  Ada Lovelace ',
      user: { a: 1, b: 2 },
      created: 1700000000,
      day: '2026-01-02',
      tags: ['b', 'a'],
      empty: '',
    }),
    time: 1,
    size: 1,
    url: 'https://example.com',
  };
  const cases: [string, string][] = [
    ['$.items[*].id | unique', '[3,1]'],
    ['$.items[*].id | sort', '[1,3,3]'],
    ['$.items[*].id | sort desc', '[3,3,1]'],
    ['$.tags | reverse | join ""', 'ab'],
    ['$.items[*].id | at -1', '3'],
    ['$.items[*].id | slice 1', '[1,3]'],
    ['$.user | keys | join "+"', 'a+b'],
    ['$.user | values | sum', '3'],
    ['$.items[*].price | sum', '7.5'],
    ['$.items[*].price | min', '1'],
    ['$.items[*].price | max', '4'],
    ['$.items[*].price | avg', '2.5'],
    ['$.items[*].price | avg | multiply 3 | divide 4 | round 3', '1.875'],
    ['$.items[*].id | first | add 2 | subtract 1', '4'],
    ['$.name | trim | split " " | last', 'Lovelace'],
    ['$.name | trim | slice 0 3', 'Ada'],
    ['$.name | trim | replace "Ada" "Grace"', 'Grace Lovelace'],
    ['$.name | trim | prefix "Hi " | suffix "!"', 'Hi Ada Lovelace!'],
    ['$.name | trim | base64-encode', 'QWRhIExvdmVsYWNl'],
    ['$.name | trim | url-encode', 'Ada%20Lovelace'],
    ['$.created | date', '2023-11-14T22:13:20.000Z'],
    ['$.day | epoch', '1767312000'],
    ['$.created | epoch-ms', '1700000000000'],
    ['$.empty | if-empty "none"', 'none'],
    ['$.tags | if-empty "none"', '["b","a"]'],
  ];
  for (const [source, expected] of cases)
    assert.equal(captureValue(source, response), expected, source);
  // Mistakes say what the transform needs, and default can stand in for them.
  for (const [source, message] of [
    ['$.name | sum', /needs a list/],
    ['$.tags | add 1', /needs a number/],
    ['$.created | divide 0', /divide by zero/],
    ['$.name | replace "x"', /replace "from" "to"/],
    ['$.tags | at 5', /no item 5/],
    ['$.name | keys', /needs an object/],
    ['$.name | date', /needs a date/],
  ] as const)
    assert.throws(() => captureValue(source, response), message, source);
  assert.equal(captureValue('$.created | divide 0 | default "n/a"', response), 'n/a');
});
