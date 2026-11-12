import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examples, isCalendarDate, run } from './assertions';
import type { HttpResponse } from './types';
const response: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Empty': '',
  },
  body: JSON.stringify({
    id: 1,
    active: true,
    zero: 0,
    empty: '',
    nothing: null,
    items: [{ id: 7 }],
    name: 'Example API',
    count: 3,
    'field.name': 'nested key',
  }),
  time: 80,
  size: 200,
  url: 'https://example.com',
};
const passes = (source: string, res = response) => {
  const results = run(source, res);
  assert.ok(results.length);
  for (const result of results)
    assert.equal(result.pass, true, `${result.label}: ${result.message}`);
};
test('legacy assertions and expanded status, timing, and size checks pass', () => {
  passes(
    'status 200\nresponse-time < 3000\nbody-contains Example\nstatus between 200 299\nstatus in 200, 201, 204\nstatus != 500\nstatus >= 200\nstatus <= 299\nresponse-time == 80\nresponse-size <= 200',
  );
  const failures = run('status 201\nresponse-time < 80\nresponse-size > 200', response);
  assert.ok(failures.every((result) => !result.pass && result.message.includes('Actual')));
});
test('headers use case-insensitive names and media types ignore charset', () => {
  passes(
    'header-exists CONTENT-TYPE\nheader-exists x-empty\nheader-not-exists x-powered-by\nheader content-type contains application/json\nheader cache-control equals "no-store"\ncontent-type APPLICATION/JSON',
  );
  assert.equal(run('header missing equals ""', response)[0].pass, false);
  assert.equal(run('content-type text/html', response)[0].pass, false);
});
test('body checks support negation, exact escaped text, and empty responses', () => {
  passes('body-not-empty\nbody-not-contains failure\nbody-contains "Example API"');
  passes('body-equals "OK\\nready"', { ...response, body: 'OK\nready' });
  passes('body-empty', { ...response, status: 204, body: ' \n\t' });
  assert.equal(run('body-not-empty', { ...response, body: '' })[0].pass, false);
});
test('JSON paths handle arrays, quoted keys, falsy values, and missing properties', () => {
  passes(
    'json-valid\njson-exists $.zero\njson-exists $.empty\njson-exists $.nothing\njson-not-exists $.missing\njson $.items[0].id equals 7\njson $["field.name"] equals "nested key"\njson $.nothing equals null\njson $.active equals true\njson $.count >= 3\njson $.name contains "API"\njson $.id not-equals "1"',
  );
  passes('json $[0].id equals 7', { ...response, body: '[{"id":7}]' });
  assert.equal(
    run('json $.id equals "1"', response)[0].pass,
    false,
    'JSON comparisons do not coerce types',
  );
  assert.equal(
    run('json-exists $.constructor', response)[0].pass,
    false,
    'prototype properties are excluded',
  );
});
test('JSON types, lengths, and structural equality preserve strict types', () => {
  passes(
    'json-type $.items array\njson-type $.id integer\njson-type $.active boolean\njson-type $.nothing null\njson-length $.items == 1\njson-length $.name > 3\njson-length $ > 0',
  );
  passes('json $ equals {"b":2,"a":1}', { ...response, body: '{"a":1,"b":2}' });
  assert.equal(run('json $.id > 0', { ...response, body: '{"id":"1"}' })[0].pass, false);
  assert.equal(run('json-type $.items object', response)[0].pass, false);
});
test('comments and invalid assertions have accurate line diagnostics without executing code', () => {
  const results = run(
    '// comment\n\n# comment\nstatus 200\nunknown-test\njson $.id equals nope\njson-length $.id > 0\nresponse-time < Infinity\nstatus between 299 200\njson-exists $.items[*]',
    response,
  );
  assert.equal(results.length, 7);
  assert.equal(results[0].line, 4);
  assert.equal(results[1].line, 5);
  assert.match(results[1].message, /Unknown assertion/);
  assert.ok(results.slice(1).every((result) => !result.pass && result.message));
  assert.equal(run('globalThis.assertionInjection = true', response)[0].pass, false);
  assert.equal(Object.hasOwn(globalThis, 'assertionInjection'), false);
});
test('invalid JSON fails only JSON checks and never aborts later assertions', () => {
  const results = run('json-valid\njson-not-exists $.error\nstatus 200\nbody-contains invalid', {
    ...response,
    body: 'invalid JSON',
  });
  assert.deepEqual(
    results.map((result) => result.pass),
    [false, false, true, true],
  );
  assert.ok(
    results.slice(0, 2).every((result) => result.message === 'Response body is not valid JSON.'),
  );
});
test('every built-in example uses supported syntax and preserves response data', () => {
  const before = JSON.stringify(response);
  assert.ok(examples.length >= 25);
  for (const example of examples)
    assert.equal(
      run(example.syntax, response)[0].message.includes('Unknown assertion'),
      false,
      example.syntax,
    );
  assert.equal(JSON.stringify(response), before);
});

