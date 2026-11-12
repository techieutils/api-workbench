import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeProtocol, protocolCredentialURL } from './protocol-auth';
import type { CredentialRecord, ProtocolPayload } from '@techieutils/api-workbench-common/types';
const input = (overrides: Partial<ProtocolPayload> = {}): ProtocolPayload => ({
  sessionId: 'auth-test',
  protocol: 'sse',
  url: 'https://example.com/events',
  headers: {},
  body: '{}',
  timeoutMs: 1000,
  credentialId: 'saved',
  ...overrides,
});
const record = (overrides: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: 'saved',
  name: 'Saved',
  kind: 'bearer',
  secret: 'TEST-TOKEN',
  allowedOrigin: 'https://example.com',
  updatedAt: new Date().toISOString(),
  ...overrides,
});
const signal = () => new AbortController().signal;
function access(saved = record()) {
  return {
    unlocked: true,
    get: async () => saved,
    resolve: async (value: CredentialRecord) => value,
  };
}
test('saved credential origins map WebSocket and gRPC security modes to HTTP(S)', () => {
  assert.equal(
    new URL(protocolCredentialURL(input({ protocol: 'websocket', url: 'wss://example.com/ws' })))
      .origin,
    'https://example.com',
  );
  assert.equal(
    new URL(protocolCredentialURL(input({ protocol: 'websocket', url: 'ws://localhost:4780/ws' })))
      .origin,
    'http://localhost:4780',
  );
  for (const tls of [false, true])
    assert.equal(
      new URL(
        protocolCredentialURL(
          input({ protocol: 'grpc', url: 'localhost:50051', grpc: { proto: '', method: '', tls } }),
        ),
      ).origin,
      `${tls ? 'https' : 'http'}://localhost:50051`,
    );
  assert.throws(
    () => protocolCredentialURL(input({ protocol: 'websocket', url: 'https://example.com' })),
    /protocol URL/,
  );
  assert.throws(
    () => protocolCredentialURL(input({ url: 'https://user:password@example.com' })),
    /embedded/,
  );
});
test('all live protocols receive saved authentication without mutating request headers', async () => {
  for (const protocol of ['sse', 'ndjson', 'websocket', 'grpc'] as const) {
    const payload = input({
      protocol,
      url:
        protocol === 'grpc'
          ? 'example.com:50051'
          : protocol === 'websocket'
            ? 'wss://example.com/ws'
            : 'https://example.com/stream',
      headers: { Authorization: 'old', 'X-Custom': 'value' },
      grpc: { proto: '', method: '', tls: true },
    });
    const authorized = await authorizeProtocol(
      payload,
      access(
        record({
          allowedOrigin: protocol === 'grpc' ? 'https://example.com:50051' : 'https://example.com',
        }),
      ),
      signal(),
    );
    assert.equal(authorized.headers.authorization, 'Bearer TEST-TOKEN');
    assert.equal(authorized.headers['x-custom'], 'value');
    assert.equal(
      Object.keys(authorized.headers).filter((key) => key.toLowerCase() === 'authorization').length,
      1,
    );
    assert.equal(payload.headers.Authorization, 'old');
  }
});
test('Basic, API key and connected OAuth use the existing HTTP credential rules', async () => {
  for (const [saved, key, expected] of [
    [
      record({ kind: 'basic', username: 'alice', secret: 'password' }),
      'authorization',
      `Basic ${Buffer.from('alice:password').toString('base64')}`,
    ],
    [record({ kind: 'api-key', headerName: 'X-API-Key', secret: 'KEY' }), 'x-api-key', 'KEY'],
    [
      record({
        kind: 'oauth2',
        tokens: { accessToken: 'OAUTH-TOKEN', expiresAt: Date.now() + 60000 },
      }),
      'authorization',
      'Bearer OAUTH-TOKEN',
    ],
  ] as const) {
    const authorized = await authorizeProtocol(input(), access(saved), signal());
    assert.equal(authorized.headers[key], expected);
  }
  await assert.rejects(
    authorizeProtocol(input(), access(record({ kind: 'oauth2' })), signal()),
    /Connect this OAuth/,
  );
  await assert.rejects(
    authorizeProtocol(
      input(),
      access(record({ kind: 'oauth2', tokens: { accessToken: 'OLD', expiresAt: 1 } })),
      signal(),
    ),
    /expired/,
  );
});
test('locked vaults and origin mismatches are rejected before remote secret lookup', async () => {
  let resolved = 0;
  const provider = {
    ...access(),
    resolve: async (value: CredentialRecord) => {
      resolved++;
      return value;
    },
  };
  await assert.rejects(
    authorizeProtocol(input(), { ...provider, unlocked: false }, signal()),
    /credential vault is locked/,
  );
  await assert.rejects(
    authorizeProtocol(input({ url: 'https://other.example.com/events' }), provider, signal()),
    /restricted/,
  );
  await assert.rejects(
    authorizeProtocol(
      input({ protocol: 'websocket', url: 'ws://example.com/ws' }),
      provider,
      signal(),
    ),
    /restricted/,
  );
  assert.equal(resolved, 0);
});
test('cancelled credential lookups cannot inject headers or open a connection', async () => {
  const controller = new AbortController();
  const provider = {
    ...access(),
    resolve: async (value: CredentialRecord) => {
      controller.abort();
      return value;
    },
  };
  await assert.rejects(authorizeProtocol(input(), provider, controller.signal), /abort/i);
});
test('anonymous requests never access the vault', async () => {
  const payload = input({ credentialId: undefined });
  const forbidden = async (): Promise<CredentialRecord> => {
    throw new Error('Vault should not be accessed');
  };
  assert.equal(
    await authorizeProtocol(
      payload,
      { unlocked: false, get: forbidden, resolve: forbidden },
      signal(),
    ),
    payload,
  );
});
