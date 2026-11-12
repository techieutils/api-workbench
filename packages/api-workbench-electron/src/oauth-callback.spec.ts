import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, get } from 'node:http';
import { browserAuthorization } from './oauth';
import type { OAuthConfig } from '@techieutils/api-workbench-common/types';
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    }).on('error', reject);
  });
}
const config: OAuthConfig = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'desktop',
  scope: 'api.read',
  audience: '',
  clientAuth: 'none',
  callbackPort: 43821,
};
test(
  'loopback OAuth validates state, exchanges the PKCE verifier, and closes the callback server',
  { timeout: 10000 },
  async (t) => {
    const port = await freePort();
    let authorization: URL | undefined;
    let grant: URLSearchParams | undefined;
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      grant = new URLSearchParams(String(init.body));
      return Response.json({
        access_token: 'TOKEN',
        refresh_token: 'REFRESH',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });
    const tokens = await browserAuthorization(
      { ...config, callbackPort: port },
      async (url) => {
        authorization = new URL(url);
        const redirect = authorization.searchParams.get('redirect_uri')!;
        assert.equal(await callback(`${redirect}?state=wrong&code=stolen`), 400);
        assert.equal(
          await callback(
            `${redirect}?state=${authorization.searchParams.get('state')}&code=real-code`,
          ),
          200,
        );
      },
      new AbortController().signal,
    );
    assert.equal(tokens.accessToken, 'TOKEN');
    assert.equal(grant!.get('code'), 'real-code');
    const challenge = createHash('sha256').update(grant!.get('code_verifier')!).digest('base64url');
    assert.equal(challenge, authorization!.searchParams.get('code_challenge'));
    await assert.rejects(callback(`http://127.0.0.1:${port}/oauth/callback`));
  },
);
test(
  'cancelling browser authorization releases the loopback callback port',
  { timeout: 10000 },
  async () => {
    const port = await freePort();
    const controller = new AbortController();
    await assert.rejects(
      browserAuthorization(
        { ...config, callbackPort: port },
        async () => {
          controller.abort();
        },
        controller.signal,
      ),
      /cancelled/,
    );
    await assert.rejects(callback(`http://127.0.0.1:${port}/oauth/callback`));
  },
);
