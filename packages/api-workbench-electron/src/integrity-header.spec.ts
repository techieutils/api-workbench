import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { RequestPayload } from '@techieutils/api-workbench-common/types';
import { overrides } from '@techieutils/api-workbench-common/http-settings';
import { customIntegrityHeader, integrityDigest, integrityHeader, sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';

after(() => closeHTTPTransports());

test('integrity headers hash the body in each scheme', () => {
  const bytes = Buffer.from('{"hello":"world"}');
  const b64 = (algorithm: string) => createHash(algorithm).update(bytes).digest('base64');
  assert.deepEqual(integrityHeader('content-digest-sha256', bytes), [
    'content-digest',
    `sha-256=:${b64('sha256')}:`,
  ]);
  assert.deepEqual(integrityHeader('content-digest-sha512', bytes), [
    'content-digest',
    `sha-512=:${b64('sha512')}:`,
  ]);
  assert.deepEqual(integrityHeader('digest-sha256', bytes), ['digest', `SHA-256=${b64('sha256')}`]);
  assert.deepEqual(integrityHeader('content-md5', bytes), ['content-md5', b64('md5')]);
  assert.deepEqual(integrityHeader('amz-checksum-sha256', bytes), [
    'x-amz-checksum-sha256',
    b64('sha256'),
  ]);
});

test('custom integrity algorithms match their reference outputs', async () => {
  // Published check values: CRCs of "123456789", xxHash of empty input (seed 0).
  const check = Buffer.from('123456789');
  const empty = Buffer.alloc(0);
  const hex = async (algorithm: Parameters<typeof integrityDigest>[0], bytes: Buffer) =>
    (await integrityDigest(algorithm, bytes)).toString('hex');
  assert.equal(await hex('crc32', check), 'cbf43926');
  assert.equal(await hex('crc32c', check), 'e3069283');
  assert.equal(await hex('xxhash64', empty), 'ef46db3751d8e999');
  assert.equal(await hex('xxhash3', empty), '2d06800538d394c2');
  assert.equal(await hex('xxhash128', empty), '99aa06d3014798d86001c324468d497f');
  for (const algorithm of ['sha1', 'sha256', 'sha512', 'md5'] as const)
    assert.equal(
      await hex(algorithm, check),
      createHash(algorithm).update(check).digest('hex'),
      algorithm,
    );
});

test('a custom integrity header uses its name, algorithm, and encoding', async () => {
  const bytes = Buffer.from('123456789');
  assert.deepEqual(
    await customIntegrityHeader(
      {
        integrityHeaderName: ' X-Amz-Checksum-CRC32C ',
        integrityAlgorithm: 'crc32c',
        integrityEncoding: 'base64',
      },
      bytes,
    ),
    // S3's form: Base64 of the big-endian checksum bytes.
    ['x-amz-checksum-crc32c', Buffer.from('e3069283', 'hex').toString('base64')],
  );
  assert.deepEqual(
    await customIntegrityHeader(
      { integrityHeaderName: 'x-checksum', integrityAlgorithm: 'crc32', integrityEncoding: 'hex' },
      bytes,
    ),
    ['x-checksum', 'cbf43926'],
  );
});

test('custom integrity header names must be valid and not replace request framing', () => {
  assert.deepEqual(overrides({ integrityHeaderName: 'x-checksum-xxhash64' }), {
    integrityHeaderName: 'x-checksum-xxhash64',
  });
  assert.throws(() => overrides({ integrityHeaderName: '' }), /Enter a header name/);
  assert.throws(() => overrides({ integrityHeaderName: 'x checksum' }), /letters, digits/);
  assert.throws(() => overrides({ integrityHeaderName: 'x-sum:1' }), /letters, digits/);
  assert.throws(() => overrides({ integrityHeaderName: 'Content-Length' }), /cannot carry/);
  assert.throws(() => overrides({ integrityHeaderName: 'Host' }), /cannot carry/);
  assert.throws(() => overrides({ integrityAlgorithm: 'crc64' }), /valid Custom integrity/);
});

test('requests carry the integrity header of the bytes they send', async () => {
  const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.end('ok');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const send = (patch: Partial<RequestPayload>) =>
    sendHttpRequest(
      {
        id: 'integrity',
        method: 'POST',
        url,
        headers: {},
        body: '',
        httpSettings: { integrityHeader: 'content-digest-sha256' },
        ...patch,
      },
      new AbortController(),
    );
  const sha256 = (bytes: Buffer) =>
    `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
  try {
    await send({ body: 'plain body' });
    assert.equal(seen[0].headers['content-digest'], sha256(seen[0].body));
    // A multipart body is hashed as encoded, boundary included.
    await send({ multipart: [{ name: 'field', value: 'value' }] });
    assert.match(String(seen[1].headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.equal(seen[1].headers['content-digest'], sha256(seen[1].body));
    // The request's own header wins, and GET sends none.
    await send({ body: 'x', headers: { 'Content-Digest': 'mine' } });
    assert.equal(seen[2].headers['content-digest'], 'mine');
    await send({ method: 'GET' });
    assert.equal(seen[3].headers['content-digest'], undefined);
    // A custom header carries the chosen algorithm's hash of the same bytes.
    await send({
      body: '123456789',
      httpSettings: {
        integrityHeader: 'custom-header',
        integrityHeaderName: 'X-Checksum-CRC32',
        integrityAlgorithm: 'crc32',
        integrityEncoding: 'hex',
      },
    });
    assert.equal(seen[4].headers['x-checksum-crc32'], 'cbf43926');
    assert.equal(seen[4].headers['content-digest'], undefined);
  } finally {
    server.close();
  }
});
