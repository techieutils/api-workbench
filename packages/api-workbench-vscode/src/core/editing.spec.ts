import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN,
  draftFrom,
  paramsOf,
  percentile,
  performanceRows,
  responseCookies,
  runnerArgs,
  runnerOptionsFrom,
  runnerResults,
  timeline,
  updateArgs,
  updatePlan,
  rowsFromText,
  rowsToText,
  urlTokens,
  SECRET_VARIABLE,
  EDITABLE_AUTH,
  FIELDS_VARIABLE,
  withParams,
  type LoadReport,
  type RequestDraft,
} from './editing';
import { AUTH_FORMS, JWT_ALGORITHMS } from './auth';
import type { SendResult } from './report';

const saved: RequestDraft = {
  method: 'GET',
  url: '{{base}}/users?page=1',
  headers: [
    { key: 'Authorization', value: HIDDEN, enabled: true },
    { key: 'Accept', value: 'application/json', enabled: true },
  ],
  body: '',
  tests: 'status 200',
  tags: ['smoke'],
  captures: [{ key: 'userId', value: 'body.id' }],
  bodyType: 'none',
  form: [],
  auth: {
    type: 'Bearer token',
    username: '',
    secret: '',
    apiKeyIn: 'header',
    credentialId: '',
    options: {},
    secrets: {},
  },
};

test('auth and a form are saved with their secrets kept off the arguments', () => {
  const draft = structuredClone(saved);
  draft.auth = { ...draft.auth, type: 'Basic auth', username: 'ada', secret: 'pw-123' };
  draft.bodyType = 'x-www-form-urlencoded';
  draft.form = [{ key: 'password', value: 'hunter2', enabled: true }];
  const plan = updatePlan(saved, draft);
  assert.deepEqual(plan.args, [
    '--body-type=x-www-form-urlencoded',
    '--form-fields=-',
    '--auth=basic',
    '--auth-username=ada',
    `--auth-secret-from-env=${SECRET_VARIABLE}`,
  ]);
  assert.ok(!plan.args.join(' ').includes('pw-123'), 'the password is no argument');
  assert.ok(!plan.args.join(' ').includes('hunter2'), 'nor is a form value');
  assert.deepEqual(plan.env, { [SECRET_VARIABLE]: 'pw-123' });
  assert.deepEqual(
    JSON.parse(plan.input!),
    draft.form.map((row) => ({ ...row, kind: 'text' })),
  );
  // A type with a form takes its secrets by field, never the single `secret`; unchanged, nothing.
  const other = structuredClone(saved);
  other.auth.type = 'AWS Signature';
  other.auth.secret = 'ignored';
  assert.deepEqual(updatePlan(other, structuredClone(other)), { args: [] });
  assert.equal(draftFrom({ ...saved, auth: { ...saved.auth, secret: 'a\nb' } }), undefined);
  assert.equal(draftFrom({ ...saved, auth: { ...saved.auth, credentialId: '../x' } }), undefined);
  assert.equal(draftFrom({ ...saved, bodyType: 'graphql' }), undefined);
});

test('a file body and a form’s file fields are saved by their file names, never their paths', () => {
  const draft = structuredClone(saved);
  draft.method = 'POST';
  draft.bodyType = 'binary';
  draft.binaryName = 'export.csv';
  assert.deepEqual(updatePlan(saved, draft).args, [
    '--method=POST',
    '--body-type=binary',
    '--binary-name=export.csv',
  ]);
  const form = structuredClone(saved);
  form.bodyType = 'form-data';
  form.form = [
    { key: 'name', value: 'Ada', enabled: true },
    { key: 'avatar', value: '', enabled: true, kind: 'file', fileName: 'photo.png' },
  ];
  const plan = updatePlan(saved, form);
  assert.deepEqual(JSON.parse(plan.input!), [
    { key: 'name', value: 'Ada', enabled: true, kind: 'text' },
    { key: 'avatar', value: '', enabled: true, kind: 'file', fileName: 'photo.png' },
  ]);
  // From the page: a file field keeps only its name; a path, or an unknown kind, is refused.
  assert.deepEqual(draftFrom(form)?.form, form.form);
  assert.equal(
    draftFrom({ ...form, form: [{ ...form.form[1], fileName: '../etc/passwd' }] }),
    undefined,
  );
  assert.equal(
    draftFrom({ ...form, form: [{ key: 'x', value: '', enabled: true, kind: 'dir' }] }),
    undefined,
  );
  assert.equal(draftFrom({ ...draft, binaryName: 'C:\\files\\a.csv' }), undefined);
  assert.equal(draftFrom(draft)?.binaryName, 'export.csv');
});

