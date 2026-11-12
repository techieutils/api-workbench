import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type {
  OAuthConfig,
  OAuthTokens,
  RequestOAuthInput,
} from '@techieutils/api-workbench-common/types';
export function secureEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('OAuth endpoints require HTTPS, or HTTP on localhost for development.');
  }
  if (url.hash) throw new Error('OAuth endpoints cannot contain URL fragments.');
  return url;
}
/** An RFC 8707 resource indicator: an absolute URI without a fragment. */
export function resourceIndicator(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The OAuth resource must be an absolute URL, such as https://api.example.com.');
  }
  if (url.hash) throw new Error('The OAuth resource cannot contain a URL fragment.');
  return value.trim();
}
export function createPkce(): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  };
}
export function buildAuthorizationUrl(
  config: OAuthConfig,
  redirectUri: string,
  pkce: ReturnType<typeof createPkce>,
): string {
  const url = secureEndpoint(config.authorizationUrl);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  };
  if (config.scope) params.scope = config.scope;
  if (config.audience) params.audience = config.audience;
  if (config.resource) params.resource = resourceIndicator(config.resource);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
export function validState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function exchangeToken(
  config: OAuthConfig,
  grant: Record<string, string>,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const endpoint = secureEndpoint(config.tokenUrl);
  const body = new URLSearchParams(grant);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  body.set('client_id', config.clientId);
  if (config.clientAuth === 'basic') {
    if (!config.clientSecret)
      throw new Error('A client secret is required for Basic client authentication.');
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
  } else if (config.clientAuth === 'body' && config.clientSecret)
    body.set('client_secret', config.clientSecret);
  if (config.scope && grant.grant_type !== 'refresh_token') body.set('scope', config.scope);
  if (config.audience) body.set('audience', config.audience);
  if (config.resource) body.set('resource', resourceIndicator(config.resource));
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok)
    throw new Error(
      `Token endpoint returned HTTP ${response.status}. Check the client, grant, and scopes.`,
    );
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !('access_token' in data) ||
    typeof data.access_token !== 'string' ||
    !data.access_token
  )
    throw new Error('Token endpoint did not return an access token.');
  const token = data as Record<string, unknown>;
  if (token.token_type && String(token.token_type).toLowerCase() !== 'bearer')
    throw new Error('Only Bearer OAuth tokens are supported.');
  const expiresIn = Number(token.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn >= 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof token.scope === 'string' ? token.scope : undefined,
  };
}
export async function browserAuthorization(
  config: OAuthConfig,
  openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<OAuthTokens> {
  if (
    !Number.isInteger(config.callbackPort) ||
    config.callbackPort < 1024 ||
    config.callbackPort > 65535
  )
    throw new Error('Callback port must be between 1024 and 65535.');
  secureEndpoint(config.tokenUrl);
  const pkce = createPkce();
  const redirectUri = `http://127.0.0.1:${config.callbackPort}/oauth/callback`;
  const authorizationUrl = buildAuthorizationUrl(config, redirectUri, pkce);
  let settle: (code: string | Error) => void = () => {};
  const callback = new Promise<string | Error>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', redirectUri);
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (!validState(url.searchParams.get('state'), pkce.state)) {
      response
        .writeHead(400)
        .end('Invalid authorization state. Return to API Workbench and try again.');
      return;
    }
    if (url.searchParams.has('error')) {
      response.writeHead(400).end('Authorization was declined. You can close this tab.');
      settle(new Error('Authorization was declined by the provider.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.writeHead(400).end('Missing authorization code.');
      return;
    }
    response.end('Authorization received. Return to API Workbench. You can close this tab.');
    settle(code);
  });
  const abort = () => settle(new Error('OAuth authorization cancelled.'));
  const timer = setTimeout(
    () => settle(new Error('Authorization timed out after three minutes.')),
    180000,
  );
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('OAuth authorization cancelled.');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.callbackPort, '127.0.0.1', () => resolve());
    });
    await openBrowser(authorizationUrl);
    const result = await callback;
    if (result instanceof Error) throw result;
    return await exchangeToken(
      config,
      {
        grant_type: 'authorization_code',
        code: result,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      },
      signal,
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  }
}

export async function requestOAuthToken(
  raw: unknown,
  openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<OAuthTokens> {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid OAuth configuration.');
  const input = raw as RequestOAuthInput;
  for (const key of [
    'authorizationUrl',
    'tokenUrl',
    'clientId',
    'clientSecret',
    'scope',
    'audience',
    'resource',
    'username',
    'password',
    'refreshToken',
  ] as const)
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 8192))
      throw new Error('Invalid OAuth configuration.');
  if (
    !['authorization_code', 'client_credentials', 'password', 'refresh_token'].includes(
      input.grantType,
    )
  )
    throw new Error('Choose an OAuth 2.0 grant type.');
  if (!['none', 'basic', 'body'].includes(input.clientAuth))
    throw new Error('Choose how the client authenticates.');
  if (!input.clientId?.trim()) throw new Error('Enter an OAuth client ID.');
  if (!input.tokenUrl?.trim()) throw new Error('Enter the OAuth token URL.');
  const config: OAuthConfig = {
    grantType:
      input.grantType === 'authorization_code' ? 'authorization_code' : 'client_credentials',
    authorizationUrl: input.authorizationUrl?.trim() || '',
    tokenUrl: input.tokenUrl.trim(),
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret || undefined,
    clientAuth: input.clientAuth,
    scope: input.scope?.trim() || '',
    audience: input.audience?.trim() || '',
    resource: input.resource?.trim() ? resourceIndicator(input.resource) : undefined,
    callbackPort: Number(input.callbackPort) || 43821,
  };
  if (input.grantType === 'refresh_token') {
    if (!input.refreshToken)
      throw new Error('No refresh token is available. Get a new access token.');
    const tokens = await exchangeToken(
      config,
      { grant_type: 'refresh_token', refresh_token: input.refreshToken },
      signal,
    );
    return { ...tokens, refreshToken: tokens.refreshToken || input.refreshToken };
  }
  if (input.grantType === 'client_credentials') {
    if (config.clientAuth === 'none' || !config.clientSecret)
      throw new Error(
        'Client credentials requires a client secret with Basic or body client authentication.',
      );
    return exchangeToken(config, { grant_type: 'client_credentials' }, signal);
  }
  if (input.grantType === 'password') {
    if (!input.username) throw new Error('Enter the resource owner username.');
    return exchangeToken(
      config,
      { grant_type: 'password', username: input.username, password: input.password || '' },
      signal,
    );
  }
  secureEndpoint(config.authorizationUrl);
  return browserAuthorization(config, openBrowser, signal);
}
