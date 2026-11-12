import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  AUTHORITY_DAYS,
  coversHost,
  createAuthority,
  normalizeDomains,
  isLongLived,
  issueCertificate,
  needsRenewal,
  CA_NAME,
} from './interceptor-ca';
import { AuthorityStore, BODY_LIMIT, Interceptor } from './interceptor';
import type { InterceptorCapture } from '@techieutils/api-workbench-common/types';

const storage = (available = true) => ({
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (value: string) => Buffer.from(`sealed:${value}`),
  decryptStringAsync: async (value: Buffer) => ({
    result: value.toString().replace(/^sealed:/, ''),
    shouldReEncrypt: false,
  }),
  getSelectedStorageBackend: () => 'test',
});
async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
/** An HTTPS origin whose certificate comes from its own CA, which the Interceptor is told to trust upstream. */
async function origin(handler: http.RequestListener) {
  const authority = createAuthority();
  const issued = issueCertificate(authority, 'localhost');
  const server = https
    .createServer({ cert: issued.cert, key: issued.key }, handler)
    .listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as net.AddressInfo).port, ca: authority.certPem };
}
async function setup(options: { available?: boolean; upstreamCA?: string[] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interceptor-'));
  const captures = new Map<string, InterceptorCapture>();
  const authorities = new AuthorityStore(directory, storage(options.available));
  const interceptor = new Interceptor({
    authorities,
    upstreamCA: options.upstreamCA,
    publish: (capture) => captures.set(capture.id, structuredClone(capture)),
  });
  const done = async (count = 1) => {
    for (
      let attempt = 0;
      attempt < 100 && [...captures.values()].filter((capture) => capture.done).length < count;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    return [...captures.values()].filter((capture) => capture.done);
  };
  return {
    directory,
    captures,
    authorities,
    interceptor,
    done,
    cleanup: async () => {
      await interceptor.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
/** Sends a request through the proxy the way an HTTP client configured with it would. */
function viaProxy(
  port: number,
  url: string,
  init: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, method: init.method || 'GET', path: url, headers: init.headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(init.body);
    },
  );
}
/** Opens a CONNECT tunnel and speaks TLS through it, trusting `ca`. */
async function viaTunnel(port: number, target: string, ca: string | undefined, path = '/') {
  const connect = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
  connect.end();
  const [response, socket] = (await once(connect, 'connect')) as [http.IncomingMessage, net.Socket];
  assert.equal(response.statusCode, 200);
  const secure = tls.connect({ socket, servername: 'localhost', ...(ca ? { ca } : {}) });
  await once(secure, 'secureConnect');
  secure.write(`GET ${path} HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  for await (const chunk of secure) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

test('plain HTTP is forwarded and captured with headers and decoded bodies', async () => {
  const upstream = http
    .createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        if (request.url === '/gzip') {
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          });
          response.end(gzipSync(JSON.stringify({ zipped: true })));
          return;
        }
        response.writeHead(201, {
          'Content-Type': 'application/json',
          'X-Proxy-Auth-Seen': String(Boolean(request.headers['proxy-authorization'])),
        });
        response.end(JSON.stringify({ echoed: body, path: request.url }));
      });
    })
    .listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const { interceptor, done, cleanup } = await setup();
  try {
    const port = await freePort();
    const status = await interceptor.start(port, false);
    assert.equal(status.running, true);
    const reply = await viaProxy(port, `http://127.0.0.1:${upstreamPort}/users?id=7`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Proxy-Authorization': 'Basic c2VjcmV0',
        'Proxy-Connection': 'keep-alive',
      },
      body: '{"name":"Ada"}',
    });
    assert.equal(reply.status, 201);
    assert.deepEqual(JSON.parse(reply.body), { echoed: '{"name":"Ada"}', path: '/users?id=7' });
    assert.equal(
      reply.headers['x-proxy-auth-seen'],
      'false',
      'proxy credentials are not forwarded upstream',
    );
    const [capture] = await done();
    assert.equal(capture.scheme, 'http');
    assert.equal(capture.method, 'POST');
    assert.equal(capture.url, `http://127.0.0.1:${upstreamPort}/users?id=7`);
    assert.equal(capture.status, 201);
    assert.equal(capture.requestBody, '{"name":"Ada"}');
    assert.equal(capture.requestBodyEncoding, 'utf8');
    assert.match(capture.responseBody!, /"echoed"/);
    assert.ok(capture.requestHeaders.some(([key]) => key === 'Content-Type'));
    assert.ok(capture.durationMs! >= 0);
    const zipped = await viaProxy(port, `http://127.0.0.1:${upstreamPort}/gzip`);
    assert.equal(
      zipped.headers['content-encoding'],
      'gzip',
      'the client still receives the encoded bytes',
    );
    const [, gzipCapture] = await done(2);
    assert.equal(gzipCapture.responseBody, '{"zipped":true}', 'the capture shows the decoded body');
  } finally {
    await cleanup();
    upstream.close();
  }
});

