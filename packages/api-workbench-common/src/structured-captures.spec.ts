import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureValue } from './variables';
import { bodyFormat, parseBody } from './structured-body';
import type { HttpResponse } from './types';

/** Dotted capture sources: status.code and .text, header. and cookie. names, and body. paths. */

const response = (type: string, body: string, extra: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 201,
  statusText: 'Created',
  headers: { 'Content-Type': type, 'X-Request-Id': 'req-9', 'Set-Cookie': 'a.b=dotted; Path=/' },
  body,
  time: 12,
  size: body.length,
  url: 'https://api.test/',
  ...extra,
});

test('status, header, and cookie read with dots, like their older spellings', () => {
  const json = response('application/json', '{}');
  assert.equal(captureValue('status.code', json), '201');
  assert.equal(captureValue('status.text', json), 'Created');
  assert.equal(captureValue('status', json), '201', 'the old form still works');
  assert.equal(captureValue('header.x-request-id', json), 'req-9');
  assert.equal(captureValue('header["X-Request-Id"]', json), 'req-9');
  assert.equal(captureValue('cookie["a.b"]', json), 'dotted', 'a dotted cookie name in brackets');
  assert.throws(() => captureValue('header.x-missing', json), /was not returned/);
});

test('body. reads JSON, XML, YAML, form, NDJSON, and CSV bodies alike', () => {
  const cases: [string, string, string, string][] = [
    ['application/json', '{"user":{"id":7,"tags":["a","b"]}}', 'body.user.id', '7'],
    ['application/problem+json', '{"title":"Nope"}', 'body.title', 'Nope'],
    [
      'application/xml',
      '<user id="7"><name>Ada</name><role>admin</role><role>dev</role></user>',
      'body.user.name',
      'Ada',
    ],
    ['text/xml', '<user id="7"><name>Ada</name></user>', 'body.user.@id', '7'],
    [
      'application/xml',
      '<list><item>1</item><item>2</item></list>',
      'body.list.item[*] | join ","',
      '1,2',
    ],
    [
      'application/yaml',
      'user:\n  name: Ada\n  roles: [admin, dev]\n',
      'body.user.roles[1]',
      'dev',
    ],
    [
      'application/x-www-form-urlencoded',
      'access_token=A1&scope=read&scope=write',
      'body.scope | join " "',
      'read write',
    ],
    ['application/x-ndjson', '{"id":1}\n{"id":2}\n', 'body[1].id', '2'],
    ['text/csv', 'id,name\n1,Ada\n2,Grace\n', 'body[?(@.id == "2")].name | first', 'Grace'],
    ['application/json', '[{"id":1},{"id":2}]', 'body[*].id | join ","', '1,2'],
  ];
  for (const [type, body, source, expected] of cases)
    assert.equal(captureValue(source, response(type, body)), expected, `${type}: ${source}`);
  // A JSON path reads the other formats too.
  assert.equal(
    captureValue('$.user.name', response('application/xml', '<user><name>Ada</name></user>')),
    'Ada',
  );
});

test('without a declared type, the body is recognised by its look; text is refused with a reason', () => {
  assert.equal(bodyFormat(undefined, '{"a":1}'), 'json');
  assert.equal(bodyFormat('text/plain', '<?xml version="1.0"?><a/>'), 'xml');
  assert.equal(bodyFormat('', 'name: Ada\n'), 'yaml');
  assert.equal(bodyFormat('text/html', '<html></html>'), undefined);
  assert.equal(bodyFormat(undefined, 'just words'), undefined);
  assert.throws(
    () => captureValue('body.a', response('text/plain', 'just words')),
    /not JSON, XML, YAML, form, NDJSON, or CSV/,
  );
  assert.throws(
    () => captureValue('body.missing', response('application/json', '{}')),
    /nothing at body.missing/,
  );
  assert.throws(() => parseBody('{nope', 'application/json'), /not valid JSON/);
  // YAML aliases are capped, so a small body cannot grow into a huge value.
  const bomb =
    'a: &a [x,x,x,x,x,x,x,x,x]\n' +
    Array.from(
      { length: 12 },
      (_, i) =>
        `${'b'.repeat(i + 1)}: &${'b'.repeat(i + 1)} [${Array(9)
          .fill(i ? `*${'b'.repeat(i)}` : '*a')
          .join(',')}]`,
    ).join('\n');
  assert.throws(() => parseBody(bomb, 'application/yaml'), /not valid YAML/);
});
