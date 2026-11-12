import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fetch } from 'undici';
import { importLink, LINK_IMPORT_LIMIT } from './link-import';

/** Importing from links, against a local server standing in for GitHub and file hosts. */

let server: Server;
let base: string;
const seen: { path: string; authorization?: string; accept?: string }[] = [];
const collection = JSON.stringify({
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
  item: [],
});

before(async () => {
  server = createServer((request, response) => {
    seen.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      accept: request.headers.accept,
    });
    const url = request.url ?? '';
    if (url === '/acme/api/main/shop.postman_collection.json') response.end(collection);
    else if (url === '/gists/0123456789abcdef0123')
      response.end(
        JSON.stringify({
          files: {
            'shop.postman_collection.json': {
              filename: 'shop.postman_collection.json',
              content: collection,
            },
            'long.yaml': {
              filename: 'long.yaml',
              truncated: true,
              content: 'openapi: 3.0.0\n',
              raw_url: 'https://gist.githubusercontent.com/ada/raw/long.yaml',
            },
          },
        }),
      );
    else if (url === '/ada/raw/long.yaml') response.end('openapi: 3.0.0\ninfo: {title: Long}\n');
    else if (url === '/huge') {
      // No Content-Length: the limit is enforced while reading.
      response.writeHead(200, { 'transfer-encoding': 'chunked' });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let index = 0; index <= LINK_IMPORT_LIMIT / chunk.length; index++) response.write(chunk);
      response.end();
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Sends GitHub's hosts to the local server. */
const local = ((url: string, init: Parameters<typeof fetch>[1]) =>
  fetch(
    url.replace(
      /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com)/,
      base,
    ),
    init,
  )) as unknown as Parameters<typeof importLink>[1];

test('a GitHub page link downloads the raw file', async () => {
  const result = await importLink(
    'https://github.com/acme/api/blob/main/shop.postman_collection.json',
    local,
  );
  assert.equal(result.source, 'https://github.com/acme/api/blob/main/shop.postman_collection.json');
  assert.deepEqual(
    result.files.map((file) => [file.name, new TextDecoder().decode(file.data)]),
    [['shop.postman_collection.json', collection]],
  );
  assert.equal(seen.at(-1)?.authorization, undefined, 'no credentials are sent');
});

test('a gist link imports every file, fetching truncated ones whole', async () => {
  const result = await importLink('https://gist.github.com/ada/0123456789abcdef0123', local);
  assert.deepEqual(
    result.files.map((file) => [file.name, new TextDecoder().decode(file.data)]),
    [
      ['shop.postman_collection.json', collection],
      ['long.yaml', 'openapi: 3.0.0\ninfo: {title: Long}\n'],
    ],
  );
  assert.ok(seen.some((item) => item.accept === 'application/vnd.github+json'));
});

test('missing, private, oversized, and malformed links fail with a reason', async () => {
  await assert.rejects(
    importLink('https://github.com/acme/private/blob/main/x.json', local),
    /answered 404\. Only public links/,
  );
  await assert.rejects(importLink(`${base}/huge`, local), /larger than 10 MB/);
  await assert.rejects(importLink('http://127.0.0.1:1/x.json'), /Could not download the link/);
  await assert.rejects(importLink('file:///etc/hosts'), /Only http/);
  await assert.rejects(importLink(42), /Enter a link/);
});