/** Each assertion's result, as [pass, message], in order. */
const outcomes = (source: string, res = response) =>
  run(source, res).map((result) => [result.pass, result.message] as const);

test('the body supports every text comparison, its length, and patterns', () => {
  passes(
    [
      'body starts-with "{"',
      'body ends-with "}"',
      'body not-equals "OK"',
      'body equals-ignore-case ' + JSON.stringify(response.body.toUpperCase()),
      'body contains-ignore-case "EXAMPLE api"',
      'body not-contains "error"',
      'body matches /"id":\\s*1\\b/',
      'body matches "Example API"',
      'body not-matches /"error"/i',
      'body-length > 10',
      `body-length == ${response.body.length}`,
      'body-length between 1 10000',
    ].join('\n'),
  );
  assert.deepEqual(outcomes('body starts-with "["\nbody-length < 5'), [
    [false, 'Body did not pass "starts-with".'],
    [false, `Actual: ${response.body.length} characters`],
  ]);
  // Global and sticky flags are ignored, so a check gives the same answer every time.
  assert.deepEqual(outcomes('body matches /example/gi\nbody matches /example/gi'), [
    [true, 'Body check passed.'],
    [true, 'Body check passed.'],
  ]);
  assert.match(run('body matches /(/', response)[0].message, /Invalid regular expression/);
  assert.match(run('body matches /a/x', response)[0].message, /flags/);
  assert.match(run('body-length between 9 1', response)[0].message, /minimum must not exceed/);
});
test('headers support every text comparison', () => {
  passes(
    [
      'header content-type starts-with application/',
      'header content-type ends-with "charset=utf-8"',
      'header content-type not-contains xml',
      'header cache-control not-equals "no-cache"',
      'header CACHE-CONTROL equals-ignore-case "NO-STORE"',
      'header content-type contains-ignore-case JSON',
      'header content-type matches /^application\\/json\\b/',
      'header content-type not-matches /xml/',
    ].join('\n'),
  );
  // A missing header fails every comparison, even negative ones.
  assert.deepEqual(outcomes('header x-missing not-contains anything'), [
    [false, 'Header is absent.'],
  ]);
});
test('status lists can exclude codes, and timings and sizes take ranges', () => {
  passes('status not-in 401, 403\nresponse-time between 1 100\nresponse-size between 200 200');
  assert.deepEqual(outcomes('status not-in 200, 204\nresponse-time between 100 200'), [
    [false, 'Actual status: 200'],
    [false, 'Actual: 80 ms'],
  ]);
});
test('JSON values support lists, ranges, text comparisons, and array membership', () => {
  passes(
    [
      'json $.name in ["Other", "Example API"]',
      'json $.count not-in [1, 2]',
      'json $.nothing in [null]',
      'json $.count between 1 3',
      'json $.name starts-with Example',
      'json $.name ends-with "API"',
      'json $.name not-contains Other',
      'json $.name equals-ignore-case "example api"',
      'json $.name contains-ignore-case "EXAMPLE"',
      'json $.name matches /^Example\\s/',
      'json $.name not-matches /^api/i',
      'json $.items contains {"id": 7}',
      'json $.items not-contains {"id": 8}',
      'json-length $.items between 1 5',
    ].join('\n'),
  );
  assert.deepEqual(outcomes('json $.count in [1, "3"]\njson $.count between 4 9'), [
    [false, 'Actual: 3'],
    [false, 'Actual: 3'],
  ]);
  assert.match(run('json $.count starts-with 3', response)[0].message, /requires a JSON string/);
  assert.match(run('json $.count contains 3', response)[0].message, /string or array/);
  assert.match(run('json $.name between 1 2', response)[0].message, /requires a JSON number/);
  assert.match(run('json $.name in "Example API"', response)[0].message, /JSON array/);
});
test('JSON Schema checks the body, or a value in it, and names what is wrong', () => {
  passes(
    [
      'json-schema {"type":"object","required":["id","name"],"properties":{"id":{"type":"integer"}}}',
      'json-schema $.items {"type":"array","items":{"required":["id"]}}',
    ].join('\n'),
  );
  const [result] = run(
    'json-schema {"type":"object","required":["missing"],"properties":{"name":{"type":"number"}}}',
    response,
  );
  assert.equal(result.pass, false);
  assert.match(result.message, /missing/);
  assert.match(result.message, /name/);
  assert.match(run('json-schema $.absent {"type":"object"}', response)[0].message, /missing/);
  assert.match(run('json-schema {not json}', response)[0].message, /JSON Schema object/);
  assert.match(
    run('json-schema {"type":"object"}', { ...response, body: 'not json' })[0].message,
    /not valid JSON/,
  );
});

