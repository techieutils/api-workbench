import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialVault,
  credentialHeaders,
  credentialQuery,
  credentialSigning,
  credentialSummary,
  validateCredential,
  type SecretStorage,
} from './credentials';
import { requestOAuthToken } from './oauth';
import { authorizeProtocol } from './protocol-auth';
import type { CredentialInput, CredentialRecord } from '@techieutils/api-workbench-common/types';
import {
  VAULT_LOCKED,
  VAULT_NO_KEYRING,
  VAULT_UNAVAILABLE,
  vaultIssue,
  vaultLocked,
  vaultUnavailable,
} from '@techieutils/api-workbench-common/vault-messages';

const base = { name: 'Profile', allowedOrigin: 'https://api.example.com' };
const record = (input: Partial<CredentialRecord>): CredentialRecord =>
  ({ id: 'id', updatedAt: '', ...base, kind: 'bearer', ...input }) as CredentialRecord;
const request = { id: 'r', url: 'https://api.example.com/x', method: 'GET', headers: {}, body: '' };

test('vault accepts every request auth type and validates their settings', () => {
  const valid: CredentialInput[] = [
    { ...base, kind: 'digest', username: 'u', secret: 'p' },
    {
      ...base,
      kind: 'aws',
      username: 'AKID',
      secret: 's',
      extraSecret: 'session',
      options: { awsRegion: 'us-east-1', awsService: 'execute-api' },
    },
    {
      ...base,
      kind: 'oauth1',
      username: 'ck',
      secret: 'cs',
      extraSecret: 'ts',
      options: { oauth1Token: 't', oauth1SignatureMethod: 'HMAC-SHA256' },
    },
    {
      ...base,
      kind: 'jwt',
      secret: 'key',
      options: { jwtAlgorithm: 'HS512', jwtPayload: '{"sub":"svc"}', jwtExpiresIn: '60' },
    },
    {
      ...base,
      kind: 'api-key',
      headerName: 'api_key',
      secret: 'k',
      options: { apiKeyIn: 'query' },
    },
    { ...base, kind: 'ntlm', username: 'DOMAIN\\u', secret: 'p', options: { ntlmDomain: 'D' } },
    { ...base, kind: 'wsse', username: 'u', secret: 'p' },
    {
      ...base,
      kind: 'edgegrid',
      username: 'akab-client',
      secret: 'cs',
      extraSecret: 'akab-access',
      options: { edgegridMaxBody: '1024', edgegridHeadersToSign: 'X-A' },
    },
    {
      ...base,
      kind: 'hawk',
      username: 'id',
      secret: 'key',
      options: { hawkAlgorithm: 'sha1', hawkPayloadHash: true },
    },
  ];
  for (const input of valid) assert.doesNotThrow(() => validateCredential(input), input.kind);
  const invalid: [CredentialInput, RegExp][] = [
    [{ ...base, kind: 'digest', secret: 'p' }, /username/],
    [
      { ...base, kind: 'aws', username: 'AKID', secret: 's', options: { awsRegion: 'us-east-1' } },
      /region and service/,
    ],
    [
      {
        ...base,
        kind: 'oauth1',
        username: 'ck',
        secret: 'cs',
        options: { oauth1SignatureMethod: 'RSA-SHA1' as 'PLAINTEXT' },
      },
      /signature method/,
    ],
    [{ ...base, kind: 'jwt', secret: 'k', options: { jwtPayload: '[1]' } }, /JSON object/],
    [
      { ...base, kind: 'jwt', secret: 'k', options: { jwtAlgorithm: 'none' as 'HS256' } },
      /algorithm/,
    ],
    [{ ...base, kind: 'jwt', secret: 'k', options: { jwtExpiresIn: 'soon' } }, /whole number/],
    [{ ...base, kind: 'jwt', options: {} }, /secret/],
    [
      { ...base, kind: 'api-key', secret: 'k', options: { apiKeyIn: 'query' } },
      /query parameter name/,
    ],
    [{ ...base, kind: 'ntlm', secret: 'p' }, /username/],
    [{ ...base, kind: 'wsse', username: 'u' }, /secret/],
    [{ ...base, kind: 'edgegrid', username: 'c', secret: 's' }, /access token/],
    [
      {
        ...base,
        kind: 'edgegrid',
        username: 'c',
        secret: 's',
        extraSecret: 'a',
        options: { edgegridMaxBody: 'big' },
      },
      /whole number/,
    ],
    [{ ...base, kind: 'hawk', secret: 'k' }, /Hawk ID/],
    [
      {
        ...base,
        kind: 'hawk',
        username: 'i',
        secret: 'k',
        options: { hawkAlgorithm: 'md5' as 'sha1' },
      },
      /Hawk algorithm/,
    ],
    [{ ...base, kind: 'kerberos' as 'bearer', secret: 's' }, /Unsupported/],
  ];
  for (const [input, message] of invalid)
    assert.throws(() => validateCredential(input), message, input.kind);
});