test('every other auth type saves its settings and secrets as JSON in the environment', () => {
  const draft = structuredClone(saved);
  draft.auth = {
    ...draft.auth,
    type: 'AWS Signature',
    username: 'AKIDEXAMPLE',
    options: { awsRegion: 'eu-west-1', awsService: 'execute-api' },
    secrets: { password: 'aws-secret-7', awsSessionToken: 'session-5' },
  };
  const plan = updatePlan(saved, draft);
  assert.deepEqual(plan.args, [
    '--auth=aws',
    '--auth-username=AKIDEXAMPLE',
    `--auth-fields-from-env=${FIELDS_VARIABLE}`,
  ]);
  assert.doesNotMatch(plan.args.join(' '), /aws-secret-7|session-5/);
  assert.deepEqual(JSON.parse(plan.env![FIELDS_VARIABLE]), {
    password: 'aws-secret-7',
    options: { awsSessionToken: 'session-5', awsRegion: 'eu-west-1', awsService: 'execute-api' },
  });
  // A setting emptied is removed; one unchanged is not sent again.
  const before = structuredClone(draft);
  before.auth.secrets = {};
  const after = structuredClone(before);
  after.auth.options = { awsRegion: '', awsService: 'execute-api' };
  assert.deepEqual(JSON.parse(updatePlan(before, after).env![FIELDS_VARIABLE]), {
    options: { awsRegion: null },
  });
  // Only the fields the forms name, with the values they take, come from a webview.
  const posted = (auth: object) => draftFrom({ ...saved, auth: { ...saved.auth, ...auth } });
  assert.deepEqual(
    posted({ type: 'JWT bearer', options: { jwtAlgorithm: 'RS256', jwtSecretBase64: true } })?.auth
      .options,
    { jwtAlgorithm: 'RS256', jwtSecretBase64: true },
  );
  assert.equal(posted({ options: { jwtAlgorithm: 'none' } }), undefined);
  assert.equal(posted({ options: { jwtSecretBase64: 'yes' } }), undefined);
  assert.equal(posted({ options: { oauth2RefreshToken: 'x' } }), undefined);
  assert.equal(posted({ options: { constructor: 'x' } }), undefined);
  assert.equal(posted({ options: { awsRegion: 'a\nb' } }), undefined);
  assert.equal(posted({ secrets: { awsRegion: 'x' } }), undefined, 'not a secret field');
  assert.equal(posted({ secrets: { oauth2RefreshToken: 'x' } }), undefined);
  assert.deepEqual(posted({ secrets: { oauth2ClientSecret: '', token: 't' } })?.auth.secrets, {
    token: 't',
  });
});

test('every auth type the app has can be set, with forms matching common’s algorithms', async () => {
  const { AUTH_TYPES } = await import('@techieutils/api-workbench-common/types');
  const { JWT_ALGORITHMS: common } = await import('@techieutils/api-workbench-common/auth-signing');
  assert.deepEqual(Object.keys(EDITABLE_AUTH).sort(), [...AUTH_TYPES].sort());
  assert.deepEqual(JWT_ALGORITHMS, [...common]);
  // Every type with a form names only settings `request update --auth-fields-from-env` takes.
  for (const [type, fields] of Object.entries(AUTH_FORMS)) {
    assert.ok(EDITABLE_AUTH[type], type);
    for (const field of fields)
      if (field.when) assert.ok(fields.some((other) => other.key === field.when!.key));
  }
});

