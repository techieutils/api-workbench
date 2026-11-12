import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverOAuth } from './oauth-discovery';
import { buildAuthorizationUrl, createPkce, exchangeToken } from './oauth';
import {
  applyDiscovery,
  type DiscoverableConfig,
  type OAuthDiscovery,
} from '@techieutils/api-workbench-common/oauth-discovery';

/** A local server answering paths from a table; `{base}` in bodies becomes its own URL. */
async function serve(routes: Record<string, unknown | ((response: ServerResponse) => void)>) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url!);
    const route = routes[request.url!];
    if (typeof route === 'function') return (route as (response: ServerResponse) => void)(response);
    if (route === undefined) {
      response.statusCode = 404;
      return response.end('{}');
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(route).replaceAll('{base}', base));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => server.close() };
}

test('an API URL leads through protected resource metadata to the authorization server', async () => {
  const site = await serve({
    '/.well-known/oauth-protected-resource/mcp': {
      resource: '{base}/mcp',
      resource_name: 'Acme MCP',
      authorization_servers: ['{base}/auth'],
      scopes_supported: ['orders:read', 'orders:write'],
    },
    '/.well-known/oauth-authorization-server/auth': {
      issuer: '{base}/auth',
      authorization_endpoint: '{base}/auth/authorize',
      token_endpoint: '{base}/auth/token',
      registration_endpoint: '{base}/auth/register',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      scopes_supported: ['openid', 'orders:read', 'orders:write', 'admin'],
    },
  });
  try {
    const found = await discoverOAuth(`${site.base}/mcp`);
    assert.equal(found.issuer, `${site.base}/auth`);
    assert.equal(found.source, 'oauth-authorization-server');
    assert.equal(found.resource, `${site.base}/mcp`);
    assert.equal(found.resourceName, 'Acme MCP');
    assert.deepEqual(found.resourceScopes, ['orders:read', 'orders:write']);
    assert.equal(found.authorizationUrl, `${site.base}/auth/authorize`);
    assert.equal(found.tokenUrl, `${site.base}/auth/token`);
    assert.equal(found.registrationUrl, `${site.base}/auth/register`);
    assert.deepEqual(found.warnings, []);
  } finally {
    site.close();
  }
});

test('an issuer URL uses RFC 8414 metadata, then OpenID Connect discovery', async () => {
  const site = await serve({
    '/realms/demo/.well-known/openid-configuration': {
      issuer: '{base}/realms/demo',
      authorization_endpoint: '{base}/realms/demo/auth',
      token_endpoint: '{base}/realms/demo/token',
      userinfo_endpoint: '{base}/realms/demo/userinfo',
      code_challenge_methods_supported: ['plain'],
    },
  });
  try {
    const found = await discoverOAuth(`${site.base}/realms/demo/`);
    assert.equal(found.source, 'openid-configuration');
    assert.equal(found.metadataUrl, `${site.base}/realms/demo/.well-known/openid-configuration`);
    assert.equal(found.userinfoUrl, `${site.base}/realms/demo/userinfo`);
    assert.equal(found.resource, undefined);
    assert.match(found.warnings.join(' '), /PKCE S256/);
    // The well-known URL itself works too.
    assert.equal(
      (await discoverOAuth(`${site.base}/realms/demo/.well-known/openid-configuration`)).tokenUrl,
      `${site.base}/realms/demo/token`,
    );
  } finally {
    site.close();
  }
});

test('an API that only names its metadata in a 401 challenge is followed', async () => {
  const site = await serve({
    '/v1/orders': (response: ServerResponse) => {
      response.statusCode = 401;
      response.setHeader(
        'WWW-Authenticate',
        `Bearer realm="orders", resource_metadata="${site.base}/meta/orders"`,
      );
      response.end();
    },
    '/meta/orders': { resource: '{base}/v1/orders', authorization_servers: ['{base}/login'] },
    '/.well-known/oauth-authorization-server/login': {
      issuer: '{base}/login',
      token_endpoint: '{base}/login/token',
      authorization_endpoint: '{base}/login/authorize',
      code_challenge_methods_supported: ['S256'],
    },
  });
  try {
    const found = await discoverOAuth(`${site.base}/v1/orders`);
    assert.equal(found.tokenUrl, `${site.base}/login/token`);
    assert.equal(found.resource, `${site.base}/v1/orders`);
    assert.equal(found.resourceMetadataUrl, `${site.base}/meta/orders`);
    assert.ok(site.seen.includes('/v1/orders'), 'the API was asked for its challenge');
  } finally {
    site.close();
  }
});

