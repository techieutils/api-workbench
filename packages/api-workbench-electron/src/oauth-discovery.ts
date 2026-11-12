import type { OAuthDiscovery } from '@techieutils/api-workbench-common/oauth-discovery';
import { secureEndpoint } from './oauth';

/**
 * Finds an API's OAuth 2.0 authorization server from a URL: the API itself (via its protected
 * resource metadata, RFC 9728), or the authorization server (RFC 8414 metadata, or OpenID Connect
 * discovery). Every document must come over HTTPS (HTTP on localhost), without redirects, and
 * must name the identifier it was looked up by, so an API cannot point at a lookalike server.
 */

const METADATA_LIMIT = 512 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
type Json = Record<string, unknown>;

/** The well-known URL for an identifier, inserted between host and path (RFC 8414 §3.1, RFC 9728 §3.1). */
function wellKnown(identifier: URL, name: string): URL {
  const path = identifier.pathname.replace(/\/+$/, '');
  return new URL(`${identifier.origin}/.well-known/${name}${path}`);
}
/** OpenID Connect appends the well-known path to the issuer instead. */
const openidConfiguration = (issuer: URL) =>
  new URL(
    `${issuer.origin}${issuer.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`,
  );
/**
 * Multi-tenant Microsoft Entra endpoints (common, organizations, consumers) publish a template
 * issuer, `https://login.microsoftonline.com/{tenantid}/v2.0`; accept it for the matching URL.
 */
function tenantTemplate(published: string, issuer: string): boolean {
  if (!published.includes('{tenantid}')) return false;
  const [before, after] = published.replace(/\/+$/, '').split('{tenantid}');
  const requested = issuer.replace(/\/+$/, '');
  return (
    requested.startsWith(before) &&
    requested.endsWith(after) &&
    /^[\w-]+$/.test(requested.slice(before.length, requested.length - after.length))
  );
}
/** Identifiers compare exactly, apart from a trailing slash (many servers differ only by that). */
const sameIdentifier = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
function identifier(value: string): URL {
  const url = secureEndpoint(value);
  url.search = '';
  return url;
}

class Lookup {
  tried: string[] = [];
  constructor(private signal: AbortSignal) {}
  /** The JSON document at a URL, or undefined when it is absent (404 and similar). */
  async document(url: URL): Promise<Json | undefined> {
    secureEndpoint(url.toString());
    this.tried.push(url.toString());
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      // A redirect or unreachable host means no usable metadata here; keep looking.
      return undefined;
    }
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.length > METADATA_LIMIT)
      throw new Error(`${url} is larger than OAuth metadata should be.`);
    try {
      const json = JSON.parse(body);
      return json && typeof json === 'object' && !Array.isArray(json) ? (json as Json) : undefined;
    } catch {
      return undefined;
    }
  }
  /** The `resource_metadata` URL a protected API names in its 401 challenge, if any. */
  async challenge(url: URL): Promise<URL | undefined> {
    this.tried.push(`${url} (401 challenge)`);
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      await response.body?.cancel();
      const header = response.headers.get('www-authenticate') || '';
      const match =
        /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) ||
        /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
      return response.status === 401 && match ? new URL(match[1], url) : undefined;
    } catch (error) {
      if (this.signal.aborted) throw error;
      return undefined;
    }
  }
}

/** Protected resource metadata for a resource identifier, when it publishes one. */
async function resourceMetadata(lookup: Lookup, resource: URL, metadataUrl?: URL) {
  const candidates = metadataUrl
    ? [metadataUrl]
    : [
        wellKnown(resource, 'oauth-protected-resource'),
        ...(resource.pathname.replace(/\/+$/, '')
          ? [wellKnown(new URL(resource.origin), 'oauth-protected-resource')]
          : []),
      ];
  for (const url of candidates) {
    const document = await lookup.document(url);
    if (!document || !strings(document.authorization_servers)?.length) continue;
    const named = text(document.resource);
    // RFC 9728 §3.3: the metadata must be for the resource it was looked up for (or its origin).
    // Metadata found by guessing may describe another API on the same host, so look further;
    // metadata the user or the API's challenge pointed at must match.
    if (
      !named ||
      !(sameIdentifier(named, resource.toString()) || sameIdentifier(named, resource.origin))
    ) {
      if (!metadataUrl) continue;
      throw new Error(
        `The protected resource metadata at ${url} is for ${named || 'an unnamed resource'}, not ${resource}.`,
      );
    }
    return { document, url, resource: named };
  }
  return undefined;
}

/** Authorization server metadata for an issuer: RFC 8414 first, then OpenID Connect discovery. */
async function serverMetadata(lookup: Lookup, issuer: string) {
  const base = identifier(issuer);
  const warnings: string[] = [];
  const candidates: [URL, OAuthDiscovery['source']][] = [
    [wellKnown(base, 'oauth-authorization-server'), 'oauth-authorization-server'],
    [openidConfiguration(base), 'openid-configuration'],
    // Some OpenID providers with a path in the issuer use the inserted form.
    ...(base.pathname.replace(/\/+$/, '')
      ? [
          [wellKnown(base, 'openid-configuration'), 'openid-configuration'] as [
            URL,
            OAuthDiscovery['source'],
          ],
        ]
      : []),
  ];
  for (const [url, source] of candidates) {
    const document = await lookup.document(url);
    if (!document) continue;
    const published = text(document.issuer);
    if (!published || !(sameIdentifier(published, issuer) || tenantTemplate(published, issuer)))
      throw new Error(
        `The metadata at ${url} names the issuer ${published || '(none)'}, not ${issuer}. It was not used.`,
      );
    if (published.includes('{tenantid}'))
      warnings.push(
        `This is a multi-tenant endpoint: tokens are issued by the signed-in user's tenant, not ${issuer}.`,
      );
    return { document, url, source, issuer, warnings };
  }
  return undefined;
}

