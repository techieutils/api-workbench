import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import {
  cachedJWT,
  checkedSigningAuth,
  createJWT,
  digestAuthorization,
  edgeGridHeader,
  hawkHeader,
  oauth1Header,
  parseDigestChallenge,
  rfc3986,
  signAWS,
  wsseHeaders,
} from '@techieutils/api-workbench-common/auth-signing';
import { ntlmAuthenticate, parseNTLMChallenge } from '@techieutils/api-workbench-common/ntlm';

const aws = {
  type: 'aws' as const,
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
};

test('AWS SigV4 matches the official get-vanilla test vector', () => {
  const headers = new Headers();
  signAWS(aws, {
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    headers,
    body: '',
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(headers.get('x-amz-date'), '20150830T123600Z');
  assert.equal(
    headers.get('authorization'),
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('AWS SigV4 signs session tokens, content types, sorted queries, and S3 payload hashes', () => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Custom': 'ignored' });
  signAWS(
    { ...aws, sessionToken: 'SESSION', service: 's3' },
    {
      method: 'PUT',
      url: new URL('https://bucket.s3.amazonaws.com/a b/c?z=1&a=2&a=1'),
      headers,
      body: '{}',
      now: new Date('2015-08-30T12:36:00Z'),
    },
  );
  assert.equal(headers.get('x-amz-security-token'), 'SESSION');
  assert.equal(
    headers.get('x-amz-content-sha256'),
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
  assert.match(
    headers.get('authorization')!,
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
  const unsigned = new Headers();
  signAWS(aws, {
    method: 'POST',
    url: new URL('https://example.amazonaws.com/'),
    headers: unsigned,
    body: undefined,
    unsignedPayload: true,
  });
  assert.equal(unsigned.get('x-amz-content-sha256'), 'UNSIGNED-PAYLOAD');
  assert.throws(
    () =>
      signAWS(
        { ...aws, region: '' },
        { method: 'GET', url: new URL('https://x.test/'), headers: new Headers(), body: '' },
      ),
    /region/,
  );
});

test('OAuth 1.0a HMAC-SHA1 matches the Twitter "Creating a signature" example', () => {
  const header = oauth1Header(
    {
      type: 'oauth1',
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      signatureMethod: 'HMAC-SHA1',
    },
    {
      method: 'POST',
      url: new URL('https://api.twitter.com/1.1/statuses/update.json?include_entities=true'),
      formParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
    },
  );
  assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", /);
  assert.ok(
    header.includes(`oauth_signature="${rfc3986('hCtSmYh+iHYCEqBWrE7C7hYmtUk=')}"`),
    header,
  );
});

test('OAuth 1.0 PLAINTEXT and realm formatting', () => {
  const header = oauth1Header(
    {
      type: 'oauth1',
      consumerKey: 'key',
      consumerSecret: 'sec&ret',
      tokenSecret: 'ts',
      signatureMethod: 'PLAINTEXT',
      realm: 'Photos',
    },
    { method: 'GET', url: new URL('https://example.com/'), nonce: 'n', timestamp: 1 },
  );
  assert.match(header, /^OAuth realm="Photos", /);
  assert.ok(header.includes(`oauth_signature="${rfc3986('sec%26ret&ts')}"`));
  assert.ok(!header.includes('oauth_token='));
  // A quote or a trailing backslash in the realm stays inside its quoted string.
  const escaped = oauth1Header(
    {
      type: 'oauth1',
      consumerKey: 'key',
      consumerSecret: 's',
      signatureMethod: 'PLAINTEXT',
      realm: 'a"b\\',
    },
    { method: 'GET', url: new URL('https://example.com/'), nonce: 'n', timestamp: 1 },
  );
  assert.match(escaped, /^OAuth realm="a\\"b\\\\", oauth_/);
});

test('Digest auth matches the RFC 2617 example and parses challenges', () => {
  const challenge = parseDigestChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  )!;
  assert.deepEqual(challenge, {
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    qop: 'auth,auth-int',
    opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    algorithm: 'MD5',
  });
  const header = digestAuthorization(
    { type: 'digest', username: 'Mufasa', password: 'Circle Of Life' },
    challenge,
    'GET',
    '/dir/index.html',
    '0a4f113b',
  );
  assert.ok(header.includes('response="6629fae49393a05397450978507c4ef1"'), header);
  assert.ok(
    header.includes('nc=00000001') &&
      header.includes('qop=auth') &&
      header.includes('opaque="5ccc069c403ebaf9f0171e9517f40e41"'),
  );
  const sha = digestAuthorization(
    { type: 'digest', username: 'u', password: 'p' },
    { realm: 'r', nonce: 'n', algorithm: 'SHA-256-sess', qop: 'auth' },
    'POST',
    '/x',
    'c',
  );
  assert.match(sha, /algorithm=SHA-256-sess, response="[0-9a-f]{64}"/);
  assert.equal(parseDigestChallenge('Basic realm="x"'), undefined);
  assert.equal(parseDigestChallenge(null), undefined);
  assert.throws(
    () =>
      digestAuthorization(
        { type: 'digest', username: 'u', password: 'p' },
        { realm: 'r', nonce: 'n', algorithm: 'SHA-1' },
        'GET',
        '/',
      ),
    /not supported/,
  );
});

test('JWTs are reused until shortly before they expire', () => {
  const claims = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const start = 1_800_000_000_000;
  const hour = {
    type: 'jwt' as const,
    algorithm: 'HS256' as const,
    secret: 'cache-secret',
    payload: { sub: 'svc' },
    prefix: 'Bearer',
    expiresInSeconds: 3600,
  };
  const first = cachedJWT(hour, start);
  assert.equal(cachedJWT(hour, start + 60_000), first, 'the same token is sent while it is valid');
  assert.equal(
    cachedJWT(hour, start + 3_569_000),
    first,
    'still reused just before the 30-second renewal window',
  );
  const renewed = cachedJWT(hour, start + 3_571_000);
  assert.notEqual(renewed, first, 'renewed within 30 seconds of expiry');
  assert.equal(claims(renewed).iat, Math.floor((start + 3_571_000) / 1000));
  assert.equal(cachedJWT(hour, start + 3_600_000), renewed);
  // Short lifetimes renew 10% early instead of 30 seconds early.
  const short = { ...hour, secret: 'short', expiresInSeconds: 60 };
  const brief = cachedJWT(short, start);
  assert.equal(cachedJWT(short, start + 53_000), brief);
  assert.notEqual(cachedJWT(short, start + 54_000), brief);
  // Any change to what is signed signs a new token.
  assert.notEqual(cachedJWT({ ...hour, payload: { sub: 'other' } }, start + 1000), first);
  assert.notEqual(cachedJWT({ ...hour, secret: 'rotated' }, start + 1000), first);
  assert.notEqual(cachedJWT({ ...hour, expiresInSeconds: 7200 }, start + 1000), first);
  // An exp set in the payload is honoured too.
  const fixed = {
    ...hour,
    secret: 'fixed',
    expiresInSeconds: undefined,
    payload: { exp: Math.floor(start / 1000) + 120 },
  };
  const fixedToken = cachedJWT(fixed, start);
  assert.equal(cachedJWT(fixed, start + 100_000), fixedToken);
  // ES256 signatures differ every time they are signed, which makes reuse observable.
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const ec = {
    ...hour,
    algorithm: 'ES256' as const,
    secret: ecKey,
    expiresInSeconds: undefined,
    payload: { exp: Math.floor(start / 1000) + 120 },
  };
  assert.equal(cachedJWT(ec, start + 60_000), cachedJWT(ec, start + 60_000), 'reused while valid');
  assert.notEqual(
    cachedJWT(ec, start + 121_000),
    cachedJWT(ec, start + 121_000),
    'an expired one is signed again each time',
  );
  // Without exp a token never expires, so it is reused while the configuration is unchanged.
  const forever = { ...hour, secret: 'forever', expiresInSeconds: undefined };
  assert.equal(cachedJWT(forever, start + 86_400_000 * 30), cachedJWT(forever, start));
});

test('JWT generation matches jwt.io HS256 and verifies RS256 and ES256 signatures', () => {
  const token = createJWT({
    type: 'jwt',
    algorithm: 'HS256',
    secret: 'your-256-bit-secret',
    payload: { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
    prefix: 'Bearer',
  });
  assert.equal(
    token,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', // gitleaks:allow -- jwt.io's public example token
  );
  const expiring = createJWT(
    { type: 'jwt', algorithm: 'HS256', secret: 's', payload: {}, prefix: '', expiresInSeconds: 60 },
    1_700_000_000_000,
  );
  assert.deepEqual(JSON.parse(Buffer.from(expiring.split('.')[1], 'base64url').toString()), {
    iat: 1700000000,
    exp: 1700000060,
  });
  for (const [algorithm, type, options] of [
    ['RS256', 'rsa', { modulusLength: 2048 }],
    ['ES256', 'ec', { namedCurve: 'P-256' }],
  ] as const) {
    const { privateKey, publicKey } = generateKeyPairSync(
      type as 'rsa',
      options as { modulusLength: number },
    );
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signed = createJWT({
      type: 'jwt',
      algorithm,
      secret: pem,
      payload: { sub: 'a' },
      prefix: 'Bearer',
    });
    const [header, payload, signature] = signed.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, algorithm);
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, ...(type === 'ec' ? { dsaEncoding: 'ieee-p1363' as const } : {}) },
        Buffer.from(signature, 'base64url'),
      ),
      algorithm,
    );
  }
  assert.throws(
    () =>
      createJWT({ type: 'jwt', algorithm: 'RS256', secret: 'not a key', payload: {}, prefix: '' }),
    /private key/,
  );
  assert.throws(
    () => createJWT({ type: 'jwt', algorithm: 'HS256', secret: '', payload: {}, prefix: '' }),
    /secret/,
  );
});

test('signing configuration from IPC is validated', () => {
  assert.equal(checkedSigningAuth(undefined), undefined);
  assert.throws(() => checkedSigningAuth({ type: 'kerberos' }), /Unsupported/);
  assert.throws(
    () => checkedSigningAuth({ type: 'oauth1', consumerKey: 'k', signatureMethod: 'RSA-SHA1' }),
    /signature method/,
  );
  assert.throws(
    () => checkedSigningAuth({ type: 'jwt', algorithm: 'HS256', secret: 's', payload: [] }),
    /JSON object/,
  );
  assert.throws(() => checkedSigningAuth({ type: 'digest', username: 1 }), /Invalid/);
});

test('Electron transport answers Digest challenges and signs AWS, OAuth 1.0, and JWT requests', async () => {
  let digestRequests = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/digest')) {
      digestRequests++;
      const header = req.headers.authorization || '';
      const challenge = {
        realm: 'api',
        nonce: 'abc123',
        qop: 'auth',
        opaque: 'op',
        algorithm: 'SHA-256',
      };
      const cnonce = /cnonce="([^"]+)"/.exec(header)?.[1];
      const expected =
        cnonce &&
        digestAuthorization(
          { type: 'digest', username: 'ada', password: 'secret' },
          challenge,
          req.method!,
          req.url,
          cnonce,
        );
      if (!expected || header !== expected) {
        res.statusCode = 401;
        res.setHeader(
          'WWW-Authenticate',
          'Digest realm="api", qop="auth", nonce="abc123", opaque="op", algorithm=SHA-256',
        );
        res.end('denied');
        return;
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (path: string, signing: unknown, extra: object = {}) =>
      sendHttpRequest(
        {
          id: path,
          url: base + path,
          method: 'GET',
          headers: {},
          body: '',
          signing,
          ...extra,
        } as never,
        new AbortController(),
      );
    const digest = await send('/digest?x=1', {
      type: 'digest',
      username: 'ada',
      password: 'secret',
    });
    assert.equal(digest.status, 200, String(digest.body ?? digest.error));
    assert.equal(digestRequests, 2, 'one challenge, one authenticated retry');
    assert.equal(digest.timings?.requests.length, 2, 'timeline shows the challenge round trip');
    const wrong = await send('/digest', { type: 'digest', username: 'ada', password: 'nope' });
    assert.equal(wrong.status, 401, 'failed Digest credentials are not retried forever');
    const signed = await send(
      '/aws?b=2&a=1',
      { ...aws, sessionToken: 'tok' },
      { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } },
    );
    const awsHeaders = JSON.parse(signed.body!).headers;
    assert.match(
      awsHeaders.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/service\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    assert.equal(awsHeaders['x-amz-security-token'], 'tok');
    const oauth = JSON.parse(
      (
        await send('/o', {
          type: 'oauth1',
          consumerKey: 'ck',
          consumerSecret: 'cs',
          signatureMethod: 'HMAC-SHA256',
        })
      ).body!,
    ).headers;
    assert.match(
      oauth.authorization,
      /^OAuth oauth_consumer_key="ck", .*oauth_signature_method="HMAC-SHA256".*oauth_signature="[^"]+"$/,
    );
    const jwt = JSON.parse(
      (
        await send('/j', {
          type: 'jwt',
          algorithm: 'HS256',
          secret: 's',
          payload: { sub: 'u' },
          prefix: 'Bearer',
        })
      ).body!,
    ).headers;
    assert.match(jwt.authorization, /^Bearer eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    const invalid = await send('/j', { type: 'jwt', algorithm: 'none', secret: '', payload: {} });
    assert.match(invalid.error || '', /supported JWT algorithm/);
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Hawk matches the reference header example', () => {
  const header = hawkHeader(
    {
      type: 'hawk',
      id: 'dh37fgj492je',
      key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn',
      algorithm: 'sha256',
      ext: 'some-app-ext-data',
    },
    { method: 'GET', url: new URL('http://example.com:8000/resource/1?b=1&a=2') },
    'j4h3g2',
    1353832234000,
  );
  assert.equal(
    header,
    'Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="',
  );
  const withHash = hawkHeader(
    { type: 'hawk', id: 'i', key: 'k', algorithm: 'sha256', includePayloadHash: true },
    {
      method: 'POST',
      url: new URL('https://example.com/x'),
      contentType: 'text/plain; charset=utf-8',
      body: 'Thank you for flying Hawk',
    },
    'n',
    0,
  );
  const hash = createHash('sha256')
    .update('hawk.1.payload\ntext/plain\nThank you for flying Hawk\n')
    .digest('base64');
  assert.ok(withHash.includes(`hash="${hash}"`));
});

test('WSSE builds a UsernameToken with a password digest', () => {
  const headers = wsseHeaders(
    { type: 'wsse', username: 'ada', password: 'secret' },
    'abc123',
    Date.UTC(2026, 0, 2, 3, 4, 5, 678),
  );
  assert.equal(headers.authorization, 'WSSE profile="UsernameToken"');
  const digest = createHash('sha1').update('abc1232026-01-02T03:04:05Zsecret').digest('base64');
  assert.equal(
    headers['x-wsse'],
    `UsernameToken Username="ada", PasswordDigest="${digest}", Nonce="${Buffer.from('abc123').toString('base64')}", Created="2026-01-02T03:04:05Z"`,
  );
});

test('Akamai EdgeGrid signs method, URL, chosen headers, and the POST body hash', () => {
  const auth = {
    type: 'edgegrid' as const,
    clientToken: 'akab-client',
    clientSecret: 'c2VjcmV0',
    accessToken: 'akab-access',
    headersToSign: ['X-Test'],
    maxBody: 4,
  };
  const headers = new Headers({ 'x-test': '  a   b ' });
  const header = edgeGridHeader(
    auth,
    { method: 'post', url: new URL('https://Host.example/path?q=1'), headers, body: 'bodytext' },
    'nonce-1',
    Date.UTC(2026, 0, 2, 3, 4, 5),
  );
  const prefix =
    'EG1-HMAC-SHA256 client_token=akab-client;access_token=akab-access;timestamp=20260102T03:04:05+0000;nonce=nonce-1;';
  const data = [
    'POST',
    'https',
    'host.example',
    '/path?q=1',
    'x-test:a b',
    createHash('sha256').update('body').digest('base64'),
    prefix,
  ].join('\t');
  const key = createHmac('sha256', 'c2VjcmV0').update('20260102T03:04:05+0000').digest('base64');
  assert.equal(
    header,
    `${prefix}signature=${createHmac('sha256', key).update(data).digest('base64')}`,
  );
});

test('new signing types are validated', () => {
  assert.throws(
    () => checkedSigningAuth({ type: 'hawk', id: 'i', key: 'k', algorithm: 'md5' }),
    /Hawk/,
  );
  assert.throws(
    () => checkedSigningAuth({ type: 'edgegrid', headersToSign: 'x', clientToken: '' }),
    /Invalid/,
  );
  assert.throws(() => checkedSigningAuth({ type: 'edgegrid', maxBody: -1 }), /max body/);
  assert.throws(() => checkedSigningAuth({ type: 'ntlm', username: 1 }), /Invalid/);
  assert.ok(checkedSigningAuth({ type: 'wsse', username: 'a', password: 'b' }));
});

test('Electron transport completes an NTLM handshake and signs WSSE, EdgeGrid, and Hawk', async () => {
  const authenticated = new WeakSet<object>();
  const name = Buffer.from('DOMAIN', 'utf16le');
  const challenge = Buffer.alloc(48 + name.length);
  challenge.write('NTLMSSP\0', 0, 'latin1');
  challenge.writeUInt32LE(2, 8);
  challenge.writeUInt16LE(name.length, 12);
  challenge.writeUInt16LE(name.length, 14);
  challenge.writeUInt32LE(48, 16);
  challenge.writeUInt32LE(0x00080205, 20);
  Buffer.from('0123456789abcdef', 'hex').copy(challenge, 24);
  name.copy(challenge, 48);
  let ntlmRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/ntlm') {
      ntlmRequests++;
      const header = req.headers.authorization || '';
      const message = header.startsWith('NTLM ') ? Buffer.from(header.slice(5), 'base64') : null;
      const type = message && message.length >= 12 ? message.readUInt32LE(8) : 0;
      if (type === 3 && authenticated.has(req.socket)) {
        // Recompute the answer from the client challenge the message carries.
        const nt = message!.subarray(
          message!.readUInt32LE(24),
          message!.readUInt32LE(24) + message!.readUInt16LE(20),
        );
        const parsed = parseNTLMChallenge(`NTLM ${challenge.toString('base64')}`)!;
        const expected = ntlmAuthenticate(
          { username: 'ada', password: 'secret', domain: 'DOMAIN' },
          parsed,
          nt.subarray(32, 40),
          Number(nt.readBigUInt64LE(24) / 10000n - 11644473600000n),
        );
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: header === expected }));
        return;
      }
      res.statusCode = 401;
      if (type === 1) {
        authenticated.add(req.socket);
        res.setHeader('WWW-Authenticate', `NTLM ${challenge.toString('base64')}`);
      } else res.setHeader('WWW-Authenticate', 'NTLM');
      res.end('denied');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const send = (path: string, signing: unknown) =>
      sendHttpRequest(
        {
          id: path,
          url: `http://127.0.0.1:${port}${path}`,
          method: 'GET',
          headers: {},
          body: '',
          signing,
        } as never,
        new AbortController(),
      );
    const ntlm = await send('/ntlm', {
      type: 'ntlm',
      username: 'ada',
      password: 'secret',
      domain: 'DOMAIN',
    });
    assert.equal(ntlm.status, 200, String(ntlm.error));
    assert.deepEqual(JSON.parse(ntlm.body!), { ok: true });
    assert.equal(ntlmRequests, 2);
    const wsse = JSON.parse(
      (await send('/w', { type: 'wsse', username: 'ada', password: 'p' })).body!,
    ).headers;
    assert.equal(wsse.authorization, 'WSSE profile="UsernameToken"');
    assert.match(wsse['x-wsse'], /^UsernameToken Username="ada", PasswordDigest="[^"]+"/);
    const edge = JSON.parse(
      (
        await send('/e', {
          type: 'edgegrid',
          clientToken: 'ct',
          clientSecret: 'cs',
          accessToken: 'at',
        })
      ).body!,
    ).headers;
    assert.match(
      edge.authorization,
      /^EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=\d{8}T[\d:]{8}\+0000;nonce=[\w-]+;signature=\S+$/,
    );
    const hawk = JSON.parse(
      (await send('/h', { type: 'hawk', id: 'i', key: 'k', algorithm: 'sha256' })).body!,
    ).headers;
    assert.match(hawk.authorization, /^Hawk id="i", ts="\d+", nonce="[^"]+", mac="[^"]+"$/);
  } finally {
    await closeHTTPTransports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