test('HTTPS is decrypted with a host certificate from the trusted Interceptor CA', async () => {
  const site = await origin((request, response) =>
    response.end(`secure ${request.method} ${request.url}`),
  );
  // The origin's own CA is trusted upstream, as a system trust store would be.
  const { interceptor, authorities, done, cleanup, directory } = await setup({
    upstreamCA: [site.ca],
  });
  try {
    const port = await freePort();
    const status = await interceptor.start(port, true);
    assert.equal(status.authority?.subject, CA_NAME);
    assert.equal(status.authority?.path, authorities.certificatePath);
    const ca = await readFile(authorities.certificatePath, 'utf8');
    assert.ok(new X509Certificate(ca).ca, 'the saved certificate is the CA');
    const saved = await readFile(path.join(directory, 'authority.json'), 'utf8');
    assert.doesNotMatch(saved, /BEGIN PRIVATE KEY/, 'the CA key is stored encrypted');
    if (process.platform !== 'win32')
      assert.equal((await stat(path.join(directory, 'authority.json'))).mode & 0o777, 0o600);
    const reply = await viaTunnel(port, `localhost:${site.port}`, ca, '/orders?page=2');
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /secure GET \/orders\?page=2/);
    const [capture] = await done();
    assert.equal(capture.scheme, 'https');
    assert.equal(capture.url, `https://localhost:${site.port}/orders?page=2`);
    assert.equal(capture.status, 200);
    assert.equal(capture.responseBody, 'secure GET /orders?page=2');
    // The same CA is reused after a restart of the proxy.
    const again = await interceptor.start(port, true);
    assert.equal(again.authority?.fingerprint, status.authority?.fingerprint);
    // A reset issues a new CA.
    const reset = await interceptor.resetAuthority();
    assert.notEqual(reset.authority?.fingerprint, status.authority?.fingerprint);
  } finally {
    await cleanup();
    site.server.close();
  }
});

test('a client that does not trust the CA is reported, and tunnels pass HTTPS through unread', async () => {
  const site = await origin((_request, response) => response.end('tunnelled'));
  const { interceptor, captures, done, cleanup } = await setup({ upstreamCA: [site.ca] });
  try {
    const port = await freePort();
    await interceptor.start(port, true);
    await assert.rejects(viaTunnel(port, `localhost:${site.port}`, undefined));
    const [rejected] = await done();
    assert.equal(rejected.method, 'CONNECT');
    assert.match(rejected.error!, /did not accept the Interceptor certificate/);
    captures.clear();
    // Decryption off: the client talks TLS to the origin itself.
    await interceptor.start(port, false);
    const reply = await viaTunnel(port, `localhost:${site.port}`, site.ca);
    assert.match(reply, /tunnelled/);
    const [tunnel] = await done();
    assert.equal(tunnel.scheme, 'tunnel');
    assert.equal(tunnel.url, `https://localhost:${site.port}`);
    assert.ok(tunnel.bytesSent! > 0 && tunnel.bytesReceived! > 0);
    assert.equal(tunnel.responseBody, undefined, 'tunnelled traffic is not read');
  } finally {
    await cleanup();
    site.server.close();
  }
});

test('without OS encryption the CA is not created and HTTPS is tunnelled', async () => {
  const site = await origin((_request, response) => response.end('plain tunnel'));
  const { interceptor, done, cleanup, authorities } = await setup({
    available: false,
    upstreamCA: [site.ca],
  });
  try {
    const port = await freePort();
    const status = await interceptor.start(port, true);
    assert.equal(status.authority, undefined);
    assert.match(status.authorityError!, /OS-backed encryption is unavailable/);
    await assert.rejects(readFile(authorities.certificatePath));
    assert.match(await viaTunnel(port, `localhost:${site.port}`, site.ca), /plain tunnel/);
    assert.equal((await done())[0].scheme, 'tunnel');
  } finally {
    await cleanup();
    site.server.close();
  }
});

