import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureCompletions, checkCaptureSource, suggestedCaptures } from './capture-completions';
import { captureTrace } from './variables';
import type { HttpResponse } from './types';

/** Completions for capture sources, from what is typed and the last response. */

const response: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: {
    'Content-Type': 'application/json',
    'X-Request-Id': 'req-1',
    'Set-Cookie': 'session=abc; Path=/',
  },
  body: JSON.stringify({
    data: { token: 'T-1', user: { id: 7, name: 'Ada' } },
    items: [{ id: 1 }, { id: 2 }],
  }),
  time: 10,
  size: 100,
  url: 'https://api.test/login',
};
const values = (text: string, from = response) =>
  captureCompletions(text, from).map((item) => item.value);
const as = (type: string, body: string): HttpResponse => ({
  ...response,
  headers: { 'content-type': type },
  body,
});

test('with nothing typed, the kinds of source come first, then what the response holds', () => {
  const list = captureCompletions('', response);
  assert.deepEqual(
    list.slice(0, 5).map((item) => item.value),
    ['body.', 'header.', 'cookie.', 'status.code', 'status.text'],
  );
  assert.ok(
    list.some((item) => item.value === 'body.data'),
    'the body’s fields',
  );
  assert.ok(
    list.some((item) => item.value === 'header.x-request-id'),
    'and its headers',
  );
  assert.deepEqual(values('he'), ['header.']);
  assert.deepEqual(values('status'), ['status.code', 'status.text']);
  assert.deepEqual(
    captureCompletions('status.', response).map((item) => `${item.value} ${item.detail}`),
    ['status.code 200', 'status.text "OK"'],
  );
  assert.ok(values('ti').includes('timing ') && values('ti').includes('time'));
});

test('body paths come from the body, with its format and the value they hold', () => {
  assert.deepEqual(values('body.data.user.'), ['body.data.user.id', 'body.data.user.name']);
  assert.deepEqual(captureCompletions('body.data.t', response)[0], {
    value: 'body.data.token',
    label: 'body.data.token',
    detail: '"T-1"',
    group: 'Body',
    badge: 'JSON',
  });
  assert.ok(values('body.items').includes('body.items[*]'), 'a list offers every item');
  assert.ok(values('body.items[0').includes('body.items[0].id'));
  // `$.` paths still complete, as before.
  assert.deepEqual(values('$.data.'), [
    '$.data.token',
    '$.data.user',
    '$.data.user.id',
    '$.data.user.name',
  ]);
  assert.deepEqual(values('body.', { ...response, body: 'not json' }), []);
});

test('XML, YAML, form, NDJSON, and CSV bodies offer their paths too; HTML does not', () => {
  assert.deepEqual(
    captureCompletions(
      'body.user.',
      as('application/xml', '<user id="7"><name>Ada</name></user>'),
    ).map((item) => `${item.value} ${item.badge} ${item.detail}`),
    ['body.user.name XML "Ada"', 'body.user.@id XML "7"'],
  );
  assert.ok(
    values('body.', as('application/yaml', 'user:\n  name: Ada\n')).includes('body.user.name'),
  );
  assert.ok(values('body.', as('application/x-www-form-urlencoded', 'a=1')).includes('body.a'));
  assert.ok(values('body', as('application/x-ndjson', '{"id":1}\n{"id":2}\n')).includes('body[*]'));
  assert.ok(values('body', as('text/csv', 'id,name\n1,Ada\n')).includes('body[0].name'));
  assert.deepEqual(values('body.', as('text/html', '<p>hi</p>')), []);
});

test('headers, cookies, timings, and certificate fields complete after their keyword', () => {
  assert.deepEqual(values('header.x'), ['header.x-request-id']);
  assert.deepEqual(values('header x-'), ['header x-request-id'], 'the older spelling still works');
  assert.deepEqual(values('cookie.'), ['cookie.session']);
  assert.deepEqual(values('cookie '), ['cookie session']);
  assert.deepEqual(
    values('cookie.', {
      ...response,
      headers: { 'set-cookie': 'a.b=1' },
    }),
    ['cookie["a.b"]'],
    'a cookie name with a dot is put in brackets',
  );
  assert.ok(values('timing t').includes('timing ttfb'));
  assert.ok(values('certificate days').includes('certificate days-left'));
});

