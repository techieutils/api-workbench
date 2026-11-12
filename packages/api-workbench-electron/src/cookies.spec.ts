import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  cookieHeader,
  cookiesFor,
  mergeCookieHeader,
  parseSetCookie,
  sanitizeJar,
  storeCookies,
} from '@techieutils/api-workbench-common/cookies';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';

const now = Date.parse('2026-05-01T00:00:00Z');

test('Set-Cookie parsing applies defaults, attributes, and Max-Age precedence', () => {
  const cookie = parseSetCookie(
    'sid=abc; Path=/api; Secure; HttpOnly; SameSite=strict',
    'https://app.example.com/login',
    now,
  )!;
  assert.deepEqual(
    { ...cookie },
    {
      name: 'sid',
      value: 'abc',
      domain: 'app.example.com',
      hostOnly: true,
      path: '/api',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      created: now,
    },
  );
  assert.equal(parseSetCookie('a=1', 'https://example.com/v1/users/7', now)!.path, '/v1/users');
  assert.equal(parseSetCookie('a=1', 'https://example.com/users', now)!.path, '/');
  assert.equal(
    parseSetCookie(
      'a=1; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
      'https://example.com/',
      now,
    )!.expires,
    now + 60000,
  );
  assert.equal(
    parseSetCookie('a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT', 'https://example.com/', now)!
      .expires,
    Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'),
  );
  assert.equal(parseSetCookie('token=a=b=c', 'https://example.com/', now)!.value, 'a=b=c');
});

test('Set-Cookie rejects malformed, foreign-domain, broad-domain, and insecure Secure cookies', () => {
  assert.equal(parseSetCookie('novalue', 'https://example.com/', now), undefined);
  assert.equal(parseSetCookie('=x', 'https://example.com/', now), undefined);
  assert.equal(parseSetCookie('a=1; Domain=evil.com', 'https://example.com/', now), undefined);
  assert.equal(parseSetCookie('a=1; Domain=com', 'https://example.com/', now), undefined);
  assert.equal(parseSetCookie('a=1; Secure', 'http://example.com/', now), undefined);
  assert.ok(
    parseSetCookie('a=1; Secure', 'http://localhost:3000/', now),
    'localhost may set Secure cookies over HTTP',
  );
  const shared = parseSetCookie('a=1; Domain=.Example.com', 'https://api.example.com/', now)!;
  assert.equal(shared.domain, 'example.com');
  assert.equal(shared.hostOnly, false);
});

test('jar matching respects host-only, domain, path, secure, and expiry rules', () => {
  const jar = storeCookies(
    [],
    [
      { url: 'https://api.example.com/', header: 'host=1' },
      { url: 'https://api.example.com/', header: 'wide=2; Domain=example.com' },
      { url: 'https://api.example.com/', header: 'deep=3; Path=/v1/admin' },
      { url: 'https://api.example.com/', header: 'secure=4; Secure' },
      { url: 'https://api.example.com/', header: 'old=5; Max-Age=10' },
    ],
    now,
  );
  const names = (url: string, at = now) => cookiesFor(jar, url, at).map((cookie) => cookie.name);
  assert.deepEqual(names('https://api.example.com/v1/admin/users'), [
    'deep',
    'host',
    'wide',
    'secure',
    'old',
  ]);
  assert.deepEqual(names('https://www.example.com/'), ['wide']);
  assert.deepEqual(names('http://api.example.com/v1/administrator'), ['host', 'wide', 'old']);
  assert.deepEqual(names('https://api.example.com/', now + 11000), ['host', 'wide', 'secure']);
  assert.deepEqual(names('https://example.org/'), []);
  assert.deepEqual(names('not a url'), []);
  assert.equal(cookieHeader(jar, 'https://www.example.com/', now), 'wide=2');
});

test('storing replaces matching cookies, keeps creation order, and deletes on expiry', () => {
  let jar = storeCookies([], [{ url: 'https://example.com/', header: 'a=1' }], now);
  jar = storeCookies(jar, [{ url: 'https://example.com/', header: 'b=2' }], now + 1);
  jar = storeCookies(jar, [{ url: 'https://example.com/', header: 'a=updated' }], now + 2);
  assert.equal(cookieHeader(jar, 'https://example.com/', now + 3), 'a=updated; b=2');
  jar = storeCookies(jar, [{ url: 'https://example.com/', header: 'a=; Max-Age=0' }], now + 4);
  assert.equal(cookieHeader(jar, 'https://example.com/', now + 5), 'b=2');
});

test('explicit Cookie headers win over jar cookies with the same name', () => {
  assert.equal(mergeCookieHeader('a=manual', 'a=jar; b=2'), 'a=manual; b=2');
  assert.equal(mergeCookieHeader(undefined, 'b=2'), 'b=2');
  assert.equal(mergeCookieHeader('a=1', ''), 'a=1');
});

test('sanitized jars drop malformed entries and unknown fields', () => {
  const valid = {
    name: 'a',
    value: '1',
    domain: 'Example.com',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    created: 1,
    extra: 'x',
  };
  const result = sanitizeJar([
    valid,
    { ...valid, path: 'relative' },
    { ...valid, name: '' },
    null,
    'x',
    { ...valid, expires: 'soon' },
  ]);
  assert.deepEqual(result, [
    {
      name: 'a',
      value: '1',
      domain: 'example.com',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      created: 1,
    },
  ]);
  assert.deepEqual(sanitizeJar('nope'), []);
  assert.equal(sanitizeJar(Array(5).fill(valid), 2).length, 2);
});

test('Electron transport sends jar cookies across redirects and reports every Set-Cookie', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', ['session=s1; Path=/; HttpOnly', 'theme=dark']);
      res.statusCode = 302;
      res.setHeader('Location', '/home');
      res.end();
      return;
    }
    res.setHeader('Set-Cookie', 'visited=yes');
    res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const send = (url: string, extra: object) =>
      sendHttpRequest(
        { id: url, url, method: 'GET', headers: {}, body: '', ...extra },
        new AbortController(),
      );
    const withJar = await send(`${base}/login`, { cookieJar: [], headers: { Cookie: 'manual=1' } });
    assert.equal(withJar.error, undefined, String(withJar.error));
    assert.equal(
      JSON.parse(withJar.body!).cookie,
      'manual=1; session=s1; theme=dark',
      'redirect hop receives cookies set by the previous hop',
    );
    assert.deepEqual(
      withJar.setCookies!.map((item) => item.header),
      ['session=s1; Path=/; HttpOnly', 'theme=dark', 'visited=yes'],
    );
    assert.equal(withJar.setCookies![0].url, `${base}/login`);
    const withoutJar = await send(`${base}/login`, {});
    assert.equal(
      JSON.parse(withoutJar.body!).cookie,
      '',
      'requests without a jar never receive stored cookies',
    );
    assert.equal(
      withoutJar.setCookies!.length,
      3,
      'Set-Cookie headers are reported even when the jar is off',
    );
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