test('a header switched off or on is kept, and saved as such', () => {
  const before = structuredClone(saved);
  before.headers = [
    { key: 'Authorization', value: HIDDEN, enabled: true },
    { key: 'X-Trace', value: '1', enabled: false },
  ];
  const after = structuredClone(before);
  after.headers[0].enabled = false;
  after.headers[1].enabled = true;
  after.headers.push({ key: 'X-Debug', value: 'yes', enabled: false });
  assert.deepEqual(updateArgs(before, after), [
    '--disable-header=Authorization',
    '--enable-header=X-Trace',
    '--header=X-Debug: yes',
    '--disable-header=X-Debug',
  ]);
  assert.deepEqual(updateArgs(before, structuredClone(before)), [], 'nothing changed');
});

test('tests, tags, and captures are replaced only when they changed', () => {
  const draft = structuredClone(saved);
  draft.tests = '  status 200\n\n';
  assert.deepEqual(updateArgs(saved, draft), [], 'blank lines and spaces are no change');
  draft.tests = 'status 200\nbody.id exists';
  draft.tags = ['smoke', 'users'];
  draft.captures = [];
  assert.deepEqual(updateArgs(saved, draft), [
    '--tests=status 200\nbody.id exists',
    '--tag=smoke',
    '--tag=users',
    '--no-captures',
  ]);
  const cleared = {
    ...structuredClone(saved),
    tags: [],
    captures: [{ key: 'token', value: 'body.token' }],
  };
  assert.deepEqual(updateArgs(saved, cleared), ['--no-tags', '--capture=token=body.token']);
  assert.equal(draftFrom({ ...saved, tags: ['two words'] }), undefined);
  assert.equal(draftFrom({ ...saved, captures: [{ key: 'a=b', value: 'body' }] }), undefined);
  assert.equal(draftFrom({ ...saved, captures: [{ key: 'a', value: '' }] }), undefined);
  assert.deepEqual(
    draftFrom({ ...saved, captures: [{ key: '', value: '' }] })?.captures,
    [],
    'an empty row is dropped',
  );
});

test('an unchanged request needs no update', () => {
  assert.deepEqual(updateArgs(saved, structuredClone(saved)), []);
});

test('changes become request update options, leaving hidden values alone', () => {
  const draft = structuredClone(saved);
  draft.method = 'POST';
  draft.url = '{{base}}/users';
  draft.headers[1].value = 'text/plain';
  draft.headers.push(
    { key: 'X-Trace', value: '-1', enabled: true },
    { key: ' ', value: '', enabled: true },
  );
  draft.body = '{"name":"Ada"}';
  assert.deepEqual(updateArgs(saved, draft), [
    '--method=POST',
    '--url={{base}}/users',
    '--header=Accept: text/plain',
    '--header=X-Trace: -1',
    '--body={"name":"Ada"}',
  ]);
});

test('a removed header is unset, a renamed one set, and an emptied body removed', () => {
  const withBody = { ...saved, body: 'x' };
  const draft = structuredClone(withBody);
  draft.headers = [{ key: 'accept', value: 'application/json', enabled: true }];
  draft.body = '';
  assert.deepEqual(updateArgs(withBody, draft), [
    '--header=accept: application/json',
    '--unset-header=Authorization',
    '--no-body',
  ]);
  // A hidden value typed over is set, so it replaces the secret.
  const replaced = structuredClone(saved);
  replaced.headers[0].value = 'Bearer new';
  assert.deepEqual(updateArgs(saved, replaced), ['--header=Authorization: Bearer new']);
});

test('only a well-formed draft from a webview is used', () => {
  assert.deepEqual(draftFrom({ ...saved, method: 'patch' })?.method, 'PATCH');
  assert.equal(draftFrom(undefined), undefined);
  assert.equal(draftFrom({ ...saved, method: 'GET 1' }), undefined);
  assert.equal(draftFrom({ ...saved, url: 'a\nb' }), undefined);
  assert.equal(draftFrom({ ...saved, body: 4 }), undefined);
  assert.equal(draftFrom({ ...saved, headers: [{ key: 'A:B', value: '' }] }), undefined);
  assert.equal(draftFrom({ ...saved, headers: [{ key: 'A', value: 'x\r\nB: y' }] }), undefined);
  assert.equal(draftFrom({ ...saved, headers: 'Accept: x' }), undefined);
  assert.equal(
    draftFrom({ ...saved, headers: [{ key: 'A', value: 'b' }] })?.headers[0].enabled,
    true,
  );
});