test('after a pipe, transforms complete, keeping what comes before and after', () => {
  const transforms = values('body.data.token | ');
  assert.ok(transforms.includes('body.data.token | jwt $.'));
  assert.ok(transforms.includes('body.data.token | default "'));
  assert.deepEqual(values('body.items[*].id |'), values('body.items[*].id | '));
  assert.deepEqual(values('body.items[*].id | jo'), ['body.items[*].id | join ", "']);
  assert.deepEqual(
    captureCompletions('body.a | up | trim', response, 'body.a | up'.length).map(
      (item) => item.value,
    ),
    ['body.a | upper | trim'],
    'text after the cursor is kept',
  );
  // A pipe inside a regular expression is not a transform.
  assert.ok(!values('regex /a|b').some((value) => value.includes('first')));
});

test('suggested captures pick out tokens, ids, and the headers and cookies later requests need', () => {
  assert.deepEqual(
    suggestedCaptures(response, ['body.data.user.id']).map((item) => item.source),
    ['body.data.token', 'header.x-request-id', 'cookie.session'],
  );
  assert.deepEqual(
    suggestedCaptures(as('application/xml', '<login><session_id>S1</session_id></login>'), []).map(
      (item) => `${item.source} ${item.detail}`,
    ),
    ['body.login.session_id XML · "S1"'],
  );
  assert.deepEqual(suggestedCaptures(undefined, []), []);
});

test('completions are grouped: sources, what the response holds, and transforms', () => {
  const groups = [...new Set(captureCompletions('', response).map((item) => item.group))];
  assert.deepEqual(groups, ['Sources', 'From the response']);
  assert.equal(captureCompletions('header.', response)[0].group, 'Headers');
  assert.equal(captureCompletions('body.data | ', response)[0].group, 'Transforms');
});

test('a source is checked as it is written, with a fix for a likely slip', () => {
  assert.deepEqual(checkCaptureSource('body.data.token | jwt $.sub'), { kind: 'body-path' });
  assert.deepEqual(checkCaptureSource('header.x-request-id'), { kind: 'header' });
  assert.deepEqual(checkCaptureSource('status.code'), { kind: 'status' });
  assert.equal(checkCaptureSource('$.items[*].id').kind, 'json-path');
  assert.deepEqual(checkCaptureSource('$.token | jwtt $.sub'), {
    kind: 'json-path',
    problem: '“jwtt” is not a transform.',
    fix: '$.token | jwt $.sub',
    fixLabel: 'Use jwt',
  });
  const source = checkCaptureSource('headr.x-request-id');
  assert.equal(source.kind, 'unknown');
  assert.equal(source.fix, 'header.x-request-id');
  assert.equal(checkCaptureSource('timing ttbf').fix, 'timing ttfb');
  assert.equal(checkCaptureSource('certificate days-lft').fix, 'certificate days-left');
  assert.match(checkCaptureSource('regex /([a-z/').problem!, /regular expression is not valid/);
  assert.match(checkCaptureSource('body.items[').problem!, /path is not valid/);
  assert.match(checkCaptureSource('between "a"').problem!, /two quoted markers/);
  assert.match(checkCaptureSource('header.').problem!, /Name the header/);
  assert.deepEqual(
    [checkCaptureSource('$.a |').problem, checkCaptureSource('$.a |').fix],
    ['Each | needs a transform after it, such as | first; or remove the |.', '$.a'],
  );
  assert.equal(checkCaptureSource('zzzz').fix, undefined, 'no guess when nothing is close');
});

test('a trace shows each step’s value and type, where it failed, and what default replaced', () => {
  assert.deepEqual(
    captureTrace('body.items[*].id | first | length', response).map((step) => [
      step.step,
      step.value ?? step.error,
      step.type,
    ]),
    [
      ['body.items[*].id', '[1,2]', 'list'],
      ['first', '1', 'number'],
      ['length', undefined, undefined],
    ].map(([step, value, type], index) =>
      index === 2
        ? [step, 'length needs text, a list, or an object.', undefined]
        : [step, value, type],
    ),
  );
  const fallback = captureTrace('body.missing | upper | default "none"', response);
  assert.equal(fallback[0].error, 'The body has nothing at body.missing.');
  assert.equal(fallback[1].skipped, true, 'a step after a failure is skipped');
  assert.deepEqual([fallback[2].value, fallback[2].skipped], ['none', undefined]);
  assert.equal(captureTrace('body.data.token | default "x"', response)[1].skipped, true);
});
