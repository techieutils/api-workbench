import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regexRisk, untrustedRegExp } from './regex-safety';
import { run } from './assertions';
import { ruleRegExp } from './mocks';
import { validateJsonSchema } from './json-schema';
import type { HttpResponse } from './types';

test('patterns that can take exponential time are refused, with why', () => {
  for (const pattern of [
    '(a+)+$',
    '^([a-z]+)*$',
    'a+(a+)+$!',
    '(\\w+\\.?)+@',
    '(a{1,20})+$',
    '(?:x*)*y',
    '((ab)+c?)+$',
    '(?<word>[a-z]+\\s?)+$',
    '(?i:a+)+$',
    '((a+))+$',
    '(a?){12}a{12}',
    '(\\d+,)*\\d+',
  ])
    assert.match(regexRisk(pattern) ?? '', /repeated group that contains another repeat/, pattern);
  for (const pattern of ['(a)\\1', '(?<n>a)\\k<n>'])
    assert.match(regexRisk(pattern) ?? '', /back-references/, pattern);
  for (const pattern of [
    '(a|a)*$',
    '(a|ab)*c',
    '(?:ab|abc)+$',
    '(A|a)+',
    '(\\d|x)*',
    '(a|)+',
    '(?:.|\\s)*$',
    '(x|(y))+',
  ])
    assert.match(regexRisk(pattern) ?? '', /alternatives can start the same way/, pattern);
  for (const pattern of ['((?=a)a)+$', '((?!b)a)*$', '(x(?<=x)a)+'])
    assert.match(regexRisk(pattern) ?? '', /lookaround/, pattern);
});

test('everyday patterns are allowed', () => {
  for (const pattern of [
    '^ab+c$',
    '^\\d{3}-\\d{4}$',
    '^[\\w.+-]+@[\\w-]+\\.[\\w.]+$',
    '^(?:GET|POST|PUT)$',
    '^[A-Z]{3}$',
    '^(\\d{1,3}\\.){3}\\d{1,3}$',
    '^(?=.*\\d)(?=.*[a-z]).{8,}$',
    '(?<=\\$)\\d+',
    '^[\\d,]+$',
    '^v\\d+(\\.\\d+)?$',
    '\\u{1F600}+',
    '\\p{L}+',
    '[(+)]+',
    '\\(a+\\)+',
    'a{2}',
    '(ab)?c',
    '(a|b)*c',
    '(a+){3}',
    '(GET|POST|PUT)+',
    '(?:http|https)://',
    '(\\.|-)+x',
    '([a-z]{2}-){1,4}',
  ])
    assert.equal(regexRisk(pattern), undefined, pattern);
  assert.ok(untrustedRegExp('^ab+c$', 'i').test('ABBC'));
  assert.throws(() => untrustedRegExp('(a+)+$'), /is not allowed: a repeated group/);
});

test('a refused pattern fails its check at once, in tests, mock rules, and schemas', () => {
  const evil = 'a'.repeat(40) + '!';
  const response = {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: evil,
    time: 1,
    size: evil.length,
  } as unknown as HttpResponse;
  const started = Date.now();
  const [result] = run('body matches /^(a+)+$/', response);
  assert.equal(result.pass, false);
  assert.match(result.message, /not allowed/);
  assert.throws(() => ruleRegExp('/^([a-z]+)*$/'), /not allowed/);
  // A schema's pattern that could hang is not held against the value, as an unreadable one is.
  assert.deepEqual(validateJsonSchema(evil, { type: 'string', pattern: '^(a+)+$' }), []);
  assert.ok(Date.now() - started < 1000, 'nothing ran the pattern');
});