test('params are read from and written to the URL as typed', () => {
  const url = '{{base}}/users?page={{page}}&q=a%20b&flag#top';
  const params = paramsOf(url);
  assert.deepEqual(params, [
    { key: 'page', value: '{{page}}' },
    { key: 'q', value: 'a%20b' },
    { key: 'flag', value: '' },
  ]);
  assert.equal(withParams(url, params), url);
  assert.equal(
    withParams(url, [...params, { key: 'limit', value: '10' }]),
    '{{base}}/users?page={{page}}&q=a%20b&flag&limit=10#top',
  );
  assert.equal(withParams('https://x.test/a?b=1', []), 'https://x.test/a');
});

test('cookies are split where a new one starts, not at the comma in an expiry', () => {
  assert.deepEqual(
    responseCookies({
      'Set-Cookie':
        'session=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly, theme=dark; Path=/',
    }),
    [
      {
        name: 'session',
        value: 'abc',
        attributes: 'Path=/ · Expires=Wed, 21 Oct 2026 07:28:00 GMT · HttpOnly',
      },
      { name: 'theme', value: 'dark', attributes: 'Path=/' },
    ],
  );
  assert.deepEqual(responseCookies({ 'content-type': 'text/plain' }), []);
});

const result = (extra: Partial<SendResult>): SendResult => ({
  request: { id: 'r', name: 'List', method: 'GET', folder: 'Users' },
  url: 'http://127.0.0.1/users',
  status: 200,
  statusText: 'OK',
  durationMs: 12.4,
  size: 10,
  tests: [],
  captures: [],
  passed: true,
  headers: { 'content-type': 'application/json' },
  ...extra,
});

test('a send has a timeline of what happened', () => {
  const rows = timeline(
    result({ httpVersion: '1.1', tests: [{ label: 'status 200', pass: true, message: '' }] }),
    0,
  );
  assert.deepEqual(
    rows.slice(1).map((row) => `${row.label}: ${row.value}`),
    [
      'Request: GET http://127.0.0.1/users',
      'Response: 200 OK · HTTP/1.1',
      'Content type: application/json',
      'Size: 10 B',
      'Total time: 12 ms',
      'Tests: 1 of 1 passed',
    ],
  );
  assert.ok(timeline(result({ error: 'ECONNREFUSED' }), 0).some((row) => row.label === 'Error'));
});

test('performance groups sends by request, slowest first, with nearest-rank p95', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 95), 0);
  const entry = (name: string, durationMs: number, status = 200) => ({
    name,
    method: 'GET',
    url: '',
    status,
    type: '',
    durationMs,
    startedAt: 0,
  });
  const rows = performanceRows([entry('a', 10), entry('a', 30, 500), entry('b', 100)]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.count, row.errors, row.average, row.p95]),
    [
      ['b', 1, 0, '100 ms', '100 ms'],
      ['a', 2, 1, '20 ms', '30 ms'],
    ],
  );
});

test('runner settings from a webview are checked, and become run options', () => {
  const given = {
    collection: 'Users',
    mode: 'collection',
    iterations: '3',
    delayMs: 100,
    bail: true,
    concurrency: 5,
    durationSeconds: 10,
  };
  const options = runnerOptionsFrom(given, ['Users', 'Users/Admin'])!;
  assert.deepEqual(runnerArgs(options, '/tmp/rows.csv'), [
    '--collection=Users',
    '--iterations',
    '3',
    '--delay',
    '100',
    '--bail',
    '--data=/tmp/rows.csv',
  ]);
  assert.equal(runnerOptionsFrom({ ...given, collection: 'Nope' }, ['Users']), undefined);
  assert.equal(runnerOptionsFrom({ ...given, iterations: 0 }, ['Users']), undefined);
  assert.equal(runnerOptionsFrom({ ...given, concurrency: 51 }, ['Users']), undefined);
  assert.equal(runnerOptionsFrom({ ...given, mode: 'stress' }, ['Users']), undefined);
  const load = runnerOptionsFrom({ ...given, collection: '', mode: 'performance' }, [])!;
  assert.deepEqual(runnerArgs(load, '/tmp/rows.csv'), [
    '--mode',
    'performance',
    '--concurrency',
    '5',
    '--duration',
    '10',
  ]);
});

