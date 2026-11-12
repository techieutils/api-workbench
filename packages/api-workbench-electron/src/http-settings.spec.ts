import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import {
  resolve,
  inherit,
  overrides,
  workspaceDefaults,
  payloadSettings,
  collectionOverrides,
} from '@techieutils/api-workbench-common/http-settings';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import { createTLSFixture } from './testing/tls-fixture';
import type { RequestPayload } from '@techieutils/api-workbench-common/types';
let fixture: Awaited<ReturnType<typeof createTLSFixture>>;
before(async () => {
  fixture = await createTLSFixture();
});
after(async () => {
  await closeHTTPTransports();
  await fixture.dispose();
});
const request = (
  url: string,
  httpSettings: RequestPayload['httpSettings'] = {},
): RequestPayload => ({
  id: 'http-settings',
  method: 'GET',
  url,
  headers: {},
  body: '',
  httpSettings,
});
test('HTTP settings inherit per field and preserve explicit false, zero, and empty overrides', () => {
  const workspace = workspaceDefaults({
    timeoutMs: 2400,
    followRedirects: false,
    httpSettings: { httpVersion: 'auto', tlsCiphers: 'CUSTOM', verifyTLS: true },
  });
  const result = resolve(
    workspace,
    { timeoutMs: 1500, maxRedirects: 0 },
    { timeoutMs: 1200, verifyTLS: false, tlsCiphers: '' },
  );
  assert.equal(result.timeoutMs, 1200);
  assert.equal(result.followRedirects, false);
  assert.equal(result.maxRedirects, 0);
  assert.equal(result.verifyTLS, false);
  assert.equal(result.httpVersion, 'auto');
  assert.equal(result.tlsCiphers, '');
  assert.equal(
    payloadSettings({ timeoutMs: 1800, httpSettings: { timeoutMs: 1000 } }).timeoutMs,
    1800,
  );
  assert.equal(
    inherit({ tlsMinVersion: 'TLSv1.3' }, { tlsMaxVersion: 'TLSv1.2' }).tlsMaxVersion,
    'TLSv1.2',
  );
  assert.throws(
    () => resolve({ tlsMinVersion: 'TLSv1.3' }, { tlsMaxVersion: 'TLSv1.2' }),
    /Minimum TLS/,
  );
});
test('settings validation rejects invalid runtime choices and retains only supported fields', () => {
  for (const input of [
    { timeoutMs: NaN },
    { connectTimeoutMs: 0 },
    { maxRedirects: -1 },
    { verifyTLS: 'false' },
    { httpVersion: '3' },
    { tlsMinVersion: 'SSLv3' },
    { tlsCiphers: 'bad\nlist' },
  ])
    assert.throws(() => overrides(input));
  assert.deepEqual(overrides({ unknown: 'ignored', verifyTLS: false }), { verifyTLS: false });
  assert.equal(resolve().verifyTLS, true);
  assert.equal(resolve().httpVersion, '1.1');
  const collections = collectionOverrides(
    JSON.parse('{"__proto__":{"timeoutMs":1200},"Group":{"maxRedirects":0}}'),
  );
  assert.equal(Object.hasOwn(collections, '__proto__'), true);
  assert.equal(collections.Group.maxRedirects, 0);
  assert.equal(({} as { timeoutMs?: number }).timeoutMs, undefined);
});
test('HTTP/2 only, automatic ALPN, and HTTP/1.1 settings negotiate the requested protocol', async () => {
  const server = createSecureServer(
    { key: fixture.key, cert: fixture.cert + fixture.ca, allowHTTP1: true },
    (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/large-headers') res.setHeader('X-Large', 'a'.repeat(4096));
      res.end(JSON.stringify({ version: req.httpVersion }));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    for (const version of ['2', 'auto', '1.1'] as const) {
      const response = await sendHttpRequest(
        request(`https://127.0.0.1:${port}`, { httpVersion: version, caCertificates: fixture.ca }),
        new AbortController(),
      );
      assert.equal(response.error, undefined, response.error || 'Request should succeed');
      assert.equal(JSON.parse(response.body!).version, version === '1.1' ? '1.1' : '2.0');
      assert.equal(response.httpVersion, version === '1.1' ? '1.1' : '2');
      assert.equal(response.tls?.authorized, true);
    }
    const oversizedHeaders = await sendHttpRequest(
      request(`https://127.0.0.1:${port}/large-headers`, {
        httpVersion: '2',
        caCertificates: fixture.ca,
        maxHeaderSizeKB: 1,
      }),
      new AbortController(),
    );
    assert.match(oversizedHeaders.error || '', /headers.*size limit/);
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('HTTP/2 only rejects HTTP URLs and HTTPS servers without h2', async () => {
  assert.match(
    (
      await sendHttpRequest(
        request('http://localhost:1234', { httpVersion: '2' }),
        new AbortController(),
      )
    ).error || '',
    /requires an HTTPS URL/,
  );
  const server = createHTTPSServer({ key: fixture.key, cert: fixture.cert }, (_req, res) =>
    res.end('HTTP/1 only'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const result = await sendHttpRequest(
      request(`https://127.0.0.1:${port}`, { httpVersion: '2', caCertificates: fixture.ca }),
      new AbortController(),
    );
    assert.match(result.error || '', /required HTTP\/2/);
  } finally {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('verification opt-out and custom CA settings use isolated connection pools', async () => {
  const server = createHTTPSServer({ key: fixture.key, cert: fixture.cert }, (_req, res) =>
    res.end('ok'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number },
      url = `https://127.0.0.1:${port}`;
    const insecure = await sendHttpRequest(
      request(url, { verifyTLS: false }),
      new AbortController(),
    );
    assert.equal(insecure.status, 200);
    assert.equal(insecure.tls?.authorized, false);
    const verified = await sendHttpRequest(
      request(url, { verifyTLS: true }),
      new AbortController(),
    );
    assert.ok(verified.error, 'verified request must not reuse an unverified socket');
    const customCA = await sendHttpRequest(
      request(url, { caCertificates: fixture.ca }),
      new AbortController(),
    );
    assert.equal(customCA.status, 200);
    assert.equal(customCA.tls?.authorized, true);
  } finally {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('TLS protocol range and cipher restrictions apply to the actual socket', async () => {
  const server = createHTTPSServer(
    { key: fixture.key, cert: fixture.cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
    (_req, res) => res.end('ok'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number },
      url = `https://127.0.0.1:${port}`;
    const good = await sendHttpRequest(
      request(url, {
        caCertificates: fixture.ca,
        tlsMinVersion: 'TLSv1.2',
        tlsMaxVersion: 'TLSv1.2',
        tlsCiphers: 'ECDHE-RSA-AES128-GCM-SHA256',
      }),
      new AbortController(),
    );
    assert.equal(good.status, 200);
    assert.equal(good.tls?.protocol, 'TLSv1.2');
    assert.equal(good.tls?.cipher.name, 'ECDHE-RSA-AES128-GCM-SHA256');
    assert.ok(
      (
        await sendHttpRequest(
          request(url, { caCertificates: fixture.ca, tlsMinVersion: 'TLSv1.3' }),
          new AbortController(),
        )
      ).error,
    );
    assert.match(
      (await sendHttpRequest(request(url, { tlsCiphers: 'NOT_A_CIPHER' }), new AbortController()))
        .error || '',
      /Invalid TLS/,
    );
    assert.match(
      (
        await sendHttpRequest(
          request(url, { caCertificates: 'NOT_A_CERTIFICATE' }),
          new AbortController(),
        )
      ).error || '',
      /valid PEM/,
    );
  } finally {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('redirect limits, decoded response limits and response header limits are enforced', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: '/redirect' });
      res.end('redirect');
    } else if (req.url === '/large') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(Buffer.alloc(1200000, 65)));
    } else {
      res.setHeader('X-Large', 'a'.repeat(4096));
      res.end('ok');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number },
      url = `http://127.0.0.1:${port}`;
    assert.match(
      (
        await sendHttpRequest(
          request(url + '/redirect', { maxRedirects: 1 }),
          new AbortController(),
        )
      ).error || '',
      /Too many redirects/,
    );
    assert.equal(
      (
        await sendHttpRequest(
          request(url + '/redirect', { followRedirects: false }),
          new AbortController(),
        )
      ).status,
      302,
    );
    assert.match(
      (
        await sendHttpRequest(
          request(url + '/large', { maxResponseSizeMB: 1 }),
          new AbortController(),
        )
      ).error || '',
      /size limit/,
    );
    assert.match(
      (
        await sendHttpRequest(
          request(url + '/headers', { maxHeaderSizeKB: 1 }),
          new AbortController(),
        )
      ).error || '',
      /headers.*size limit/,
    );
  } finally {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('total, header and body idle timeouts are enforced and connection reuse can be disabled', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url === '/fast') {
      res.end('ok');
      return;
    }
    if (req.url === '/body') {
      res.writeHead(200);
      res.flushHeaders();
      res.write('first');
    }
    timers.push(setTimeout(() => res.end('last'), 1600));
  });
  server.on('connection', () => connections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number },
      url = `http://127.0.0.1:${port}`;
    assert.match(
      (await sendHttpRequest(request(url + '/slow', { timeoutMs: 100 }), new AbortController()))
        .error || '',
      /cancelled|timed out/,
    );
    assert.match(
      (
        await sendHttpRequest(
          request(url + '/slow', { timeoutMs: 3000, headersTimeoutMs: 100 }),
          new AbortController(),
        )
      ).error || '',
      /headers timed out/,
    );
    assert.match(
      (
        await sendHttpRequest(
          request(url + '/body', { timeoutMs: 3000, bodyTimeoutMs: 100 }),
          new AbortController(),
        )
      ).error || '',
      /body timed out/,
    );
    const before = connections;
    await sendHttpRequest(request(url + '/fast', { keepAlive: false }), new AbortController());
    await sendHttpRequest(request(url + '/fast', { keepAlive: false }), new AbortController());
    assert.equal(connections - before, 2);
  } finally {
    timers.forEach(clearTimeout);
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('advanced connection settings validate and inherit without losing zero or false', () => {
  const result = resolve(
    { addressFamily: 'ipv6', maxConnections: 8, pipelining: 4, autoSelectFamily: true },
    { addressFamily: 'ipv4', maxConnections: 0, autoSelectFamily: false },
  );
  assert.equal(result.addressFamily, 'ipv4');
  assert.equal(result.maxConnections, 0);
  assert.equal(result.autoSelectFamily, false);
  assert.equal(result.pipelining, 4);
  for (const invalid of [
    { addressFamily: 'ipv5' },
    { autoSelectFamily: 'true' },
    { autoSelectFamilyAttemptTimeoutMs: 9 },
    { maxConnections: -1 },
    { pipelining: 0 },
    { maxRequestsPerConnection: 0.5 },
    { maxConcurrentStreams: 0 },
  ])
    assert.throws(() => overrides(invalid));
});

test('connection limits serialize concurrent requests and request thresholds rotate sockets', async () => {
  let active = 0,
    peak = 0,
    connections = 0;
  const server = createServer((_req, res) => {
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      res.end('ok');
    }, 40);
  });
  server.on('connection', () => connections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        sendHttpRequest(request(url, { maxConnections: 1 }), new AbortController()),
      ),
    );
    results.forEach((result) =>
      assert.equal(result.status, 200, result.error || 'Request should succeed'),
    );
    assert.equal(peak, 1);
    assert.equal(connections, 1);
    const initial = connections;
    for (let i = 0; i < 3; i++) {
      const result = await sendHttpRequest(
        request(url, {
          maxConnections: 1,
          maxRequestsPerConnection: 1,
        }),
        new AbortController(),
      );
      assert.equal(result.status, 200, result.error || 'Request should succeed');
    }
    // A threshold of one gives every request its own connection.
    assert.equal(connections - initial, 3);
  } finally {
    await closeHTTPTransports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('IPv4 DNS selection reaches IPv4 listeners for HTTP/1.1 and strict HTTP/2', async () => {
  const http = createServer((_req, res) => res.end('ipv4'));
  const https = createSecureServer({ key: fixture.key, cert: fixture.cert }, (_req, res) =>
    res.end('ipv4 h2'),
  );
  http.listen(0, '127.0.0.1');
  https.listen(0, '127.0.0.1');
  await Promise.all([once(http, 'listening'), once(https, 'listening')]);
  try {
    for (const [server, protocol, version] of [
      [http, 'http', '1.1'],
      [https, 'https', '2'],
    ] as const) {
      const { port } = server.address() as { port: number };
      const result = await sendHttpRequest(
        request(`${protocol}://localhost:${port}`, {
          addressFamily: 'ipv4',
          httpVersion: version,
          caCertificates: fixture.ca,
        }),
        new AbortController(),
      );
      assert.equal(result.status, 200, result.error || 'Request should succeed');
      assert.equal(result.httpVersion, version);
    }
  } finally {
    await closeHTTPTransports();
    http.closeAllConnections();
    await Promise.all(
      [http, https].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
});