test('vault credentials map to headers, query parameters, or request signing', () => {
  assert.deepEqual(
    credentialHeaders(record({ kind: 'digest', username: 'u', secret: 'p' }), request),
    {},
  );
  assert.deepEqual(credentialSigning(record({ kind: 'digest', username: 'u', secret: 'p' })), {
    type: 'digest',
    username: 'u',
    password: 'p',
  });
  assert.deepEqual(
    credentialSigning(
      record({
        kind: 'aws',
        username: 'AKID',
        secret: 's',
        extraSecret: 'tok',
        options: { awsRegion: ' eu-west-1 ', awsService: 's3' },
      }),
    ),
    {
      type: 'aws',
      accessKeyId: 'AKID',
      secretAccessKey: 's',
      sessionToken: 'tok',
      region: 'eu-west-1',
      service: 's3',
    },
  );
  assert.deepEqual(
    credentialSigning(
      record({
        kind: 'oauth1',
        username: 'ck',
        secret: 'cs',
        extraSecret: 'ts',
        options: { oauth1Token: 't', oauth1Realm: 'r' },
      }),
    ),
    {
      type: 'oauth1',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      token: 't',
      tokenSecret: 'ts',
      signatureMethod: 'HMAC-SHA1',
      realm: 'r',
    },
  );
  const jwt = credentialSigning(
    record({
      kind: 'jwt',
      secret: 'k',
      options: { jwtPayload: '{"sub":"svc"}', jwtPrefix: 'JWT', jwtExpiresIn: '30' },
    }),
  );
  assert.deepEqual(jwt, {
    type: 'jwt',
    algorithm: 'HS256',
    secret: 'k',
    secretBase64: false,
    payload: { sub: 'svc' },
    header: {},
    prefix: 'JWT',
    expiresInSeconds: 30,
  });
  const queryKey = record({
    kind: 'api-key',
    headerName: 'api_key',
    secret: 'K',
    options: { apiKeyIn: 'query' },
  });
  assert.deepEqual(credentialHeaders(queryKey, request), {});
  assert.deepEqual(credentialQuery(queryKey), ['api_key', 'K']);
  assert.deepEqual(
    credentialHeaders(record({ kind: 'api-key', headerName: 'X-Key', secret: 'K' }), request),
    { 'X-Key': 'K' },
  );
  assert.equal(credentialSigning(record({ kind: 'bearer', secret: 's' })), undefined);
});

