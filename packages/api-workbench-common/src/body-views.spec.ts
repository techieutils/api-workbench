import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyBytes, bytesToBase64, hexDump } from './body-views';

test('bodyBytes uses the kept original bytes, or the UTF-8 of the text', () => {
  assert.deepEqual(
    [...bodyBytes('ignored', Buffer.from([0, 255, 16]).toString('base64'))],
    [0, 255, 16],
  );
  assert.deepEqual([...bodyBytes('é')], [0xc3, 0xa9]);
});

test('bytesToBase64 matches Node for small and chunk-crossing inputs', () => {
  for (const size of [0, 1, 2, 3, 0x8000, 0x8000 * 2 + 5]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31) % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `${size} bytes`);
  }
});

test('hexDump shows offsets, hex, and printable ASCII', () => {
  const dump = hexDump(new TextEncoder().encode('Hello, hex view!\n\x00'));
  assert.equal(
    dump,
    [
      '00000000  48 65 6c 6c 6f 2c 20 68 65 78 20 76 69 65 77 21  Hello, hex view!',
      `00000010  ${'0a 00'.padEnd(47)}  ..`,
    ].join('\n'),
  );
});

test('hexDump stops at its limit and says how many bytes it left out', () => {
  const dump = hexDump(new Uint8Array(40_000), 32);
  assert.equal(dump.split('\n').length, 3);
  assert.match(dump, /… 39,968 more bytes not shown$/);
});