test('metadata for another issuer or resource, insecure endpoints, and missing metadata are refused', async () => {
  const site = await serve({
    '/.well-known/oauth-protected-resource/api': {
      resource: 'https://other.example/api',
      authorization_servers: ['{base}'],
    },
    '/.well-known/oauth-authorization-server/lookalike': {
      issuer: 'https://login.example',
      token_endpoint: '{base}/token',
    },
    '/common/v2.0/.well-known/openid-configuration': {
      issuer: '{base}/{tenantid}/v2.0',
      token_endpoint: '{base}/common/oauth2/v2.0/token',
    },
    '/.well-known/oauth-authorization-server/plain': {
      issuer: '{base}/plain',
      token_endpoint: 'http://tokens.example/token',
      authorization_endpoint: '{base}/plain/authorize',
    },
  });
  try {
    // Guessed metadata for another resource is passed over; metadata pointed at directly must match.
    await assert.rejects(discoverOAuth(`${site.base}/api`), /No OAuth metadata was found/);
    await assert.rejects(
      discoverOAuth(`${site.base}/.well-known/oauth-protected-resource/api`),
      /is for https:\/\/other\.example\/api/,
    );
    await assert.rejects(
      discoverOAuth(`${site.base}/lookalike`),
      /names the issuer https:\/\/login\.example/,
    );
    const tenant = await discoverOAuth(`${site.base}/common/v2.0`);
    assert.equal(
      tenant.tokenUrl,
      `${site.base}/common/oauth2/v2.0/token`,
      'a multi-tenant template issuer is accepted',
    );
    assert.match(tenant.warnings.join(' '), /multi-tenant/);
    const plain = await discoverOAuth(`${site.base}/plain`);
    assert.equal(plain.tokenUrl, undefined, 'a non-HTTPS endpoint is not used');
    assert.match(plain.warnings.join(' '), /not HTTPS/);
    await assert.rejects(
      discoverOAuth(`${site.base}/nothing`),
      /No OAuth metadata was found.*Tried:/,
    );
    await assert.rejects(discoverOAuth('http://example.com/api'), /HTTPS/);
    await assert.rejects(discoverOAuth('not a url'), /Invalid URL|absolute/i);
  } finally {
    site.close();
  }
});

test('discovery fills endpoints and resource, and adjusts the grant and client authentication only when needed', () => {
  const base: DiscoverableConfig = {
    grantType: 'authorization_code',
    clientAuth: 'none',
    authorizationUrl: '',
    tokenUrl: 'https://old/token',
    scope: '',
    resource: '',
  };
  const discovery: OAuthDiscovery = {
    issuer: 'https://login.example',
    source: 'oauth-authorization-server',
    metadataUrl: 'https://login.example/.well-known/oauth-authorization-server',
    resource: 'https://api.example',
    resourceScopes: ['read', 'write'],
    supportedScopes: ['openid', 'read', 'write', 'admin'],
    authorizationUrl: 'https://login.example/authorize',
    tokenUrl: 'https://login.example/token',
    warnings: [],
  };
  const { config, changes } = applyDiscovery(base, discovery);
  assert.deepEqual(config, {
    ...base,
    authorizationUrl: 'https://login.example/authorize',
    tokenUrl: 'https://login.example/token',
    scope: 'read write',
    resource: 'https://api.example',
  });
  assert.deepEqual(changes, ['Authorization URL', 'Token URL', 'Resource', 'Scopes']);
  assert.equal(
    applyDiscovery({ ...base, scope: 'mine' }, discovery).config.scope,
    'mine',
    'existing scopes are kept',
  );
  // No explicit method list: a public client stays public.
  assert.equal(applyDiscovery(base, discovery).config.clientAuth, 'none');
  // An explicit list without "none" moves it to a supported method.
  assert.equal(
    applyDiscovery(base, { ...discovery, clientAuthMethods: ['client_secret_post'] }).config
      .clientAuth,
    'body',
  );
  // A server without authorization code switches to client credentials, which cannot be public.
  const service = applyDiscovery(base, {
    ...discovery,
    grantTypes: ['client_credentials'],
    clientAuthMethods: ['none', 'client_secret_basic'],
  }).config;
  assert.equal(service.grantType, 'client_credentials');
  assert.equal(service.clientAuth, 'basic');
  assert.deepEqual(
    applyDiscovery(applyDiscovery(base, discovery).config, discovery).changes,
    [],
    'applying twice changes nothing',
  );
});

test('the resource indicator is sent when signing in and when exchanging tokens', async () => {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      bodies.push(body);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ access_token: 'issued', token_type: 'Bearer', expires_in: 60 }),
      );
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const config = {
      grantType: 'client_credentials' as const,
      authorizationUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      clientId: 'cli',
      clientSecret: 's',
      clientAuth: 'basic' as const,
      scope: 'read',
      audience: '',
      resource: 'https://api.example/mcp',
      callbackPort: 43821,
    };
    const authorize = new URL(
      buildAuthorizationUrl(config, 'http://127.0.0.1:43821/oauth/callback', createPkce()),
    );
    assert.equal(authorize.searchParams.get('resource'), 'https://api.example/mcp');
    await exchangeToken(config, { grant_type: 'client_credentials' });
    assert.equal(new URLSearchParams(bodies[0]).get('resource'), 'https://api.example/mcp');
    await assert.rejects(
      exchangeToken(
        { ...config, resource: 'https://api.example/#frag' },
        { grant_type: 'client_credentials' },
      ),
      /fragment/,
    );
  } finally {
    server.close();
  }
});
