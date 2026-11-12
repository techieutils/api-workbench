import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialVault,
  credentialHeaders,
  credentialSummary,
  validateCredential,
  type SecretStorage,
} from './credentials';
import {
  buildAuthorizationUrl,
  createPkce,
  exchangeToken,
  secureEndpoint,
  validState,
} from './oauth';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import type {
  CredentialRecord,
  OAuthConfig,
  RequestPayload,
} from '@techieutils/api-workbench-common/types';
const config: OAuthConfig = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'desktop-client',
  scope: 'api.read',
  audience: '',
  clientAuth: 'none',
  callbackPort: 43821,
};
const request: RequestPayload = {
  id: 'request',
  url: 'https://api.example.com/users',
  method: 'GET',
  headers: {},
  body: '',
};
function storage(): SecretStorage {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'test-encrypted-storage',
    async encryptStringAsync(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      const result = Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString('utf8');
      return { result, shouldReEncrypt: false };
    },
  };
}
test('PKCE uses an independent verifier, S256 challenge, and random state', () => {
  const a = createPkce(),
    b = createPkce();
  assert.equal(a.verifier.length, 43);
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
  assert.notEqual(a.state, b.state);
  const url = new URL(buildAuthorizationUrl(config, 'http://127.0.0.1:43821/oauth/callback', a));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), a.state);
  assert.equal(url.searchParams.get('scope'), 'api.read');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.ok(validState(a.state, a.state));
  assert.equal(validState('different', a.state), false);
  assert.equal(validState(null, a.state), false);
});
test('OAuth endpoints require HTTPS except loopback development servers', () => {
  assert.equal(secureEndpoint('http://127.0.0.1:43821/token').protocol, 'http:');
  for (const value of [
    'http://id.example.com/token',
    'file:///token',
    'https://user:password@example.com/token',
    'https://id.example.com/token#fragment',
  ])
    assert.throws(() => secureEndpoint(value));
});
test('vault encrypts secrets, excludes them from metadata, serializes writes, and preserves blank secret edits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-vault-'));
  try {
    const file = path.join(directory, 'credentials.enc');
    const crypto = storage();
    const vault = new CredentialVault(file, crypto);
    const [a, b] = await Promise.all([
      vault.save({
        name: 'Production token',
        kind: 'bearer',
        allowedOrigin: 'https://api.example.com',
        secret: 'TOP-SECRET-TOKEN',
      }),
      vault.save({
        name: 'Service account',
        kind: 'basic',
        allowedOrigin: 'https://api.example.com',
        username: 'service',
        secret: 'TOP-SECRET-PASSWORD',
      }),
    ]);
    assert.equal((await vault.list()).length, 2);
    assert.equal((await readFile(file)).includes(Buffer.from('TOP-SECRET')), false);
    assert.equal(JSON.stringify(a).includes('TOP-SECRET'), false);
    assert.equal((await new CredentialVault(file, crypto).get(b.id)).secret, 'TOP-SECRET-PASSWORD');
    await vault.save({
      id: a.id,
      name: 'Renamed',
      kind: 'bearer',
      allowedOrigin: 'https://api.example.com',
      secret: '',
    });
    assert.equal((await vault.get(a.id)).secret, 'TOP-SECRET-TOKEN');
    await assert.rejects(
      vault.save({
        name: 'Invalid',
        kind: 'bearer',
        allowedOrigin: 'https://api.example.com/path',
        secret: 'secret',
      }),
    );
    assert.equal((await vault.list()).length, 2);
    await vault.delete(a.id);
    assert.equal((await vault.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('vault re-encrypts its file when the OS key has rotated', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-vault-rotation-'));
  try {
    const file = path.join(directory, 'credentials.enc');
    const crypto = storage();
    let rotated = false;
    let encryptions = 0;
    const vault = new CredentialVault(file, {
      ...crypto,
      encryptStringAsync: (value) => {
        encryptions++;
        return crypto.encryptStringAsync(value);
      },
      // Data written before the rotation decrypts, but asks to be encrypted again.
      decryptStringAsync: async (value) => ({
        ...(await crypto.decryptStringAsync(value)),
        shouldReEncrypt: rotated,
      }),
    });
    await vault.save({
      name: 'Token',
      kind: 'bearer',
      allowedOrigin: 'https://api.example.com',
      secret: 'ROTATED-SECRET',
    });
    const before = await readFile(file);
    rotated = true;
    encryptions = 0;
    assert.deepEqual(
      (await vault.list()).map((item) => item.name),
      ['Token'],
    );
    assert.equal(encryptions, 1, 'a stale vault is saved again once');
    assert.notDeepEqual(await readFile(file), before, 'the file is rewritten');
    rotated = false;
    assert.equal((await vault.list())[0].name, 'Token', 'the rewritten vault still opens');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('vault refuses insecure system storage rather than falling back to plaintext', async () => {
  const vault = new CredentialVault('/unused', {
    ...storage(),
    getSelectedStorageBackend: () => 'basic_text',
  });
  assert.equal((await vault.status()).available, false);
  await assert.rejects(
    vault.list(),
    /No system keyring is available.*No secrets will be saved as plain text/,
  );
});
test('saved credentials enforce exact origins and token expiry', () => {
  const record: CredentialRecord = {
    id: 'credential',
    name: 'API key',
    kind: 'api-key',
    allowedOrigin: 'https://api.example.com',
    secret: 'secret',
    headerName: 'X-API-Key',
    updatedAt: new Date().toISOString(),
  };
  assert.deepEqual(credentialHeaders(record, request), { 'X-API-Key': 'secret' });
  assert.throws(
    () => credentialHeaders(record, { ...request, url: 'https://attacker.example.com/users' }),
    /restricted/,
  );
  assert.throws(
    () => credentialHeaders(record, { ...request, url: 'http://api.example.com/users' }),
    /restricted/,
  );
  const oauth: CredentialRecord = {
    ...record,
    kind: 'oauth2',
    oauth: config,
    tokens: { accessToken: 'ACCESS', refreshToken: 'REFRESH', expiresAt: Date.now() - 1 },
  };
  assert.throws(() => credentialHeaders(oauth, request), /expired/);
  const summary = credentialSummary(oauth);
  assert.equal(JSON.stringify(summary).includes('REFRESH'), false);
  assert.equal(JSON.stringify(summary).includes('ACCESS'), false);
  assert.throws(() => validateCredential({ ...record, headerName: 'bad\nheader' }), /header/);
});
test('OAuth exchanges use form encoding and reject redirects and invalid token responses', async (t) => {
  const calls: {
    url: string;
    init: RequestInit;
  }[] = [];
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        access_token: 'ACCESS',
        refresh_token: 'REFRESH',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    },
  );
  const token = await exchangeToken(
    { ...config, clientAuth: 'basic', clientSecret: 'secret+value' },
    { grant_type: 'client_credentials' },
  );
  assert.equal(token.accessToken, 'ACCESS');
  assert.ok(token.expiresAt! > Date.now());
  assert.equal(calls[0].init.redirect, 'error');
  const headers = new Headers(calls[0].init.headers);
  assert.ok(headers.get('authorization')?.startsWith('Basic '));
  assert.equal(new URLSearchParams(String(calls[0].init.body)).has('client_secret'), false);
  fetchMock.mock.mockImplementation(async () => Response.json({ token_type: 'Bearer' }));
  await assert.rejects(exchangeToken(config, { grant_type: 'authorization_code' }), /access token/);
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ access_token: 'token', token_type: 'MAC' }),
  );
  await assert.rejects(exchangeToken(config, { grant_type: 'authorization_code' }), /Bearer/);
});
/** A local server whose handler sees every request; closed when the test ends. */
async function localServer(
  t: { after(callback: () => Promise<void>): void },
  handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    handler(incoming, body, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
test('HTTP client blocks credential disclosure on cross-origin redirects', async (t) => {
  let calls = 0;
  const origin = await localServer(t, (_request, _body, response) => {
    calls++;
    response.writeHead(302, { location: 'https://untrusted.example.com/steal' }).end();
  });
  const response = await sendHttpRequest(
    { ...request, url: `${origin}/users`, headers: { 'X-API-Key': 'secret' } },
    new AbortController(),
  );
  assert.match(response.error || '', /Cross-origin redirect blocked/);
  assert.equal(calls, 1);
});
test('HTTP client honors redirect setting and handles POST to GET conversion', async (t) => {
  const calls: { method?: string; url?: string; body: string; contentType?: string }[] = [];
  let redirect = 303;
  const origin = await localServer(t, (incoming, body, response) => {
    calls.push({
      method: incoming.method,
      url: incoming.url,
      body,
      contentType: incoming.headers['content-type'],
    });
    if (incoming.url === '/next' && redirect === 303) response.end('{"ok":true}');
    else response.writeHead(redirect, { location: '/next' }).end();
  });
  const response = await sendHttpRequest(
    {
      ...request,
      url: `${origin}/users`,
      method: 'POST',
      body: 'payload',
      headers: { 'Content-Type': 'application/json' },
    },
    new AbortController(),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].body, 'payload');
  assert.deepEqual(calls[1], { method: 'GET', url: '/next', body: '', contentType: undefined });
  redirect = 302;
  const raw = await sendHttpRequest(
    { ...request, url: `${origin}/users`, followRedirects: false },
    new AbortController(),
  );
  assert.equal(raw.status, 302);
});
test('OAuth refresh sends the refresh token in the form body, without returning it in metadata', async (t) => {
  let posted = '';
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    posted = String(init.body);
    return Response.json({ access_token: 'NEW-ACCESS', token_type: 'Bearer', expires_in: 0 });
  });
  const tokens = await exchangeToken(config, {
    grant_type: 'refresh_token',
    refresh_token: 'PRIVATE-REFRESH',
  });
  assert.equal(new URLSearchParams(posted).get('refresh_token'), 'PRIVATE-REFRESH');
  assert.equal(new URLSearchParams(posted).get('grant_type'), 'refresh_token');
  assert.ok(tokens.expiresAt! <= Date.now());
});
test('HTTP cancellation returns a controlled error', async (t) => {
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => (received = resolve));
  // The server never answers, so only the abort ends the request.
  const origin = await localServer(t, () => received());
  const controller = new AbortController();
  const pending = sendHttpRequest({ ...request, url: `${origin}/slow` }, controller);
  await arrived;
  controller.abort();
  assert.match((await pending).error || '', /cancelled or timed out/);
});
test('OAuth tokens stay encrypted and editing a profile clears its old tokens', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-oauth-vault-'));
  try {
    const file = path.join(directory, 'credentials.enc');
    const vault = new CredentialVault(file, storage());
    const profile = await vault.save({
      name: 'Identity',
      kind: 'oauth2',
      allowedOrigin: 'https://api.example.com',
      oauth: { ...config, clientAuth: 'basic', clientSecret: 'CLIENT-SECRET' },
    });
    await vault.setTokens(profile.id, {
      accessToken: 'PRIVATE-ACCESS',
      refreshToken: 'PRIVATE-REFRESH',
      expiresAt: Date.now() + 3600000,
    });
    const metadata = await vault.list();
    assert.equal(metadata[0].connected, true);
    assert.equal(metadata[0].canRefresh, true);
    for (const secret of ['CLIENT-SECRET', 'PRIVATE-ACCESS', 'PRIVATE-REFRESH']) {
      assert.equal(JSON.stringify(metadata).includes(secret), false);
      assert.equal((await readFile(file)).includes(Buffer.from(secret)), false);
    }
    await vault.save({
      id: profile.id,
      name: 'Updated identity',
      kind: 'oauth2',
      allowedOrigin: 'https://api.example.com',
      oauth: { ...config, clientAuth: 'basic', clientSecret: '' },
    });
    const updated = await vault.get(profile.id);
    assert.equal(updated.oauth?.clientSecret, 'CLIENT-SECRET');
    assert.equal(updated.tokens, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
