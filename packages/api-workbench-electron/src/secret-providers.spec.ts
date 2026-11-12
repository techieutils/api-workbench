import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  defaults,
  providers,
  visibleFields,
} from '@techieutils/api-workbench-common/secret-providers';
import {
  normalizeExternal,
  providerEndpoint,
  resolveExternalSecret,
  resolveCredential,
} from './secret-providers';
import { CredentialVault, credentialHeaders, validateCredential } from './credentials';
import type { CredentialRecord } from '@techieutils/api-workbench-common/types';
import type { SecretProvider } from '@techieutils/api-workbench-common/secret-providers';
const record = (
  provider: SecretProvider,
  config: Record<string, string>,
  secrets: Record<string, string> = {},
): CredentialRecord => ({
  id: 'external',
  name: 'External API',
  kind: 'bearer',
  allowedOrigin: 'https://api.example.com',
  updatedAt: '2026-01-01',
  external: { ...defaults(provider), config: { ...defaults(provider).config, ...config } },
  providerSecrets: secrets,
});
const mock =
  (handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  async (input, init) =>
    handler(new URL(String(input)), init || {});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('provider definitions expose six supported services and conditional authentication fields', () => {
  assert.equal(providers.length, 6);
  const external = defaults('aws-secrets-manager');
  assert.equal(
    visibleFields(external).some((field) => field.key === 'secretAccessKey'),
    false,
  );
  external.config.auth = 'keys';
  assert.equal(visibleFields(external).filter((field) => field.secret).length, 3);
});
test('provider validation restricts endpoints, traversal, identifiers and required auth; drops unrecognized config', () => {
  assert.equal(providerEndpoint('http://localhost:8200').hostname, 'localhost');
  for (const url of [
    'http://vault.example.com',
    'https://user:secret@example.com',
    'file:///tmp/vault',
    'https://example.com?token=secret',
    'https://example.com/#hash',
  ])
    assert.throws(() => providerEndpoint(url));
  const entry = record(
    'hashicorp-vault',
    { vaultUrl: 'https://vault.example.com', path: 'app/token', extraneous: 'should-not-survive' },
    { token: 'vault-secret', unexpected: 'drop' },
  );
  const result = normalizeExternal(entry.external!, entry.providerSecrets);
  assert.equal(result.external.config.extraneous, undefined);
  assert.equal(result.secrets.unexpected, undefined);
  assert.throws(() =>
    normalizeExternal(
      { ...entry.external!, config: { ...entry.external!.config, path: '../escape' } },
      entry.providerSecrets,
    ),
  );
  assert.throws(() => normalizeExternal(entry.external!, {}), /Vault token/);
});
test('HashiCorp KV v2 reads namespaced/versioned secrets and JSON Pointer escaping', async () => {
  const entry = record(
    'hashicorp-vault',
    {
      vaultUrl: 'https://vault.example.com',
      mount: 'team/kv',
      path: 'app/api',
      namespace: 'org/team',
      version: '3',
    },
    { token: 'vault-auth' },
  );
  entry.secretField = '/a~1b/~0key';
  const value = await resolveExternalSecret(
    entry,
    undefined,
    mock((url, init) => {
      assert.equal(url.pathname, '/v1/team/kv/data/app/api');
      assert.equal(url.searchParams.get('version'), '3');
      assert.equal((init.headers as Record<string, string>)['X-Vault-Token'], 'vault-auth');
      assert.equal((init.headers as Record<string, string>)['X-Vault-Namespace'], 'org/team');
      assert.equal(init.redirect, 'error');
      return json({ data: { data: { 'a/b': { '~key': 'resolved-token' } } } });
    }),
  );
  assert.equal(value, 'resolved-token');
});
test('AppRole authenticates before KV v1 read without retaining the issued token', async () => {
  const entry = record(
    'hashicorp-vault',
    {
      vaultUrl: 'https://vault.example.com',
      path: 'my-api',
      kvVersion: '1',
      auth: 'approle',
      authMount: 'machine',
    },
    { roleId: 'role', secretId: 'secret-id' },
  );
  entry.secretField = '/password';
  let calls = 0;
  const value = await resolveExternalSecret(
    entry,
    undefined,
    mock((url, init) => {
      calls++;
      if (calls === 1) {
        assert.equal(url.pathname, '/v1/auth/machine/login');
        assert.deepEqual(JSON.parse(String(init.body)), {
          role_id: 'role',
          secret_id: 'secret-id',
        });
        return json({ auth: { client_token: 'temporary-token' } });
      }
      assert.equal(url.pathname, '/v1/secret/my-api');
      assert.equal((init.headers as Record<string, string>)['X-Vault-Token'], 'temporary-token');
      return json({ data: { password: 'api-password' } });
    }),
  );
  assert.equal(value, 'api-password');
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(entry).includes('temporary-token'), false);
});
test('Azure client credentials uses the vault scope and versioned secret URL', async () => {
  const entry = record(
    'azure-key-vault',
    {
      vaultUrl: 'https://demo.vault.azure.net',
      secretName: 'api-token',
      version: 'abcd',
      tenantId: 'tenant',
      clientId: 'client',
    },
    { clientSecret: 'client-secret' },
  );
  let calls = 0;
  const value = await resolveExternalSecret(
    entry,
    undefined,
    mock((url, init) => {
      calls++;
      if (calls === 1) {
        assert.equal(url.host, 'login.microsoftonline.com');
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get('scope'), 'https://vault.azure.net/.default');
        assert.equal(body.get('client_secret'), 'client-secret');
        return json({ access_token: 'azure-access' });
      }
      assert.equal(url.pathname, '/secrets/api-token/abcd');
      assert.equal(url.searchParams.get('api-version'), '2025-07-01');
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer azure-access');
      return json({ value: 'azure-secret' });
    }),
  );
  assert.equal(value, 'azure-secret');
});
test('Google Secret Manager decodes payloads and selects a structured string field', async () => {
  const entry = record(
    'gcp-secret-manager',
    { projectId: 'project-1', secretName: 'api-token', auth: 'token' },
    { accessToken: 'google-access' },
  );
  entry.secretField = '/key';
  const value = await resolveExternalSecret(
    entry,
    undefined,
    mock((url, init) => {
      assert.equal(url.pathname, '/v1/projects/project-1/secrets/api-token/versions/latest:access');
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer google-access');
      return json({ payload: { data: Buffer.from('{"key":"google-secret"}').toString('base64') } });
    }),
  );
  assert.equal(value, 'google-secret');
});
test('AWS adapters send official GetSecretValue and decrypted GetParameter commands', async () => {
  const originalSecrets = SecretsManagerClient.prototype.send,
    originalSsm = SSMClient.prototype.send;
  try {
    SecretsManagerClient.prototype.send = (async (command: GetSecretValueCommand) => {
      assert.ok(command instanceof GetSecretValueCommand);
      assert.equal(command.input.SecretId, 'api-secret');
      assert.equal(command.input.VersionStage, 'CURRENT');
      return { SecretBinary: Buffer.from('{"key":"aws-secret"}') };
    }) as typeof originalSecrets;
    SSMClient.prototype.send = (async (command: GetParameterCommand) => {
      assert.ok(command instanceof GetParameterCommand);
      assert.equal(command.input.Name, '/app/key');
      assert.equal(command.input.WithDecryption, true);
      return { Parameter: { Value: 'parameter-secret' } };
    }) as typeof originalSsm;
    const entry = record('aws-secrets-manager', {
      region: 'us-east-1',
      secretId: 'api-secret',
      version: 'CURRENT',
    });
    entry.secretField = '/key';
    assert.equal(await resolveExternalSecret(entry), 'aws-secret');
    assert.equal(
      await resolveExternalSecret(record('aws-ssm', { region: 'us-east-1', secretId: '/app/key' })),
      'parameter-secret',
    );
  } finally {
    SecretsManagerClient.prototype.send = originalSecrets;
    SSMClient.prototype.send = originalSsm;
  }
});
test('SAP BTP reads and decrypts authenticated JWE payloads; rejects tampering', async () => {
  const { generateKeyPair, exportPKCS8, CompactEncrypt } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RSA-OAEP-256', { extractable: true });
  const payload = await new CompactEncrypt(
    Buffer.from('{"value":"btp-secret","username":"remote-user"}'),
  )
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', iat: Math.floor(Date.now() / 1000) })
    .encrypt(publicKey);
  const entry = record(
    'sap-btp',
    {
      serviceUrl: 'https://credstore.example.com/api/v1/credentials',
      namespace: 'my-space',
      credentialName: 'api password',
    },
    {
      bindingUsername: 'service-user',
      bindingPassword: 'service-pass',
      privateKey: await exportPKCS8(privateKey),
    },
  );
  assert.equal(
    await resolveExternalSecret(
      entry,
      undefined,
      mock((url, init) => {
        assert.equal(url.pathname, '/api/v1/credentials/password');
        assert.equal(url.searchParams.get('name'), 'api password');
        assert.equal(
          (init.headers as Record<string, string>)['sapcp-credstore-namespace'],
          'my-space',
        );
        assert.equal(
          (init.headers as Record<string, string>).Authorization,
          'Basic ' + Buffer.from('service-user:service-pass').toString('base64'),
        );
        return new Response(payload);
      }),
    ),
    'btp-secret',
  );
  const parts = payload.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  await assert.rejects(
    resolveExternalSecret(
      entry,
      undefined,
      mock(() => new Response(parts.join('.'))),
    ),
    /Could not read the secret/,
  );
});
test('lookup errors omit provider bodies, payloads and exception causes; cancellation prevents dispatch', async () => {
  const entry = record(
    'azure-key-vault',
    { vaultUrl: 'https://demo.vault.azure.net', secretName: 'token', auth: 'token' },
    { accessToken: 'auth-secret' },
  );
  await assert.rejects(
    resolveExternalSecret(
      entry,
      undefined,
      mock(() => json({ error: 'LEAK-ME' }, 403)),
    ),
    (error) =>
      error instanceof Error &&
      /HTTP 403/.test(error.message) &&
      !JSON.stringify(error).includes('LEAK-ME') &&
      !error.cause,
  );
  await assert.rejects(
    resolveExternalSecret(
      entry,
      undefined,
      mock(() => new Response('{BROKEN-SECRET-JSON')),
    ),
    (error) => error instanceof Error && !error.message.includes('BROKEN-SECRET'),
  );
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    resolveExternalSecret(
      entry,
      controller.signal,
      mock(() => {
        called = true;
        return json({});
      }),
    ),
    /cancelled/,
  );
  assert.equal(called, false);
  entry.secretField = '/missing';
  await assert.rejects(
    resolveExternalSecret(
      entry,
      undefined,
      mock(() => json({ value: '{"key":"sensitive"}' })),
    ),
    /selected field does not exist/,
  );
});
test('external profiles encrypt provider auth, redact summaries, retain blank edits and clear secrets when changing source', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'workbench-external-'));
  const file = path.join(folder, 'vault.enc');
  const key = randomBytes(32);
  const vault = new CredentialVault(file, {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      const result = Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString();
      return { result, shouldReEncrypt: false };
    },
  });
  try {
    const { id: _id, ...input } = record(
      'azure-key-vault',
      { vaultUrl: 'https://demo.vault.azure.net', secretName: 'api', auth: 'token' },
      { accessToken: 'PROVIDER-SECRET' },
    );
    void _id;
    const saved = await vault.save(input);
    assert.equal(JSON.stringify(saved).includes('PROVIDER-SECRET'), false);
    assert.equal((await readFile(file)).includes(Buffer.from('PROVIDER-SECRET')), false);
    assert.deepEqual(saved.providerSecretFields, ['accessToken']);
    await vault.save({
      ...input,
      id: saved.id,
      providerSecrets: { accessToken: '' },
      name: 'Edited',
    });
    assert.equal((await vault.get(saved.id)).providerSecrets?.accessToken, 'PROVIDER-SECRET');
    await assert.rejects(
      vault.save({
        ...input,
        id: saved.id,
        external: {
          provider: 'hashicorp-vault',
          config: {
            ...defaults('hashicorp-vault').config,
            vaultUrl: 'https://vault.example.com',
            path: 'api',
          },
        },
        providerSecrets: {},
      }),
      /Vault token/,
    );
    await vault.save({
      id: saved.id,
      name: 'Local',
      kind: 'bearer',
      allowedOrigin: 'https://api.example.com',
      secret: 'LOCAL-SECRET',
    });
    const local = await vault.get(saved.id);
    assert.equal(local.external, undefined);
    assert.equal(local.providerSecrets, undefined);
    assert.equal(local.secret, 'LOCAL-SECRET');
    assert.equal(await resolveCredential(local), local);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('external OAuth client secrets validate without local plaintext and origin restriction remains enforced', () => {
  const entry = record('aws-secrets-manager', { region: 'us-east-1', secretId: 'oauth-secret' });
  entry.kind = 'oauth2';
  entry.oauth = {
    grantType: 'client_credentials',
    authorizationUrl: '',
    tokenUrl: 'https://id.example.com/token',
    clientId: 'client',
    clientAuth: 'basic',
    scope: '',
    audience: '',
    callbackPort: 43821,
  };
  assert.doesNotThrow(() => validateCredential(entry));
  assert.throws(
    () =>
      credentialHeaders(
        { ...entry, kind: 'bearer', secret: 'resolved' },
        { id: 'req', url: 'https://other.example.com', method: 'GET', headers: {}, body: '' },
      ),
    /restricted/,
  );
});

test('invalid credential header values cannot disclose resolved secrets in error messages', () => {
  const entry = record('aws-secrets-manager', { region: 'us-east-1', secretId: 'api' });
  entry.secret = 'PRIVATE-REMOTE-VALUE\ninvalid';
  assert.throws(
    () =>
      credentialHeaders(entry, {
        id: 'req',
        url: 'https://api.example.com',
        method: 'GET',
        headers: {},
        body: '',
      }),
    (error) =>
      error instanceof Error &&
      /cannot be used as an HTTP header/.test(error.message) &&
      !error.message.includes('PRIVATE-REMOTE-VALUE'),
  );
});

test('cancellation releases a lookup even when a provider auth or transport implementation stalls', async () => {
  const entry = record(
    'azure-key-vault',
    { vaultUrl: 'https://demo.vault.azure.net', secretName: 'token', auth: 'token' },
    { accessToken: 'access-token' },
  );
  const controller = new AbortController();
  const pending = resolveExternalSecret(
    entry,
    controller.signal,
    mock(() => new Promise<Response>(() => {})),
  );
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