test('summaries never expose secrets and edits keep saved secrets', async () => {
  const summary = credentialSummary(
    record({
      kind: 'aws',
      username: 'AKID',
      secret: 'S',
      extraSecret: 'T',
      options: { awsRegion: 'r', awsService: 's' },
    }),
  );
  assert.equal(summary.hasExtraSecret, true);
  assert.deepEqual(summary.options, { awsRegion: 'r', awsService: 's' });
  assert.ok(!JSON.stringify(summary).includes('"S"') && !JSON.stringify(summary).includes('"T"'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vault-auth-'));
  const storage: SecretStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value).reverse(),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value).reverse().toString(),
      shouldReEncrypt: false,
    }),
    getSelectedStorageBackend: () => 'test',
  };
  try {
    const vault = new CredentialVault(path.join(directory, 'vault.bin'), storage);
    const saved = await vault.save({
      ...base,
      kind: 'oauth1',
      username: 'ck',
      secret: 'CONSUMER-SECRET',
      extraSecret: 'TOKEN-SECRET',
      options: { oauth1Token: 't' },
    });
    await vault.save({
      ...base,
      id: saved.id,
      kind: 'oauth1',
      username: 'ck2',
      options: { oauth1Token: 't2' },
    });
    const edited = await vault.get(saved.id);
    assert.deepEqual(
      [edited.username, edited.secret, edited.extraSecret, edited.options?.oauth1Token],
      ['ck2', 'CONSUMER-SECRET', 'TOKEN-SECRET', 't2'],
    );
    assert.ok(
      !(await readFile(path.join(directory, 'vault.bin'), 'utf8')).includes('TOKEN-SECRET'),
      'secrets are stored encrypted',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('live connections receive vault signing credentials and query API keys', async () => {
  const access = (saved: CredentialRecord) => ({
    unlocked: true,
    get: async () => saved,
    resolve: async (value: CredentialRecord) => value,
  });
  const payload = {
    sessionId: 's',
    protocol: 'websocket' as const,
    url: 'wss://api.example.com/ws?x=1',
    headers: {},
    body: '',
    timeoutMs: 1000,
    credentialId: 'id',
  };
  const signal = new AbortController().signal;
  const aws = await authorizeProtocol(
    payload,
    access(
      record({
        kind: 'aws',
        username: 'AK',
        secret: 'S',
        options: { awsRegion: 'r', awsService: 'execute-api' },
      }),
    ),
    signal,
  );
  assert.deepEqual(aws.signing, {
    type: 'aws',
    accessKeyId: 'AK',
    secretAccessKey: 'S',
    sessionToken: undefined,
    region: 'r',
    service: 'execute-api',
  });
  const query = await authorizeProtocol(
    payload,
    access(
      record({
        kind: 'api-key',
        headerName: 'api_key',
        secret: 'Q',
        options: { apiKeyIn: 'query' },
      }),
    ),
    signal,
  );
  assert.equal(query.url, 'wss://api.example.com/ws?x=1&api_key=Q');
  const grpcPayload = {
    ...payload,
    protocol: 'grpc' as const,
    url: 'api.example.com:443',
    grpc: { proto: '', method: '/a.B/C', tls: true },
  };
  await assert.rejects(
    authorizeProtocol(
      grpcPayload,
      access(
        record({ kind: 'api-key', headerName: 'k', secret: 's', options: { apiKeyIn: 'query' } }),
      ),
      signal,
    ),
    /no query string/,
  );
  const header = await authorizeProtocol(
    payload,
    access(record({ kind: 'api-key', headerName: 'X-Key', secret: 'S' })),
    signal,
  );
  assert.equal(header.headers['x-key'], 'S');
  assert.equal(header.signing, undefined);
});

test('request-level OAuth 2.0 fetches client credentials, password, and refreshed tokens', async () => {
  const seen: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    seen.push({ ...form, authorization: req.headers.authorization || '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: `token-${form.grant_type}`,
        token_type: 'Bearer',
        expires_in: 60,
        ...(form.grant_type === 'password' ? { refresh_token: 'refresh-1' } : {}),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    const signal = new AbortController().signal;
    const noBrowser = async () => assert.fail('no browser expected');
    const client = await requestOAuthToken(
      {
        grantType: 'client_credentials',
        tokenUrl,
        clientId: 'app',
        clientSecret: 'shh',
        clientAuth: 'basic',
        scope: 'read',
      },
      noBrowser,
      signal,
    );
    assert.equal(client.accessToken, 'token-client_credentials');
    assert.ok(client.expiresAt! > Date.now());
    assert.equal(seen[0].authorization, `Basic ${Buffer.from('app:shh').toString('base64')}`);
    assert.equal(seen[0].scope, 'read');
    const password = await requestOAuthToken(
      {
        grantType: 'password',
        tokenUrl,
        clientId: 'app',
        clientSecret: 'shh',
        clientAuth: 'body',
        username: 'ada',
        password: 'pw',
      },
      noBrowser,
      signal,
    );
    assert.deepEqual(
      [password.accessToken, password.refreshToken, seen[1].username, seen[1].client_secret],
      ['token-password', 'refresh-1', 'ada', 'shh'],
    );
    const refreshed = await requestOAuthToken(
      {
        grantType: 'refresh_token',
        tokenUrl,
        clientId: 'app',
        clientAuth: 'none',
        refreshToken: 'refresh-1',
      },
      noBrowser,
      signal,
    );
    assert.deepEqual(
      [refreshed.accessToken, refreshed.refreshToken, seen[2].refresh_token],
      ['token-refresh_token', 'refresh-1', 'refresh-1'],
      'the previous refresh token is kept when none is returned',
    );
    await assert.rejects(
      requestOAuthToken(
        { grantType: 'client_credentials', tokenUrl, clientId: 'app', clientAuth: 'none' },
        noBrowser,
        signal,
      ),
      /client secret/,
    );
    await assert.rejects(
      requestOAuthToken(
        { grantType: 'refresh_token', tokenUrl, clientId: 'app', clientAuth: 'none' },
        noBrowser,
        signal,
      ),
      /No refresh token/,
    );
    await assert.rejects(
      requestOAuthToken(
        {
          grantType: 'client_credentials',
          tokenUrl: 'http://example.com/token',
          clientId: 'app',
          clientSecret: 's',
          clientAuth: 'basic',
        },
        noBrowser,
        signal,
      ),
      /HTTPS/,
    );
    await assert.rejects(
      requestOAuthToken(
        { grantType: 'implicit' as 'password', tokenUrl, clientId: 'app', clientAuth: 'none' },
        noBrowser,
        signal,
      ),
      /grant type/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('vault errors are worded so screens can offer to unlock the vault', async () => {
  const locked = vaultLocked('send this request with its saved credential');
  assert.equal(locked, `${VAULT_LOCKED} Unlock it to send this request with its saved credential.`);
  assert.equal(vaultIssue(locked), 'locked');
  assert.equal(vaultIssue(`Error: ${locked}`), 'locked', 'a prefixed message is still recognized');
  assert.equal(vaultIssue('ECONNREFUSED 127.0.0.1:443'), undefined);
  assert.equal(vaultIssue(undefined), undefined);
  await assert.rejects(
    authorizeProtocol(
      {
        sessionId: 's',
        protocol: 'websocket',
        url: 'wss://api.example.com',
        headers: {},
        body: '',
        timeoutMs: 1000,
        credentialId: 'id',
      } as never,
      { unlocked: false, get: async () => record({}), resolve: async (value) => value },
      new AbortController().signal,
    ),
    (error: Error) => vaultIssue(error.message) === 'locked',
    'live connections report a locked vault the same way',
  );
  // A keychain that refuses to decrypt the vault reads as a denial, not a generic failure.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vault-denied-'));
  try {
    const storage: SecretStorage = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async () => {
        throw new Error('User canceled the operation.');
      },
      getSelectedStorageBackend: () => 'test',
    };
    const vault = new CredentialVault(path.join(directory, 'vault.enc'), storage);
    await writeFile(path.join(directory, 'vault.enc'), 'encrypted');
    await assert.rejects(vault.list(), (error: Error) => vaultIssue(error.message) === 'denied');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unavailable OS encryption asks for a restart, and the vault opens once it is available', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vault-unavailable-'));
  try {
    let available = false;
    const storage = (backend: string): SecretStorage => ({
      isAsyncEncryptionAvailable: async () => available,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async (value) => ({
        result: value.toString(),
        shouldReEncrypt: false,
      }),
      getSelectedStorageBackend: () => backend,
    });
    const vault = new CredentialVault(
      path.join(directory, 'vault.enc'),
      storage('gnome_libsecret'),
    );
    await assert.rejects(
      vault.list(),
      (error: Error) =>
        vaultIssue(error.message) === 'unavailable' && /restart API Workbench/.test(error.message),
    );
    // The keychain is checked again on the next attempt: once it is unlocked, the vault opens.
    available = true;
    assert.deepEqual(await vault.list(), []);
    const noKeyring = new CredentialVault(path.join(directory, 'other.enc'), storage('basic_text'));
    assert.equal((await noKeyring.status()).available, false);
    await assert.rejects(
      noKeyring.list(),
      (error: Error) => vaultIssue(error.message) === 'restart',
    );
    assert.equal(vaultUnavailable('basic_text'), VAULT_NO_KEYRING);
    assert.equal(vaultIssue(VAULT_UNAVAILABLE), 'unavailable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('NTLM, WSSE, EdgeGrid, and Hawk vault credentials sign requests', () => {
  for (const kind of ['ntlm', 'wsse', 'edgegrid', 'hawk'] as const)
    assert.deepEqual(credentialHeaders(record({ kind, username: 'u', secret: 's' }), request), {});
  assert.deepEqual(
    credentialSigning(
      record({
        kind: 'ntlm',
        username: 'u',
        secret: 'p',
        options: { ntlmDomain: ' CORP ', ntlmWorkstation: '' },
      }),
    ),
    { type: 'ntlm', username: 'u', password: 'p', domain: 'CORP', workstation: undefined },
  );
  assert.deepEqual(credentialSigning(record({ kind: 'wsse', username: 'u', secret: 'p' })), {
    type: 'wsse',
    username: 'u',
    password: 'p',
  });
  assert.deepEqual(
    credentialSigning(
      record({
        kind: 'edgegrid',
        username: 'ct',
        secret: 'cs',
        extraSecret: 'at',
        options: { edgegridHeadersToSign: 'X-A, ,X-B', edgegridMaxBody: '2048' },
      }),
    ),
    {
      type: 'edgegrid',
      clientToken: 'ct',
      clientSecret: 'cs',
      accessToken: 'at',
      headersToSign: ['X-A', 'X-B'],
      maxBody: 2048,
    },
  );
  assert.deepEqual(
    credentialSigning(
      record({
        kind: 'hawk',
        username: 'id',
        secret: 'key',
        options: { hawkAlgorithm: 'sha1', hawkExt: 'e', hawkPayloadHash: true },
      }),
    ),
    {
      type: 'hawk',
      id: 'id',
      key: 'key',
      algorithm: 'sha1',
      ext: 'e',
      app: undefined,
      dlg: undefined,
      includePayloadHash: true,
    },
  );
});
