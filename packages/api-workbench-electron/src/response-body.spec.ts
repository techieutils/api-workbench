import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import {
  bodyKind,
  effectiveType,
  extensionFor,
  isTextType,
  sniff,
} from '@techieutils/api-workbench-common/response-body';

/** A valid 1×1 transparent PNG. */
function png(): Buffer {
  const crc = (data: Buffer) => {
    let value = ~0;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return ~value >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('response bodies are classified by type, or by their first bytes without one', () => {
  assert.equal(bodyKind('application/json; charset=utf-8'), 'text');
  assert.equal(bodyKind('application/problem+json'), 'text');
  assert.equal(bodyKind('application/vnd.api+json'), 'text');
  assert.equal(bodyKind('text/csv'), 'text');
  assert.equal(bodyKind('text/html; charset=utf-8'), 'html');
  assert.equal(bodyKind('text/markdown; charset=utf-8'), 'markdown');
  assert.equal(bodyKind('text/x-markdown'), 'markdown');
  assert.equal(bodyKind('image/png'), 'image');
  assert.equal(bodyKind('image/svg+xml'), 'image');
  assert.equal(bodyKind('application/pdf'), 'pdf');
  assert.equal(bodyKind('audio/mpeg'), 'audio');
  assert.equal(bodyKind('video/mp4'), 'video');
  assert.equal(bodyKind('font/woff2'), 'font');
  assert.equal(bodyKind('application/zip'), 'binary');
  assert.equal(
    bodyKind('application/octet-stream', png()),
    'stream',
    'octet-stream is never previewed',
  );
  assert.equal(bodyKind(undefined, png()), 'image', 'a missing type is sniffed');
  assert.equal(bodyKind('', Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(bodyKind(undefined, Buffer.from('{"ok":true}')), 'text');
  assert.equal(sniff(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(effectiveType(undefined, png()), 'image/png');
  assert.equal(isTextType('application/xml'), true);
  assert.equal(isTextType('image/png'), false);
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('application/hal+json'), 'json');
  assert.equal(extensionFor('application/x-unknown'), 'bin');
});

test('binary responses keep their exact bytes and size; text responses do not duplicate them', async () => {
  const image = png();
  const pdf = Buffer.from(
    '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF',
    'latin1',
  );
  const server = createServer((request, response) => {
    if (request.url === '/image') {
      response.setHeader('Content-Type', 'image/png');
      return response.end(image);
    }
    if (request.url === '/untyped') return response.end(pdf);
    if (request.url === '/stream') {
      response.setHeader('Content-Type', 'application/octet-stream');
      return response.end(Buffer.from([0, 1, 2, 255]));
    }
    response.setHeader('Content-Type', 'application/json');
    response.end('{"name":"Ada","emoji":"✓"}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (path: string) =>
    sendHttpRequest(
      { id: path, url: base + path, method: 'GET', headers: {}, body: '' },
      new AbortController(),
    );
  try {
    const imageResponse = await send('/image');
    assert.ok(imageResponse.error === undefined);
    assert.deepEqual(
      Buffer.from(imageResponse.bodyBase64!, 'base64'),
      image,
      'image bytes arrive unchanged',
    );
    assert.equal(imageResponse.size, image.length, 'size counts bytes, not decoded characters');
    const untyped = await send('/untyped');
    assert.deepEqual(
      Buffer.from(untyped.bodyBase64!, 'base64'),
      pdf,
      'a body without a type is kept when its bytes are recognised',
    );
    const stream = await send('/stream');
    assert.deepEqual(
      [...Buffer.from(stream.bodyBase64!, 'base64')],
      [0, 1, 2, 255],
      'octet-stream bytes are kept for download',
    );
    const json = await send('/json');
    assert.equal(json.bodyBase64, undefined, 'text bodies are not duplicated');
    assert.equal(json.body, '{"name":"Ada","emoji":"✓"}');
    assert.equal(json.size, Buffer.byteLength('{"name":"Ada","emoji":"✓"}'));
  } finally {
    server.close();
    await closeHTTPTransports();
  }
});
