import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_FORMS,
  CREDENTIAL_KINDS,
  credentialFrom,
  credentialStatus,
  credentialValue,
  secretSaved,
  type CredentialRow,
} from './credentials';

const rows: CredentialRow[] = [
  {
    id: 'c1',
    name: 'AWS signing',
    type: 'aws',
    origin: 'https://api.example.com',
    hasSecret: true,
    hasExtraSecret: true,
    username: 'AKID',
    options: { awsRegion: 'eu-west-1' },
  },
];

test('every kind the command line saves has a form, and every form a kind', () => {
  assert.deepEqual(
    CREDENTIAL_KINDS.map((kind) => kind.value).sort(),
    Object.keys(CREDENTIAL_FORMS).sort(),
  );
  for (const fields of Object.values(CREDENTIAL_FORMS))
    for (const field of fields)
      assert.match(
        field.key,
        /^(username|headerName|secret|extraSecret|options\.\w+|oauth\.\w+)$/,
        field.key,
      );
});

test('a form starts from the credential, its secrets empty and marked saved', () => {
  const form = CREDENTIAL_FORMS.aws;
  const value = (key: string) =>
    credentialValue(
      rows[0],
      form.find((field) => field.key === key)!,
    );
  assert.deepEqual(
    [value('username'), value('options.awsRegion'), value('secret')],
    ['AKID', 'eu-west-1', ''],
  );
  assert.equal(
    secretSaved(
      rows[0],
      form.find((field) => field.key === 'extraSecret')!,
    ),
    true,
  );
  assert.equal(
    credentialValue(undefined, CREDENTIAL_FORMS['api-key'][0]),
    'X-API-Key',
    'a kind’s default',
  );
});

test('what the page posts becomes secret set’s fields; empty secrets keep what is saved', () => {
  const change = credentialFrom(
    {
      id: 'c1',
      name: 'Renamed?',
      type: 'aws',
      origin: 'https://api.example.com',
      values: {
        username: 'AKID',
        secret: '',
        'options.awsRegion': 'us-east-1',
        'options.awsService': 'execute-api',
        extraSecret: '',
      },
    },
    rows,
  );
  assert.deepEqual(change, {
    name: 'AWS signing',
    type: 'aws',
    origin: 'https://api.example.com',
    fields: { username: 'AKID', options: { awsRegion: 'us-east-1', awsService: 'execute-api' } },
    isNew: false,
  });
  const jwt = credentialFrom(
    {
      id: 'new',
      name: 'Ledger',
      type: 'jwt',
      origin: 'https://ledger.example.com',
      values: {
        'options.jwtAlgorithm': 'RS256',
        secret: '-----BEGIN PRIVATE KEY-----\nk',
        'options.jwtSecretBase64': true,
      },
    },
    rows,
  ) as { fields: Record<string, unknown> };
  assert.equal(jwt.fields.secret, '-----BEGIN PRIVATE KEY-----\nk');
  // The Base64 box belongs to shared secrets only, so with RS256 it is not sent.
  assert.equal((jwt.fields.options as Record<string, unknown>).jwtSecretBase64, undefined);
  for (const [form, reason] of [
    [{ id: 'new', name: '', type: 'bearer', origin: 'https://a.example' }, /name/],
    [
      {
        id: 'new',
        name: 'AWS signing',
        type: 'bearer',
        origin: 'https://a.example',
        values: { secret: 't' },
      },
      /already a credential/,
    ],
    [{ id: 'new', name: 'X', type: 'client-certificate', origin: 'https://a.example' }, /kind/],
    [
      { id: 'new', name: 'X', type: 'bearer', origin: 'ftp://a.example', values: { secret: 't' } },
      /http or https/,
    ],
    [{ id: 'new', name: 'X', type: 'bearer', origin: 'https://a.example', values: {} }, /token/],
    [
      { id: 'new', name: 'X', type: 'basic', origin: 'https://a.example', values: { secret: 'p' } },
      /username/,
    ],
    [
      {
        id: 'new',
        name: 'X',
        type: 'api-key',
        origin: 'https://a.example',
        values: { 'options.apiKeyIn': 'body', secret: 'k' },
      },
      /Choose sent in/,
    ],
    [
      { id: 'new', name: 'X', type: 'oauth2', origin: 'https://a.example', values: {} },
      /token URL and client ID/,
    ],
    [{ id: 'gone', name: 'X', type: 'bearer', origin: 'https://a.example' }, /gone/],
  ] as const)
    assert.match(String(credentialFrom(form, rows)), reason);
});

test('each credential says how it stands', () => {
  assert.equal(credentialStatus(rows[0]).label, 'Ready');
  assert.equal(
    credentialStatus({ ...rows[0], type: 'oauth2', connected: false }).label,
    'Not connected',
  );
  assert.equal(
    credentialStatus({ ...rows[0], type: 'oauth2', connected: true, expiresAt: 1 }).label,
    'Expired',
  );
  assert.equal(credentialStatus({ ...rows[0], external: true }).label, 'In the app');
});