test('recording can pause, large bodies are truncated, and errors are reported', async () => {
  const big = 'x'.repeat(BODY_LIMIT + 10);
  const upstream = http
    .createServer((_request, response) => response.end(big))
    .listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const { interceptor, captures, done, cleanup } = await setup();
  try {
    const port = await freePort();
    await interceptor.start(port, false);
    await interceptor.setRecording(false);
    assert.equal(
      (await viaProxy(port, `http://127.0.0.1:${upstreamPort}/`)).body.length,
      big.length,
    );
    assert.equal(captures.size, 0, 'nothing is recorded while paused');
    await interceptor.setRecording(true);
    assert.equal(
      (await viaProxy(port, `http://127.0.0.1:${upstreamPort}/`)).body.length,
      big.length,
      'the client gets the whole body',
    );
    const [large] = await done();
    assert.equal(large.truncated, true);
    assert.equal(large.responseBodySize, big.length);
    assert.equal(large.responseBody!.length, BODY_LIMIT);
    const closed = await freePort();
    const failed = await viaProxy(port, `http://127.0.0.1:${closed}/`);
    assert.equal(failed.status, 502);
    const errors = (await done(2)).filter((capture) => capture.error);
    assert.match(errors[0].error!, /refused/);
    assert.equal(
      (await viaProxy(port, `http://127.0.0.1:${port}/`)).status,
      508,
      'requests to the proxy itself are refused',
    );
    assert.equal((await viaProxy(port, '/not-a-proxy-request')).status, 400);
    const other = new Interceptor({
      authorities: new AuthorityStore(os.tmpdir(), storage()),
      publish: () => {},
    });
    await assert.rejects(other.start(port, false), /already in use/);
    await assert.rejects(other.start(80, false), /1024 to 65535/);
  } finally {
    await cleanup();
    upstream.close();
  }
});

