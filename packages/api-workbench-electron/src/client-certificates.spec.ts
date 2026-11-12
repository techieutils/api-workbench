import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import type { TLSSocket } from 'node:tls';
import {
  checkedCertificatePayload,
  hostMatches,
  matchClientCertificate,
  normalizeHostPattern,
  sanitizeClientCertificates,
  type ClientCertificate,
} from '@techieutils/api-workbench-common/client-certificates';
import { loadClientCertificate } from './client-certificates';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import { createTLSFixture } from './testing/tls-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialVault,
  credentialHeaders,
  validateCredential,
  type SecretStorage,
} from './credentials';
import { prepareCertificateCredential, vaultCertificate } from './vault-certificates';
import type { CredentialInput } from '@techieutils/api-workbench-common/types';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { startProtocol } from './protocols';
import type { ProtocolEvent } from '@techieutils/api-workbench-common/types';

const entry = (host: string, extra: Partial<ClientCertificate> = {}): ClientCertificate => ({
  id: host,
  host,
  enabled: true,
  type: 'pem',
  certPath: '/c.pem',
  keyPath: '/k.pem',
  ...extra,
});

test('client certificates match hosts, wildcards, ports, and HTTPS only', () => {
  assert.equal(normalizeHostPattern(' https://API.Example.com:8443/path '), 'api.example.com');
  assert.ok(hostMatches('*.example.com', 'a.b.example.com'));
  assert.ok(!hostMatches('*.example.com', 'example.com'));
  assert.ok(!hostMatches('example.com', 'evil-example.com'));
  const list = [
    entry('*.example.com', { id: 'wild' }),
    entry('api.example.com', { id: 'exact' }),
    entry('api.example.com', { id: 'port', port: 8443 }),
    entry('off.example.com', { id: 'off', enabled: false }),
  ];
  assert.equal(matchClientCertificate(list, 'https://api.example.com/x')?.id, 'exact');
  assert.equal(matchClientCertificate(list, 'https://api.example.com:8443/x')?.id, 'port');
  assert.equal(matchClientCertificate(list, 'https://other.example.com/')?.id, 'wild');
  assert.equal(
    matchClientCertificate(list, 'https://off.example.com/')?.id,
    'wild',
    'disabled entries are skipped',
  );
  assert.equal(
    matchClientCertificate(list, 'http://api.example.com/'),
    undefined,
    'plain HTTP never presents certificates',
  );
  assert.equal(matchClientCertificate(list, 'https://example.org/'), undefined);
  assert.equal(
    matchClientCertificate([entry('localhost', { port: 443 })], 'https://localhost/')?.host,
    'localhost',
    'default HTTPS port is 443',
  );
});

test('certificate payloads and saved entries are validated', () => {
  assert.throws(() => checkedCertificatePayload({ type: 'pem', certPath: '/c' }), /files again/);
  assert.throws(() => checkedCertificatePayload({ type: 'jks', pfxPath: '/x' }), /type/);
  assert.throws(() => checkedCertificatePayload({ type: 'pfx', pfxPath: 'a\0b' }), /files again/);
  assert.deepEqual(checkedCertificatePayload({ type: 'pfx', pfxPath: '/x.p12', passphrase: 'p' }), {
    type: 'pfx',
    pfxPath: '/x.p12',
    passphrase: 'p',
  });
  const saved = sanitizeClientCertificates([
    { host: 'HTTPS://Api.Example.com/', type: 'pem', port: 99999, certPath: '/c' },
    { host: 'bad host!', type: 'pem' },
    null,
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].host, 'api.example.com');
  assert.equal(saved[0].port, undefined);
  assert.equal(saved[0].enabled, true);
});

