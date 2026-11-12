import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { io } from 'socket.io-client';
import mqtt from 'mqtt';
import { EchoService, grpc } from './grpc.mjs';
import { startPlayground } from './server.mjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function checkPlayground(httpURL, grpcAddress, mqttURL = 'mqtt://127.0.0.1:4782') {
  const get = (path, options = {}) =>
    fetch(`${httpURL}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  assert.equal((await (await get('/health')).json()).ok, true);
  const echo = await (
    await get('/echo?name=Workbench', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
  ).json();
  assert.equal(echo.query.name, 'Workbench');
  assert.deepEqual(echo.body, { hello: 'world' });
  const form = await (
    await get('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Workbench',
    })
  ).json();
  assert.equal(form.body.name, 'Workbench');
  const multipart = new FormData();
  multipart.set('name', 'Workbench');
  assert.match(
    (await (await get('/echo', { method: 'POST', body: multipart })).json()).body,
    /Workbench/,
  );
  const graph = await (
    await get('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($name: String) { hello(name: $name) protocol }',
        variables: { name: 'Workbench' },
      }),
    })
  ).json();
  assert.deepEqual(graph.data, { hello: 'Hello, Workbench!', protocol: 'GraphQL' });
  assert.equal((await get('/auth/bearer')).status, 401);
  assert.equal(
    (await get('/auth/bearer', { headers: { authorization: 'Bearer sample-token' } })).status,
    200,
  );
  assert.equal((await get('/redirect', { redirect: 'manual' })).status, 302);
  assert.equal((await (await get('/redirect')).json()).ok, true);
  assert.equal((await (await get('/gzip')).json()).compressed, true);
  assert.equal((await get('/status/418')).status, 418);
  assert.equal((await (await get('/delay?ms=10')).json()).delayedMs, 10);
  const sse = await get('/events?count=3&interval=10');
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const events = (await sse.text()).trim().split('\n\n');
  assert.equal(events.length, 3);
  assert.match(events[2], /id: 3\nevent: sample\ndata:/);
  const lines = (await (await get('/ndjson?count=3&interval=10')).text())
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    lines.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.equal((await get('/events?count=100')).status, 400);
  console.log(
    'HTTP, JSON, forms, GraphQL, auth, redirects, gzip, errors, delays, SSE, and NDJSON passed.',
  );

  const socket = new WebSocket(`${httpURL.replace('http:', 'ws:')}/ws`, { handshakeTimeout: 5000 });
  try {
    const timeout = AbortSignal.timeout(5000);
    const greeting = await once(socket, 'message', { signal: timeout });
    assert.equal(JSON.parse(greeting[0].toString()).protocol, 'WebSocket');
    const echoed = once(socket, 'message', { signal: timeout });
    socket.send('Hello from Workbench');
    assert.equal((await echoed)[0].toString(), 'Hello from Workbench');
    const binary = once(socket, 'message', { signal: timeout });
    socket.send(Buffer.from([0, 1, 255]));
    const [data, isBinary] = await binary;
    assert.equal(isBinary, true);
    assert.deepEqual(data, Buffer.from([0, 1, 255]));
    console.log('WebSocket greeting, text echo, and binary echo passed.');
  } finally {
    socket.terminate();
  }

  const chat = io(httpURL, { transports: ['websocket'], reconnection: false, timeout: 5000 });
  try {
    const timeout = AbortSignal.timeout(5000);
    const [welcome] = await once(chat, 'welcome', { signal: timeout });
    assert.equal(welcome.protocol, 'Socket.IO');
    const echoed = once(chat, 'echo', { signal: timeout });
    const ack = await chat.timeout(5000).emitWithAck('echo', { message: 'Hello from Workbench' });
    assert.deepEqual((await echoed)[0], { message: 'Hello from Workbench' });
    assert.equal(ack.protocol, 'Socket.IO');
    console.log('Socket.IO greeting, event echo, and acknowledgement passed.');
  } finally {
    chat.disconnect();
  }

  for (const url of [mqttURL, `${httpURL.replace('http:', 'ws:')}/mqtt`]) {
    const client = await mqtt.connectAsync(url, { reconnectPeriod: 0, connectTimeout: 5000 });
    try {
      await client.subscribeAsync('playground/#');
      const received = once(client, 'message', { signal: AbortSignal.timeout(5000) });
      await client.publishAsync('playground/echo', 'Hello from Workbench');
      const [topic, payload] = await received;
      assert.equal(topic, 'playground/echo');
      assert.equal(payload.toString(), 'Hello from Workbench');
    } finally {
      await client.endAsync(true);
    }
  }
  console.log('MQTT publish and subscribe passed over TCP and WebSocket.');

  const client = new EchoService(grpcAddress, grpc.credentials.createInsecure());
  try {
    const reply = await new Promise((resolve, reject) =>
      client.echo(
        { message: 'Hello from Workbench' },
        { deadline: Date.now() + 5000 },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
    assert.deepEqual(reply, { message: 'Hello from Workbench', protocol: 'gRPC' });
    const values = [];
    await new Promise((resolve, reject) => {
      const call = client.count({ count: 3 }, { deadline: Date.now() + 5000 });
      call.on('data', (result) => values.push(result.value));
      call.on('end', resolve);
      call.on('error', reject);
    });
    assert.deepEqual(values, [1, 2, 3]);
    const collected = await new Promise((resolve, reject) => {
      const call = client.collect({ deadline: Date.now() + 5000 }, (error, result) =>
        error ? reject(error) : resolve(result),
      );
      call.write({ message: 'one' });
      call.write({ message: 'two' });
      call.end();
    });
    assert.equal(collected.message, 'one, two');
    const chat = [];
    await new Promise((resolve, reject) => {
      const call = client.chat({ deadline: Date.now() + 5000 });
      call.on('data', (reply) => chat.push(reply.message));
      call.on('end', resolve);
      call.on('error', reject);
      call.write({ message: 'one' });
      call.write({ message: 'two' });
      call.end();
    });
    assert.deepEqual(chat, ['one', 'two']);
    console.log(
      'gRPC unary, server-streaming, client-streaming, and bidirectional samples passed.',
    );
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // With no arguments use temporary ports and stop the server after testing.
  // Pass --running to test a server started separately on the documented ports.
  const running = process.argv.includes('--running');
  const playground = running
    ? null
    : await startPlayground({ httpPort: 0, grpcPort: 0, mqttPort: 0 });
  try {
    await checkPlayground(
      playground?.httpURL || 'http://127.0.0.1:4780',
      playground?.grpcAddress || '127.0.0.1:4781',
      playground?.mqttURL || 'mqtt://127.0.0.1:4782',
    );
    const collection = JSON.parse(await readFile(new URL('./collection.json', import.meta.url)));
    assert.ok(collection.requests.length >= 10);
    const base = playground?.httpURL || 'http://127.0.0.1:4780';
    for (const sample of collection.requests) {
      const url = new URL(sample.url);
      const headers = Object.fromEntries(
        sample.headers.filter((row) => row.enabled).map((row) => [row.key, row.value]),
      );
      if (sample.auth === 'Bearer token') headers.authorization = `Bearer ${sample.token}`;
      let body;
      if (sample.bodyType === 'raw') body = sample.body;
      if (sample.bodyType === 'x-www-form-urlencoded') {
        body = new URLSearchParams(
          sample.bodyFields.filter((row) => row.enabled).map((row) => [row.key, row.value]),
        );
      }
      if (sample.bodyType === 'form-data') {
        body = new FormData();
        for (const field of sample.bodyFields.filter((row) => row.enabled))
          body.append(field.key, field.value);
      }
      const response = await fetch(`${base}${url.pathname}${url.search}`, {
        method: sample.method,
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      const expected = Number(sample.tests.match(/^status (\d+)/m)[1]);
      assert.equal(response.status, expected, sample.name);
      if (sample.tests.includes('json-valid')) JSON.parse(text);
      const contentType = sample.tests.match(/^content-type (.+)$/m)?.[1];
      if (contentType)
        assert.ok(response.headers.get('content-type')?.includes(contentType), sample.name);
      const contains = sample.tests.match(/^body-contains (.+)$/m)?.[1];
      if (contains) assert.ok(text.includes(contains), sample.name);
    }

    console.log(
      `All protocol checks passed. ${collection.requests.length} requests available for import.`,
    );
  } finally {
    await playground?.close();
  }
}