function describe(
  server: NonNullable<Awaited<ReturnType<typeof serverMetadata>>>,
  resource?: Awaited<ReturnType<typeof resourceMetadata>>,
): OAuthDiscovery {
  const { document } = server;
  const warnings = [...server.warnings];
  const endpoint = (key: string, label: string) => {
    const value = text(document[key]);
    if (!value) return undefined;
    try {
      return secureEndpoint(value).toString();
    } catch {
      warnings.push(`${label} ${value} is not HTTPS, so it was not used.`);
      return undefined;
    }
  };
  const discovery: OAuthDiscovery = {
    issuer: server.issuer,
    source: server.source,
    metadataUrl: server.url.toString(),
    resource: resource?.resource,
    resourceMetadataUrl: resource?.url.toString(),
    resourceName: text(resource?.document.resource_name),
    resourceScopes: strings(resource?.document.scopes_supported),
    authorizationUrl: endpoint('authorization_endpoint', 'The authorization endpoint'),
    tokenUrl: endpoint('token_endpoint', 'The token endpoint'),
    registrationUrl: endpoint('registration_endpoint', 'The registration endpoint'),
    userinfoUrl: endpoint('userinfo_endpoint', 'The userinfo endpoint'),
    supportedScopes: strings(document.scopes_supported),
    grantTypes: strings(document.grant_types_supported),
    pkceMethods: strings(document.code_challenge_methods_supported),
    clientAuthMethods: strings(document.token_endpoint_auth_methods_supported),
    warnings,
  };
  if (!discovery.tokenUrl) warnings.push('The server does not publish a token endpoint.');
  if (discovery.pkceMethods && !discovery.pkceMethods.includes('S256'))
    warnings.push('The server does not list PKCE S256, which authorization code sign-in uses.');
  if (!discovery.pkceMethods && discovery.source === 'oauth-authorization-server')
    warnings.push('The server does not say whether it supports PKCE.');
  const servers = strings(resource?.document.authorization_servers);
  if (servers && servers.length > 1)
    warnings.push(
      `The API names ${servers.length} authorization servers; the first, ${servers[0]}, was used.`,
    );
  return discovery;
}

/**
 * Discovers OAuth settings from an API URL, an issuer URL, or a well-known metadata URL.
 * Throws with the URLs it tried when nothing is found.
 */
export async function discoverOAuth(
  input: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<OAuthDiscovery> {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048)
    throw new Error('Enter an API, issuer, or metadata URL.');
  const url = identifier(input.trim());
  const lookup = new Lookup(signal);
  const fromResource = async (
    resource: NonNullable<Awaited<ReturnType<typeof resourceMetadata>>>,
  ) => {
    const issuer = strings(resource.document.authorization_servers)![0];
    const server = await serverMetadata(lookup, issuer);
    if (!server)
      throw new Error(
        `The API names ${issuer} as its authorization server, but no metadata was found there. Tried: ${lookup.tried.join(', ')}`,
      );
    return describe(server, resource);
  };

  // A well-known URL entered directly.
  const known =
    /\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/.*)?$/.exec(
      url.pathname,
    );
  if (known) {
    const document = await lookup.document(url);
    if (!document) throw new Error(`No metadata was found at ${url}.`);
    if (known[1] === 'oauth-protected-resource') {
      const resourceUrl = new URL(`${url.origin}${known[2] || ''}`);
      const resource = await resourceMetadata(lookup, resourceUrl, url);
      if (!resource) throw new Error(`${url} does not list any authorization servers.`);
      return fromResource(resource);
    }
    const issuer = text(document.issuer);
    if (!issuer) throw new Error(`${url} does not name its issuer.`);
    const server = await serverMetadata(lookup, issuer);
    if (!server) throw new Error(`No metadata was found for ${issuer}.`);
    return describe(server);
  }

  // An API: its protected resource metadata names the authorization server.
  const resource = await resourceMetadata(lookup, url);
  if (resource) return fromResource(resource);
  // An authorization server: the URL, or its origin, is the issuer.
  const path = url.pathname.replace(/\/+$/, '');
  for (const issuer of path ? [url.origin + path, url.origin] : [url.origin]) {
    const server = await serverMetadata(lookup, issuer);
    if (server) return describe(server);
  }
  // An API that only names its metadata in a 401 challenge.
  const challenged = await lookup.challenge(url);
  if (challenged) {
    const named = await resourceMetadata(lookup, url, secureEndpoint(challenged.toString()));
    if (named) return fromResource(named);
  }
  throw new Error(`No OAuth metadata was found for ${url}. Tried: ${lookup.tried.join(', ')}`);
}
