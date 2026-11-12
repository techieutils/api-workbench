import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sendHttpRequest } from './http';
import type { RequestPayload } from '@techieutils/api-workbench-common/types';
const request = (url: string): RequestPayload => ({
  id: 'timing',
  method: 'GET',
  url,
  headers: {},
  body: '',
});
test('network phases measure connection, response wait, and streamed download independently', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.flushHeaders();
      response.write('first');
      setTimeout(() => response.end('last'), 35);
    }, 35);
  });
  server.listen(0);
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const result = await sendHttpRequest(
      request(`http://localhost:${port}/timed`),
      new AbortController(),
    );
    assert.equal(result.error, undefined);
    const timings = result.timings!;
    assert.ok(timings.totalMs >= 60);
    assert.equal(timings.requests.length, 1);
    const hop = timings.requests[0];
    assert.equal(hop.status, 200);
    assert.ok(hop.phases.some((phase) => phase.id === 'tcp'));
    assert.ok(hop.phases.some((phase) => phase.id === 'dns'));
    assert.ok(!hop.phases.some((phase) => phase.id === 'tls'), 'HTTP does not invent a TLS phase');
    assert.ok(hop.phases.find((phase) => phase.id === 'waiting')!.durationMs >= 25);
    assert.ok(hop.phases.find((phase) => phase.id === 'download')!.durationMs >= 25);
    for (const phase of hop.phases) {
      assert.ok(Number.isFinite(phase.durationMs) && phase.durationMs >= 0);
      assert.ok(phase.startMs >= 0 && phase.startMs + phase.durationMs <= timings.totalMs + 0.1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('redirect hops and reused connections have separate timing records', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' });
      response.end();
    } else response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;
    const result = await sendHttpRequest(request(url + '/redirect'), new AbortController());
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.timings!.requests.map((hop) => hop.status),
      [302, 200],
    );
    assert.ok(result.timings!.requests[1].startMs >= result.timings!.requests[0].startMs);
    let reused = false;
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const repeated = await sendHttpRequest(request(url + '/final'), new AbortController());
      const hop = repeated.timings!.requests[0];
      if (hop.connectionReused) {
        reused = true;
        assert.ok(!hop.phases.some((phase) => ['dns', 'tcp', 'tls'].includes(phase.id)));
      }
    }
    assert.ok(reused, 'warm requests reuse a pooled connection');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('cancelled requests retain elapsed timing without claiming a completed response', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.end('late');
    }, 100);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const controller = new AbortController();
    const pending = sendHttpRequest(request(`http://127.0.0.1:${port}`), controller);
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    assert.match(result.error || '', /cancelled|timed out/);
    assert.ok(result.timings!.totalMs > 0);
    assert.equal(result.timings!.requests[0].status, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('connection failures retain an incomplete TCP phase without pretending a request was sent', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await sendHttpRequest(
    request(`http://127.0.0.1:${port}/closed`),
    new AbortController(),
  );
  assert.ok(result.error);
  const phases = result.timings!.requests[0].phases;
  assert.ok(phases.some((phase) => phase.id === 'tcp' && phase.label.includes('incomplete')));
  assert.ok(
    !phases.some(
      (phase) => phase.id === 'sending' || phase.id === 'download' || phase.id === 'waiting',
    ),
  );
});
test('concurrent requests keep their own URLs, statuses, and wait durations', async () => {
  const server = createServer((request, response) => {
    const slow = request.url === '/slow';
    setTimeout(
      () => {
        response.statusCode = slow ? 202 : 201;
        response.end('ok');
      },
      slow ? 70 : 10,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const [slow, fast] = await Promise.all([
      sendHttpRequest(request(base + '/slow'), new AbortController()),
      sendHttpRequest(request(base + '/fast'), new AbortController()),
    ]);
    assert.equal(slow.timings!.requests[0].url, base + '/slow');
    assert.equal(fast.timings!.requests[0].url, base + '/fast');
    assert.equal(slow.timings!.requests[0].status, 202);
    assert.equal(fast.timings!.requests[0].status, 201);
    assert.ok(
      slow.timings!.requests[0].phases.find((phase) => phase.id === 'waiting')!.durationMs >= 50,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