test('a run report becomes the runner’s summary and rows', () => {
  const report: LoadReport = {
    passed: false,
    summary: { requests: 2, failed: 1, skipped: 0, tests: 2, testsFailed: 1, elapsedMs: 40 },
    results: [
      result({ iteration: 1, tests: [{ label: 'status 200', pass: true, message: '' }] }),
      result({
        iteration: 2,
        status: 500,
        statusText: 'Error',
        passed: false,
        tests: [{ label: 'status 200', pass: false, message: 'was 500' }],
      }),
    ],
  };
  const shown = runnerResults(report);
  assert.deepEqual(
    shown.summary?.map((item) => `${item.label} ${item.value}${item.bad ? '!' : ''}`),
    ['Result Failed!', 'Requests 2', 'Failed 1!', 'Tests 1/2 passed!', 'Time 40 ms'],
  );
  assert.deepEqual(shown.results[1].messages, ['status 200 — was 500']);
  const load = runnerResults({
    ...report,
    passed: true,
    results: undefined,
    mode: 'performance',
    metrics: {
      completed: 100,
      failed: 0,
      errorRate: 0,
      rps: 50,
      average: 20,
      min: 5,
      max: 90,
      p50: 18,
      p90: 40,
      p95: 60,
      p99: 80,
    },
    thresholds: [{ name: 'p95', actual: 60, limit: 100, passed: true }],
  });
  assert.ok(load.summary?.some((item) => item.label === 'p95' && item.value === '60 ms'));
  assert.deepEqual(load.thresholds, [{ name: 'p95', value: '60 (limit 100)', passed: true }]);
  assert.deepEqual(load.results, []);
});

test('rows are edited in bulk as lines, switched-off ones commented', () => {
  const rows = [
    { key: 'Accept', value: 'application/json', enabled: true },
    { key: 'X-Trace', value: 'a: b', enabled: false },
  ];
  const text = rowsToText(rows, ': ');
  assert.equal(text, 'Accept: application/json\n# X-Trace: a: b');
  assert.deepEqual(rowsFromText(text, ': ', true), rows);
  assert.deepEqual(rowsFromText('\n  \nflag\nq=1=2', '=', false), [
    { key: 'flag', value: '', enabled: true },
    { key: 'q', value: '1=2', enabled: true },
  ]);
  // Without switches, `#` is part of the name.
  assert.equal(rowsFromText('#tag=1', '=', false)[0].key, '#tag');
});

test('a URL is split for colouring, every character kept', () => {
  const url = '{{baseUrl}}/v1/customers?limit={{limit}}&status=active&flag#top';
  const tokens = urlTokens(url);
  assert.equal(tokens.map((token) => token.text).join(''), url);
  const kind = (text: string) => tokens.find((token) => token.text === text)?.kind;
  assert.equal(kind('{{baseUrl}}'), 'variable');
  assert.equal(kind('/v1/customers'), 'path');
  assert.equal(kind('limit'), 'key');
  assert.equal(kind('{{limit}}'), 'variable');
  assert.equal(kind('active'), 'value');
  assert.equal(kind('flag'), 'key');
  const plain = urlTokens('https://api.example.com:8443/a?b=c');
  assert.deepEqual(
    plain.map((token) => [token.text, token.kind]),
    [
      ['https://', 'scheme'],
      ['api.example.com:8443', 'host'],
      ['/a', 'path'],
      ['?', 'punctuation'],
      ['b', 'key'],
      ['=', 'punctuation'],
      ['c', 'value'],
    ],
  );
  for (const text of ['', '?', '&&', 'https://', '{{', 'a{{b}}c?d={{e'])
    assert.equal(
      urlTokens(text)
        .map((token) => token.text)
        .join(''),
      text,
    );
});
