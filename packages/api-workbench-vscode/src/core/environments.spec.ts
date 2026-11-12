import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SECRET_LOOKING,
  SENSITIVE_VARIABLE,
  environmentChanged,
  environmentRowsFrom,
} from './environments';

test('the variables a page posts are checked before they are saved', () => {
  assert.deepEqual(
    environmentRowsFrom([
      { key: ' base_url ', value: 'https://a.example', enabled: true },
      { key: '', value: '' },
      { key: 'debug', value: 'true', enabled: false },
    ]),
    [
      { key: 'base_url', value: 'https://a.example', enabled: true },
      { key: 'debug', value: 'true', enabled: false },
    ],
  );
  for (const [rows, reason] of [
    [[{ key: 'a b', value: '1' }], /not a variable name/],
    [[{ key: 'a', value: '1\n2' }], /one line/],
    [
      [
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ],
      /twice/,
    ],
    ['nope', /could not be read/],
  ] as const)
    assert.match(String(environmentRowsFrom(rows)), reason);
  assert.equal(
    environmentChanged(
      [{ key: 'a', value: '1', enabled: true }],
      [{ key: 'a', value: '1', enabled: false }],
    ),
    true,
  );
  assert.ok(SECRET_LOOKING.test('api_token') && !SECRET_LOOKING.test('base_url'));
});

test('the same variables are masked as in the app', () => {
  const app = readFileSync(
    path.resolve(__dirname, '../../../api-workbench-app/src/stores/environments.ts'),
    'utf8',
  );
  assert.ok(
    app.includes(`SENSITIVE_VARIABLE = ${SENSITIVE_VARIABLE.toString()}`),
    'the app’s pattern',
  );
  for (const name of [
    'api_token',
    'client_secret',
    'password',
    'apiKey',
    'private_key',
    'aws_credential',
  ])
    assert.ok(SENSITIVE_VARIABLE.test(name), name);
  for (const name of ['base_url', 'page_size', 'region'])
    assert.ok(!SENSITIVE_VARIABLE.test(name), name);
});
