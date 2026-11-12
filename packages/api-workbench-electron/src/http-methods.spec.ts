import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import { connectAuthority, sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';

/** TRACE and CONNECT, which fetch refuses, sent through the dispatcher itself. */

after(() => closeHTTPTransports());

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const send = (method: string, url: string, extra: { body?: string; settings?: object } = {}) =>
  sendHttpRequest(
    {
      id: crypto.randomUUID(),
      method,
      url,
      headers: { 'X-Team': 'payments' },
      body: extra.body ?? '',
      ...(extra.settings ? { httpSettings: extra.settings as Partial<HTTPSettings> } : {}),
    },
    new AbortController(),
  );

test('TRACE is sent without a body, and the echo comes back as the response', async () => {
  let received: { method?: string; url?: string; body: string; team?: string } = { body: '' };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received = {
        method: request.method,
        url: request.url,
        body,
        team: request.headers['x-team'] as string,
      };
      response.writeHead(200, { 'Content-Type': 'message/http', 'Set-Cookie': ['a=1', 'b=2'] });
      response.end(`TRACE ${request.url} HTTP/1.1\r\nx-team: ${request.headers['x-team']}\r\n`);
    });
  });
  const base = await listen(server);
  try {
    const result = await send('TRACE', `${base}/orders?limit=1`, { body: 'not sent' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.deepEqual(received, {
      method: 'TRACE',
      url: '/orders?limit=1',
      body: '',
      team: 'payments',
    });
    assert.match(result.body!, /^TRACE \/orders\?limit=1/);
    assert.equal(result.headers!['content-type'], 'message/http');
    assert.equal(result.setCookies?.length, 2, 'cookies are read as for other methods');
    assert.equal(result.url, `${base}/orders?limit=1`);
  } finally {
    server.close();
  }
});

test('CONNECT asks the server, or the proxy when one is set, for a tunnel to host:port', async () => {
  const seen: { url?: string; host?: string; auth?: string; team?: string }[] = [];
  const server = createServer();
  server.on('connect', (request: IncomingMessage, socket) => {
    seen.push({
      url: request.url,
      host: request.headers.host,
      auth: request.headers['proxy-authorization'],
      team: request.headers['x-team'] as string,
    });
    if (request.url?.startsWith('blocked.example'))
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 13\r\n\r\nSign in first',
      );
    else socket.end(`HTTP/1.1 200 Connection Established\r\nX-Tunnel: ${request.url}\r\n\r\n`);
  });
  const base = await listen(server);
  try {
    const direct = await send('CONNECT', base, { body: 'not sent' });
    assert.equal(direct.error, undefined);
    assert.equal(direct.status, 200);
    const authority = base.slice('http://'.length);
    assert.equal(direct.headers!['x-tunnel'], authority);
    assert.deepEqual(seen[0], {
      url: authority,
      host: authority,
      auth: undefined,
      team: 'payments',
    });

    const proxied = await send('CONNECT', 'https://api.example.test/ignored', {
      settings: {
        proxyMode: 'custom',
        proxyUrl: base,
        proxyUsername: 'ada',
        proxyPassword: 'TEST-PROXY-PASSWORD',
      },
    });
    assert.equal(proxied.status, 200);
    assert.equal(seen[1].url, 'api.example.test:443');
    assert.equal(
      seen[1].auth,
      `Basic ${Buffer.from('ada:TEST-PROXY-PASSWORD').toString('base64')}`,
      'proxy credentials go to the proxy',
    );
    assert.ok(!JSON.stringify(proxied).includes('TEST-PROXY-PASSWORD'), 'and not into the result');

    const refused = await send('CONNECT', 'http://blocked.example:8443', {
      settings: { proxyMode: 'custom', proxyUrl: base },
    });
    assert.equal(refused.status, 407);
    assert.equal(refused.headers!['proxy-authenticate'], 'Basic realm="corp"');
    assert.equal(refused.body, 'Sign in first', 'a refusal’s body is read');
  } finally {
    server.close();
  }
});

test('the CONNECT target is the URL’s host and port, with the scheme’s default port', () => {
  assert.equal(connectAuthority(new URL('https://api.example.com/x')), 'api.example.com:443');
  assert.equal(connectAuthority(new URL('http://api.example.com')), 'api.example.com:80');
  assert.equal(connectAuthority(new URL('http://[::1]:8080/')), '[::1]:8080');
});