test('WebSocket upgrades are relayed through the proxy', async () => {
  const upstream = http.createServer();
  upstream.on('upgrade', (request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const { interceptor, done, cleanup } = await setup();
  try {
    const port = await freePort();
    await interceptor.start(port, false);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: `http://127.0.0.1:${upstreamPort}/socket`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    request.end();
    const [response, socket] = (await once(request, 'upgrade')) as [
      http.IncomingMessage,
      net.Socket,
    ];
    assert.equal(response.statusCode, 101);
    socket.write('ping');
    const [reply] = await once(socket, 'data');
    assert.equal(String(reply), 'echo:ping');
    socket.destroy();
    const [capture] = await done();
    assert.equal(capture.status, 101);
    assert.equal(capture.url, `http://127.0.0.1:${upstreamPort}/socket`);
  } finally {
    await cleanup();
    upstream.close();
  }
});

test('the CA key is encrypted again when the OS key has rotated, and the CA is kept', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interceptor-ca-rotation-'));
  try {
    let rotated = false;
    const sealed = storage();
    const authorities = new AuthorityStore(directory, {
      ...sealed,
      decryptStringAsync: async (value: Buffer) => ({
        ...(await sealed.decryptStringAsync(value)),
        shouldReEncrypt: rotated,
      }),
    });
    const created = await authorities.load();
    const keyFile = path.join(directory, 'authority.json');
    const before = await readFile(keyFile, 'utf8');
    rotated = true;
    const reloaded = await new AuthorityStore(directory, {
      ...sealed,
      encryptStringAsync: async (value: string) => Buffer.from(`resealed:${value}`),
      decryptStringAsync: async (value: Buffer) => ({
        ...(await sealed.decryptStringAsync(value)),
        shouldReEncrypt: rotated,
      }),
    }).load();
    assert.equal(reloaded?.certPem, created?.certPem, 'the same CA is kept');
    const after = await readFile(keyFile, 'utf8');
    assert.notEqual(after, before, 'its key is saved again');
    assert.match(
      Buffer.from(JSON.parse(after).key, 'base64').toString(),
      /^resealed:/,
      'with the current key',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the CA lasts a month, its certificates never outlive it, and it is renewed as it runs out', async () => {
  // A copied key would let someone read this computer's HTTPS traffic for as long as the CA is
  // valid, so it is short-lived (ten years in older versions).
  const day = 86_400_000;
  const now = new Date('2026-01-10T00:00:00Z');
  const authority = createAuthority(now);
  const ca = new X509Certificate(authority.certPem);
  const lasts = (Date.parse(ca.validTo) - now.getTime()) / day;
  assert.ok(Math.abs(lasts - AUTHORITY_DAYS) < 1, `${lasts} days`);
  assert.equal(isLongLived(authority.certPem), false);
  assert.equal(needsRenewal(authority.certPem, now.getTime()), false);
  assert.equal(needsRenewal(authority.certPem, now.getTime() + (AUTHORITY_DAYS - 1) * day), true);
  const leaf = new X509Certificate(issueCertificate(authority, 'api.example.com', now).cert);
  assert.ok(Date.parse(leaf.validTo) <= Date.parse(ca.validTo), 'a leaf never outlives its CA');
  assert.equal(isLongLived(createAuthority(now, 3650).certPem), true, 'an older ten-year CA');

  // The store makes a new CA when the saved one is about to run out.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-ca-renew-'));
  try {
    const store = new AuthorityStore(directory, storage());
    const first = await store.load();
    assert.ok(first);
    assert.equal(await store.load(), first, 'kept while valid');
    const expiring = createAuthority(new Date(Date.now() - (AUTHORITY_DAYS - 1) * day));
    const saved = new AuthorityStore(directory, storage());
    (saved as unknown as { cached: unknown }).cached = expiring;
    const renewed = await saved.load();
    assert.ok(renewed && renewed.certPem !== expiring.certPem, 'replaced before it runs out');
    assert.equal(needsRenewal(renewed.certPem), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a CA limited to some domains vouches for them and this computer, and for no other site', async () => {
  const authority = createAuthority(
    new Date(),
    AUTHORITY_DAYS,
    normalizeDomains(['Example.com', '*.api.test']),
  );
  assert.deepEqual(authority.domains, ['api.test', 'example.com']);
  // The nameConstraints extension's identifier, 2.5.29.30, is in the certificate.
  assert.ok(
    new X509Certificate(authority.certPem).raw.includes(
      Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]),
    ),
  );
  // A real handshake, by a client that trusts only this CA: TLS enforces the constraints.
  const handshake = async (host: string) => {
    const issued = issueCertificate(authority, host);
    const server = tls.createServer({ cert: issued.cert, key: issued.key }, (socket) =>
      socket.end(),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as net.AddressInfo;
    try {
      return await new Promise<string>((resolve) => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port,
          servername: net.isIP(host) ? undefined : host,
          ca: [authority.certPem],
          checkServerIdentity: () => undefined,
        });
        socket.once('secureConnect', () => {
          socket.destroy();
          resolve('ok');
        });
        socket.once('error', (error) => resolve(error.message));
      });
    } finally {
      server.close();
    }
  };
  // As Electron verifies them: local addresses, as HTTPS mocks use, are fine too.
  for (const host of [
    'example.com',
    'www.example.com',
    'v1.api.test',
    'localhost',
    '127.0.0.1',
    '::1',
  ])
    assert.equal(await handshake(host), 'ok', host);
  for (const host of ['evil.com', 'example.com.evil.com', 'api.test.evil.com'])
    assert.match(await handshake(host), /subtree|constraint/i, host);

  assert.equal(coversHost(authority.domains, 'WWW.Example.com.'), true);
  assert.equal(coversHost(authority.domains, '127.0.0.5'), true);
  assert.equal(coversHost(authority.domains, 'evilexample.com'), false);
  assert.equal(coversHost([], 'anything.test'), true, 'unlimited');
  assert.throws(() => normalizeDomains(['https://x.test']), /not a domain name/);
  assert.throws(() => normalizeDomains(['10.0.0.1']), /not a domain name/);
});

test('the saved CA is replaced when the domains change, and keeps them when renewed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-ca-domains-'));
  try {
    const store = new AuthorityStore(directory, storage());
    const limited = await store.load(['example.com']);
    assert.deepEqual(limited?.domains, ['example.com']);
    assert.equal(await store.load(['example.com']), limited, 'the same domains keep it');
    // Read back from disk by another store, with its domains.
    const reread = await new AuthorityStore(directory, storage()).load();
    assert.equal(reread?.certPem, limited?.certPem);
    assert.deepEqual(reread?.domains, ['example.com']);
    const widened = await store.load(['example.com', 'api.test']);
    assert.notEqual(widened?.certPem, limited?.certPem);
    const reset = await store.reset();
    assert.deepEqual(reset?.domains, ['example.com', 'api.test'], 'New certificate keeps them');
    const open = await store.load([]);
    assert.equal(open?.domains, undefined, 'none: any site');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('with domains to decrypt, other hosts pass through as tunnels, unread', async () => {
  const { interceptor, captures, cleanup } = await setup();
  try {
    const port = await freePort();
    const status = await interceptor.start(port, true, ['example.com']);
    assert.deepEqual(status.authority?.domains, ['example.com']);
    // A TLS handshake's first byte (0x16) to a host the CA does not cover: tunnelled, as with
    // decryption off, so it is never shown a certificate it would refuse.
    const connect = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: 'elsewhere.invalid:443',
    });
    connect.end();
    const [, socket] = (await once(connect, 'connect')) as [http.IncomingMessage, net.Socket];
    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]));
    for (let attempt = 0; attempt < 100 && !captures.size; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
    const [capture] = [...captures.values()];
    assert.equal(capture.scheme, 'tunnel');
    assert.equal(capture.url, 'https://elsewhere.invalid');
  } finally {
    await cleanup();
  }
});