test('format, list, cookie, timing, and certificate checks', () => {
  const rich: HttpResponse = {
    ...response,
    headers: {
      'content-type': 'application/json',
      'x-request-id': '123e4567-e89b-12d3-a456-426614174000',
    },
    setCookies: [
      { header: 'session=abc123; Path=/; HttpOnly' } as never,
      { header: 'theme=dark' } as never,
    ],
    body: JSON.stringify({
      email: 'ada@example.com',
      site: 'https://example.com/a',
      day: '2026-02-30T10:00:00Z',
      count: '42',
      ratio: 1.5,
      tags: ['admin', 'read', 'write'],
      ids: [1, 2, 2],
      none: [],
      blank: '',
    }),
    timings: {
      totalMs: 120,
      preparationMs: 2,
      requests: [{ phases: [{ id: 'waiting', durationMs: 80 }] }],
    } as never,
    tls: {
      chain: [{ validTo: new Date(Date.now() + 40 * 86_400_000).toUTCString() }],
    } as never,
  };
  const checks: [string, boolean][] = [
    ['header x-request-id is-uuid', true],
    ['header content-type is-uuid', false],
    ['header x-missing is-empty', false],
    ['json $.email is-email', true],
    ['json $.site is-url', true],
    ['json $.day is-date', false],
    ['json $.count is-number', true],
    ['json $.count is-integer', true],
    ['json $.ratio is-integer', false],
    ['json $.none is-empty', true],
    ['json $.blank is-not-empty', false],
    ['json $.tags contains-all ["read", "write"]', true],
    ['json $.tags contains-all ["read", "owner"]', false],
    ['json $.tags contains-any ["owner", "admin"]', true],
    ['json $.email contains-any ["@example.com"]', true],
    ['json $.tags is-unique', true],
    ['json $.ids is-unique', false],
    ['json $.tags is-sorted', true],
    ['json $.ids is-sorted', true],
    ['json $.ids is-sorted-desc', false],
    ['json $.email not-starts-with "bob"', true],
    ['json $.email not-ends-with ".com"', false],
    ['cookie-exists session', true],
    ['cookie-not-exists session', false],
    ['cookie theme equals "dark"', true],
    ['cookie session starts-with "abc"', true],
    ['cookie session is-number', false],
    ['cookie missing equals "x"', false],
    ['timing ttfb < 100', true],
    ['timing total between 100 110', false],
    ['certificate-days-left > 30', true],
    ['certificate-days-left between 0 30', false],
  ];
  for (const [source, expected] of checks)
    assert.equal(run(source, rich)[0].pass, expected, `${source}: ${run(source, rich)[0].message}`);
  // Checks that cannot be answered explain why.
  assert.match(run('json $.email is-sorted', rich)[0].message, /needs a JSON array/);
  assert.match(run('timing ttfb < 1', response)[0].message, /not recorded/);
  assert.match(run('certificate-days-left > 1', response)[0].message, /no TLS certificate/);
});

test('dates must exist on the calendar', () => {
  for (const day of ['2026-02-28', '2024-02-29', '2026-12-31T23:59:59Z', '2026-01-02 10:00'])
    assert.equal(isCalendarDate(day), true, day);
  for (const day of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-04-31',
    '2026-01-02T24:00',
    '20260102',
  ])
    assert.equal(isCalendarDate(day), false, day);
});
