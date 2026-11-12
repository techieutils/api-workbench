import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sendHttpRequest } from './http';
import type { RequestPayload } from '@techieutils/api-workbench-common/types';
test('multipart uploads include duplicate text fields, file bytes, and an automatic boundary', async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        type: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const request: RequestPayload = {
      id: 'multipart',
      url: `http://127.0.0.1:${address.port}/`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
      multipart: [
        { name: 'tag', value: 'one' },
        { name: 'tag', value: 'two' },
        {
          name: 'upload',
          value: '',
          file: {
            name: 'hello.txt',
            type: 'text/plain',
            base64: Buffer.from('File content ✓').toString('base64'),
          },
        },
      ],
    };
    const result = await sendHttpRequest(request, new AbortController());
    assert.equal(result.error, undefined);
    const received = JSON.parse(result.body!);
    assert.match(received.type, /^multipart\/form-data; boundary=/);
    assert.equal((received.body.match(/name="tag"/g) || []).length, 2);
    assert.match(received.body, /filename="hello.txt"/);
    assert.match(received.body, /File content ✓/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('binary bodies preserve exact bytes and are omitted for GET and HEAD', async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ type: request.headers['content-type'], bytes: [...Buffer.concat(chunks)] }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const request: RequestPayload = {
      id: 'binary',
      url: `http://127.0.0.1:${address.port}/`,
      method: 'POST',
      headers: {},
      body: '',
      binary: {
        name: 'sample.bin',
        type: 'application/octet-stream',
        base64: Buffer.from([0, 255, 128, 1]).toString('base64'),
      },
    };
    const result = await sendHttpRequest(request, new AbortController());
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(result.body!).bytes, [0, 255, 128, 1]);
    assert.equal(JSON.parse(result.body!).type, 'application/octet-stream');
    request.method = 'GET';
    const get = await sendHttpRequest(request, new AbortController());
    assert.deepEqual(JSON.parse(get.body!).bytes, []);
    request.method = 'HEAD';
    const head = await sendHttpRequest(request, new AbortController());
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
