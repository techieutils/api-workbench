import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { sendHttpRequest } from './http';
import { createTimingAgent } from './network-timing';
import { captureTLSCertificate } from './certificates';
import { createTLSFixture } from './testing/tls-fixture';
let fixture: Awaited<ReturnType<typeof createTLSFixture>>;
before(async () => {
  fixture = await createTLSFixture();
});
after(async () => {
  await fixture.dispose();
});
const payload = (url: string) => ({ id: 'certificate', method: 'GET', url, headers: {}, body: '' });
test('HTTPS captures verified public peer chain, identity, validity, fingerprints and negotiated TLS from actual request', async () => {
  const server = createServer(
    { key: fixture.key, cert: fixture.cert + fixture.ca },
    (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/final' });
        response.end();
      } else response.end('secure');
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = createTimingAgent({ ca: fixture.ca });
  try {
    const { port } = server.address() as { port: number };
    const url = `https://127.0.0.1:${port}`;
    const response = await sendHttpRequest(
      payload(url + '/redirect'),
      new AbortController(),
      agent,
    );
    assert.equal(response.status, 200);
    const tls = response.tls!;
    assert.equal(tls.authorized, true);
    assert.equal(tls.host, '127.0.0.1');
    assert.equal(tls.port, port);
    assert.match(tls.protocol, /^TLSv1\.[23]$/);
    assert.ok(tls.cipher.name);
    assert.equal(tls.authorizationError, undefined);
    assert.equal(tls.chain.length, 2);
    const leaf = tls.chain[0],
      x509 = new X509Certificate(fixture.cert);
    assert.equal(leaf.subject, x509.subject);
    assert.equal(leaf.issuer, x509.issuer);
    assert.equal(leaf.fingerprint256, x509.fingerprint256);
    assert.equal(leaf.serialNumber, x509.serialNumber);
    assert.equal(new X509Certificate(leaf.pem).fingerprint256, x509.fingerprint256);
    assert.ok(Date.parse(leaf.validTo) > Date.parse(leaf.validFrom));
    assert.match(leaf.subjectAltName, /localhost/);
    assert.equal(leaf.keyBits, 2048);
    assert.equal(leaf.ca, false);
    assert.equal(tls.chain[1].ca, true);
    assert.equal(JSON.stringify(tls).includes('PRIVATE KEY'), false);
    assert.equal(response.timings!.requests.length, 2);
    let reused = false;
    for (let index = 0; index < 4; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = await sendHttpRequest(payload(url + '/final'), new AbortController(), agent);
      assert.equal(next.tls?.chain[0].fingerprint256, leaf.fingerprint256);
      assert.equal(next.tls?.authorized, true);
      if (next.timings!.requests[0].connectionReused) reused = true;
    }
    assert.equal(reused, true, 'pooled requests retain the connection certificate');
  } finally {
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('untrusted certificates are rejected and never reported as verified', async () => {
  const server = createServer({ key: fixture.key, cert: fixture.cert }, (_request, response) =>
    response.end('should not be accepted'),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = createTimingAgent();
  try {
    const { port } = server.address() as { port: number };
    const response = await sendHttpRequest(
      payload(`https://127.0.0.1:${port}`),
      new AbortController(),
      agent,
    );
    assert.ok(response.error);
    assert.equal(response.tls, undefined);
    assert.equal(response.status, undefined);
  } finally {
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('plain HTTP has no TLS certificate metadata', async () => {
  const server = createHTTPServer((_request, response) => response.end('http'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const response = await sendHttpRequest(
      payload(`http://127.0.0.1:${port}`),
      new AbortController(),
    );
    assert.equal(response.status, 200);
    assert.equal(response.tls, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('closed sockets and missing peer data do not break requests during certificate capture', () => {
  assert.equal(
    captureTLSCertificate(
      {
        getPeerCertificate() {
          return {};
        },
      } as unknown as TLSSocket,
      'localhost',
      443,
    ),
    undefined,
  );
  assert.equal(
    captureTLSCertificate(
      {
        getPeerCertificate() {
          throw new Error('socket closed');
        },
      } as unknown as TLSSocket,
      'localhost',
      443,
    ),
    undefined,
  );
});