test('mutual TLS works with PEM and PFX certificates and reports clear errors', async () => {
  const fixture = await createTLSFixture();
  const server = createServer(
    {
      key: fixture.key,
      cert: fixture.cert + fixture.ca,
      ca: fixture.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) =>
      res.end(
        JSON.stringify({ client: (req.socket as TLSSocket).getPeerCertificate().subject?.CN }),
      ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const send = (clientCertificate?: object) =>
      sendHttpRequest(
        {
          id: 'mtls',
          url,
          method: 'GET',
          headers: {},
          body: '',
          httpSettings: { caCertificates: fixture.ca },
          clientCertificate,
        } as never,
        new AbortController(),
      );
    const missing = await send();
    assert.ok(missing.error, 'servers that require a certificate reject requests without one');
    const pem = await send({
      type: 'pem',
      certPath: fixture.clientCertPath,
      keyPath: fixture.clientKeyPath,
    });
    assert.equal(pem.status, 200, String(pem.error));
    assert.equal(JSON.parse(pem.body!).client, 'workbench-client');
    assert.match(pem.tls?.clientCertificate?.subject || '', /CN=workbench-client/);
    const pfx = await send({
      type: 'pfx',
      pfxPath: fixture.clientPfxPath,
      passphrase: 'p12-secret',
    });
    assert.equal(pfx.status, 200, String(pfx.error));
    assert.match(
      pfx.tls?.clientCertificate?.subject || '',
      /CN=workbench-client/,
      'PFX leaf certificate details are read',
    );
    assert.match(
      (await send({ type: 'pfx', pfxPath: fixture.clientPfxPath, passphrase: 'wrong' })).error ||
        '',
      /passphrase is incorrect/,
    );
    assert.match(
      (
        await send({
          type: 'pem',
          certPath: fixture.clientCertPath,
          keyPath: fixture.serverKeyPath,
        })
      ).error || '',
      /does not match/,
    );
    assert.match(
      (await send({ type: 'pem', certPath: '/missing/client.pem', keyPath: fixture.clientKeyPath }))
        .error || '',
      /Cannot read the certificate file client\.pem/,
    );
    const details = await loadClientCertificate({
      type: 'pem',
      certPath: fixture.clientCertPath,
      keyPath: fixture.clientKeyPath,
    });
    assert.match(details.issuer || '', /API Workbench Test Root/);
    assert.ok(new Date(details.validTo!).getTime() > Date.now());
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.dispose();
  }
});

test('WebSocket, SSE, and TLS gRPC present client certificates to servers that require them', async () => {
  const fixture = await createTLSFixture();
  const proto =
    'syntax = "proto3"; package mtls; service Who { rpc Ask (Empty) returns (Reply); } message Empty {} message Reply { string client = 1; }';
  const https = createServer(
    {
      key: fixture.key,
      cert: fixture.cert + fixture.ca,
      ca: fixture.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${(req.socket as TLSSocket).getPeerCertificate().subject?.CN}\n\n`);
    },
  );
  const sockets = new WebSocketServer({ server: https });
  sockets.on('connection', (socket, req) =>
    socket.send(String((req.socket as TLSSocket).getPeerCertificate().subject?.CN)),
  );
  https.listen(0, '127.0.0.1');
  await once(https, 'listening');
  const rpc = new grpc.Server();
  rpc.addService(
    loader.fromJSON(parse(proto).root.toJSON())['mtls.Who'] as grpc.ServiceDefinition,
    {
      ask: (call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>) =>
        callback(null, {
          client: call.getAuthContext().sslPeerCertificate?.subject?.CN || 'unknown',
        }),
    },
  );
  const grpcPort = await new Promise<number>((resolve, reject) =>
    rpc.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createSsl(
        Buffer.from(fixture.ca),
        [{ private_key: Buffer.from(fixture.key), cert_chain: Buffer.from(fixture.cert) }],
        true,
      ),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
  const port = (https.address() as { port: number }).port;
  const pem = await loadClientCertificate({
    type: 'pem',
    certPath: fixture.clientCertPath,
    keyPath: fixture.clientKeyPath,
  });
  const pfx = await loadClientCertificate({
    type: 'pfx',
    pfxPath: fixture.clientPfxPath,
    passphrase: 'p12-secret',
  });
  const run = (input: object, certificate?: Awaited<ReturnType<typeof loadClientCertificate>>) => {
    const events: ProtocolEvent[] = [];
    const session = startProtocol(
      {
        sessionId: crypto.randomUUID(),
        protocol: 'sse',
        url: '',
        headers: {},
        body: '{}',
        timeoutMs: 4000,
        httpSettings: { caCertificates: fixture.ca },
        ...input,
      } as never,
      (event: ProtocolEvent) => events.push(event),
      certificate,
    );
    const until = async (predicate: (event: { type: string; data: string }) => boolean) => {
      const deadline = Date.now() + 5000;
      while (!events.some(predicate)) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(events)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return events.find(predicate)!;
    };
    return { events, session, until };
  };
  try {
    const ws = run({ protocol: 'websocket', url: `wss://127.0.0.1:${port}/` }, pem);
    assert.equal(
      (await ws.until((event) => event.type === 'message')).data,
      'workbench-client',
      'wss:// presents the PEM certificate',
    );
    assert.ok(
      ws.events.some(
        (event) => event.type === 'status' && event.data.includes('CN=workbench-client'),
      ),
      'the timeline names the presented certificate',
    );
    ws.session.stop();
    const wsMissing = run({ protocol: 'websocket', url: `wss://127.0.0.1:${port}/` });
    await wsMissing.until((event) => event.type === 'closed');
    assert.ok(
      wsMissing.events.some((event) => event.type === 'error'),
      'wss:// without a certificate is rejected',
    );
    const sse = run({ protocol: 'sse', url: `https://127.0.0.1:${port}/` }, pfx);
    assert.equal(
      (await sse.until((event) => event.type === 'message')).data,
      'workbench-client',
      'HTTPS SSE presents the PFX certificate',
    );
    await sse.until((event) => event.type === 'closed');
    const call = run(
      {
        protocol: 'grpc',
        url: `localhost:${grpcPort}`,
        grpc: { proto, method: '/mtls.Who/Ask', tls: true },
      },
      pfx,
    );
    assert.equal(
      JSON.parse((await call.until((event) => event.type === 'message')).data).client,
      'workbench-client',
      'TLS gRPC presents a PFX certificate',
    );
    const grpcMissing = run({
      protocol: 'grpc',
      url: `localhost:${grpcPort}`,
      grpc: { proto, method: '/mtls.Who/Ask', tls: true },
    });
    assert.ok(
      (await grpcMissing.until((event) => event.type === 'error')).data,
      'TLS gRPC without a certificate is rejected',
    );
  } finally {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    https.closeAllConnections();
    await new Promise<void>((resolve) => https.close(() => resolve()));
    rpc.forceShutdown();
    await closeHTTPTransports();
    await fixture.dispose();
  }
});

test('client certificates are copied into the vault and presented from it', async () => {
  const fixture = await createTLSFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vault-cert-'));
  const storage: SecretStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value).reverse(),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value).reverse().toString(),
      shouldReEncrypt: false,
    }),
    getSelectedStorageBackend: () => 'test',
  };
  const vault = new CredentialVault(path.join(directory, 'vault.json'), storage);
  const server = createServer(
    {
      key: fixture.key,
      cert: fixture.cert + fixture.ca,
      ca: fixture.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) =>
      res.end(
        JSON.stringify({ client: (req.socket as TLSSocket).getPeerCertificate().subject?.CN }),
      ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const url = `https://127.0.0.1:${port}/`;
    const input = (overrides: Partial<CredentialInput>): CredentialInput => ({
      name: 'Partner mTLS',
      kind: 'client-certificate',
      allowedOrigin: '',
      clientCertificate: { type: 'pem', host: ' 127.0.0.1 ' },
      certificateFiles: { certPath: fixture.clientCertPath, keyPath: fixture.clientKeyPath },
      ...overrides,
    });
    const summary = await vault.save(await prepareCertificateCredential(input({})));
    assert.equal(summary.allowedOrigin, 'https://127.0.0.1');
    assert.match(summary.clientCertificate?.subject || '', /CN=workbench-client/);
    assert.equal(
      JSON.stringify(summary).includes('PRIVATE KEY'),
      false,
      'summaries carry no key material',
    );
    assert.equal('certPem' in (summary.clientCertificate || {}), false);
    const record = await vault.get(summary.id);
    assert.match(record.secret || '', /PRIVATE KEY/, 'the key itself is stored, not its path');
    assert.equal(
      JSON.stringify(record).includes(fixture.clientKeyPath),
      false,
      'file paths are not stored',
    );
    const send = (certificate: ReturnType<typeof vaultCertificate>) =>
      sendHttpRequest(
        {
          id: 'vault-mtls',
          url,
          method: 'GET',
          headers: {},
          body: '',
          httpSettings: { caCertificates: fixture.ca },
          clientCertificate: { credentialId: summary.id },
        } as never,
        new AbortController(),
        undefined,
        certificate,
      );
    const pem = await send(vaultCertificate(record, url));
    assert.equal(pem.status, 200, String(pem.error));
    assert.equal(JSON.parse(pem.body!).client, 'workbench-client');
    assert.match(
      (
        await sendHttpRequest(
          {
            id: 'unresolved',
            url,
            method: 'GET',
            headers: {},
            body: '',
            clientCertificate: { credentialId: summary.id },
          } as never,
          new AbortController(),
        )
      ).error || '',
      /credential vault is locked/,
      'a vault reference is never sent unresolved',
    );
    assert.throws(
      () => vaultCertificate(record, 'https://other.example/'),
      /restricted to https:\/\/127\.0\.0\.1/,
    );
    assert.throws(
      () =>
        vaultCertificate(
          { ...record, clientCertificate: { ...record.clientCertificate!, port: 1 } },
          url,
        ),
      /restricted to https:\/\/127\.0\.0\.1:1/,
    );

    // PFX bundles keep their passphrase in the vault; a wrong one is rejected before saving.
    await assert.rejects(
      prepareCertificateCredential(
        input({
          clientCertificate: { type: 'pfx', host: '127.0.0.1' },
          certificateFiles: { pfxPath: fixture.clientPfxPath },
          extraSecret: 'wrong',
        }),
      ),
      /passphrase is incorrect/,
    );
    const pfxSummary = await vault.save(
      await prepareCertificateCredential(
        input({
          clientCertificate: { type: 'pfx', host: '*.0.0.1', port },
          certificateFiles: { pfxPath: fixture.clientPfxPath },
          extraSecret: 'p12-secret',
        }),
      ),
    );
    const pfx = await vault.get(pfxSummary.id);
    assert.equal(pfx.extraSecret, 'p12-secret');
    // Renaming keeps the stored bundle and passphrase without choosing the file again.
    const renamed = await prepareCertificateCredential(
      {
        ...input({ clientCertificate: { type: 'pfx', host: '*.0.0.1', port } }),
        id: pfx.id,
        name: 'Renamed',
        certificateFiles: undefined,
      },
      pfx,
    );
    assert.equal(renamed.secret, pfx.secret);
    assert.equal(renamed.extraSecret, 'p12-secret');
    await assert.rejects(
      prepareCertificateCredential(input({ certificateFiles: undefined })),
      /Choose a certificate and its private key/,
    );
    assert.throws(
      () => credentialHeaders(record, { id: 'r', url, method: 'GET', headers: {}, body: '' }),
      /presented automatically/,
    );
    assert.throws(
      () =>
        validateCredential({
          ...record,
          clientCertificate: { ...record.clientCertificate!, host: 'bad host!' },
        }),
      /Enter a host/,
    );
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
