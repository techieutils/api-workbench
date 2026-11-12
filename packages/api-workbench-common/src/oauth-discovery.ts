/**
 * OAuth 2.0 discovery results, and how they fill in an OAuth configuration. Discovery itself
 * runs in the main process (electron/oauth-discovery.ts); this module is shared with the forms.
 *
 * Standards: OAuth 2.0 Protected Resource Metadata (RFC 9728), Authorization Server Metadata
 * (RFC 8414), OpenID Connect Discovery 1.0, and Resource Indicators (RFC 8707).
 */

export interface OAuthDiscovery {
  /** The authorization server's issuer, checked against the metadata it published. */
  issuer: string;
  /** Which document described the authorization server. */
  source: 'oauth-authorization-server' | 'openid-configuration';
  metadataUrl: string;
  /** From protected resource metadata: the API's resource identifier, sent as `resource`. */
  resource?: string;
  resourceMetadataUrl?: string;
  resourceName?: string;
  /** Scopes the API says it uses (protected resource metadata). */
  resourceScopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  userinfoUrl?: string;
  /** Scopes the authorization server supports, often many more than one API needs. */
  supportedScopes?: string[];
  grantTypes?: string[];
  pkceMethods?: string[];
  clientAuthMethods?: string[];
  /** Things to check, such as a server that does not advertise PKCE S256. */
  warnings: string[];
}

export type GrantType = 'authorization_code' | 'client_credentials' | 'password';
export type ClientAuth = 'none' | 'basic' | 'body';
export interface DiscoverableConfig {
  grantType: GrantType;
  clientAuth: ClientAuth;
  authorizationUrl: string;
  tokenUrl: string;
  scope: string;
  resource: string;
}

const CLIENT_AUTH: Record<ClientAuth, string> = {
  basic: 'client_secret_basic',
  body: 'client_secret_post',
  none: 'none',
};

/**
 * Fills a configuration from discovery. Endpoints and the resource are taken from the metadata;
 * scopes only when none are set, and only those the API itself lists; the grant and client
 * authentication change only when the server does not support the current choice. Returns the
 * updated configuration and a description of each change.
 */
export function applyDiscovery<T extends DiscoverableConfig>(
  config: T,
  discovery: OAuthDiscovery,
): { config: T; changes: string[] } {
  const next = { ...config };
  const changes: string[] = [];
  const set = <K extends keyof DiscoverableConfig>(
    key: K,
    value: T[K] | undefined,
    label: string,
  ) => {
    if (value === undefined || value === next[key]) return;
    next[key] = value;
    changes.push(label);
  };
  set('authorizationUrl', discovery.authorizationUrl as T['authorizationUrl'], 'Authorization URL');
  set('tokenUrl', discovery.tokenUrl as T['tokenUrl'], 'Token URL');
  set('resource', discovery.resource as T['resource'], 'Resource');
  if (!next.scope.trim() && discovery.resourceScopes?.length)
    set('scope', discovery.resourceScopes.join(' ') as T['scope'], 'Scopes');
  // RFC 8414 defaults: authorization_code and implicit grants when grant_types_supported is absent.
  const grants = discovery.grantTypes ?? ['authorization_code'];
  if (!grants.includes(next.grantType)) {
    const supported = (['authorization_code', 'client_credentials'] as const).find((grant) =>
      grants.includes(grant),
    );
    if (supported) set('grantType', supported as T['grantType'], 'Grant type');
  }
  // Only an explicit list changes it: assuming the RFC 8414 default (client_secret_basic) would
  // turn public PKCE clients into ones that need a secret.
  const methods = discovery.clientAuthMethods;
  const allowed = (auth: ClientAuth) =>
    Boolean(methods?.includes(CLIENT_AUTH[auth])) &&
    !(auth === 'none' && next.grantType === 'client_credentials');
  if (methods && !allowed(next.clientAuth)) {
    const preferred = (['basic', 'body', 'none'] as const).find(allowed);
    if (preferred) set('clientAuth', preferred as T['clientAuth'], 'Client authentication');
  }
  return { config: next, changes };
}
