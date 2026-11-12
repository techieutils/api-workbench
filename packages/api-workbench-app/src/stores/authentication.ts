import { defineStore } from 'pinia';
import * as payload from '@techieutils/api-workbench-common/request-payload';
import {
  collectionOf,
  folderEntry,
  isWithin,
  parentFolder,
  setFolderEntry,
} from '@techieutils/api-workbench-common/folders';
import { ref } from 'vue';
import type {
  ApiRequest,
  AuthConfig,
  AuthOptions,
  AuthType,
  OAuthTokens,
  RequestOAuthInput,
} from '@techieutils/api-workbench-common/types';
import { useWorkspaceStore } from './workspace';

export const AUTH_GROUPS: [string, AuthType[]][] = [
  ['General', ['None', 'Inherit from collection']],
  ['Tokens and keys', ['Bearer token', 'API key', 'JWT bearer', 'OAuth 2.0 (request)']],
  ['Username and password', ['Basic auth', 'Digest auth', 'NTLM', 'WSSE']],
  ['Request signing', ['AWS Signature', 'OAuth 1.0', 'Akamai EdgeGrid', 'Hawk']],
  ['Encrypted vault', ['Saved credential']],
];
export const AUTH_DESCRIPTIONS: Record<AuthType, string> = {
  None: 'Send the request without authorization.',
  'Inherit from collection': 'Use the default authentication configured for this collection.',
  'Bearer token': 'Sends Authorization: Bearer <token>.',
  'API key': 'Sends a key as a header or query parameter.',
  'JWT bearer': 'Signs a JSON Web Token locally and reuses it until shortly before it expires.',
  'Basic auth': 'Sends a Base64-encoded username and password.',
  'Digest auth': 'Answers the server’s Digest challenge (MD5 or SHA-256, including -sess).',
  'AWS Signature': 'Signs the request with AWS Signature Version 4.',
  'OAuth 1.0': 'Signs the request with OAuth 1.0a (HMAC-SHA1, HMAC-SHA256, or PLAINTEXT).',
  NTLM: 'Negotiates Windows NTLMv2 authentication with the server over one connection.',
  WSSE: 'Sends a WSSE UsernameToken with a hashed password, a nonce, and a timestamp.',
  'Akamai EdgeGrid': 'Signs the request with Akamai EdgeGrid (EG1-HMAC-SHA256).',
  Hawk: 'Signs the request with a Hawk MAC, optionally covering the body.',
  'OAuth 2.0 (request)':
    'Gets an OAuth 2.0 access token for this request and renews it automatically when possible.',
  'Saved credential': 'Uses a secret from the encrypted credential vault.',
};
export const SIGNING_AUTH_TYPES: AuthType[] = [
  'Digest auth',
  'JWT bearer',
  'AWS Signature',
  'OAuth 1.0',
  'NTLM',
  'WSSE',
  'Akamai EdgeGrid',
  'Hawk',
];
export const AUTH_TYPE_NAMES: string[] = AUTH_GROUPS.flatMap(([, types]) => types);
const AUTH_OPTION_KEYS: (keyof AuthOptions)[] = [
  'apiKeyIn',
  'awsRegion',
  'awsService',
  'awsSessionToken',
  'jwtAlgorithm',
  'jwtSecretBase64',
  'jwtPayload',
  'jwtHeader',
  'jwtPrefix',
  'jwtExpiresIn',
  'oauth1SignatureMethod',
  'oauth1Token',
  'oauth1TokenSecret',
  'oauth1Realm',
  'ntlmDomain',
  'ntlmWorkstation',
  'edgegridHeadersToSign',
  'edgegridMaxBody',
  'hawkAlgorithm',
  'hawkExt',
  'hawkApp',
  'hawkDlg',
  'hawkPayloadHash',
  'oauth2GrantType',
  'oauth2AuthorizationUrl',
  'oauth2TokenUrl',
  'oauth2ClientId',
  'oauth2ClientSecret',
  'oauth2ClientAuth',
  'oauth2Scope',
  'oauth2Audience',
  'oauth2Resource',
  'oauth2CallbackPort',
];
/** Requests saved before OAuth 2.0 profiles moved under Saved credential keep their profile. */
export const migratedAuthType = (value: unknown): unknown =>
  value === 'OAuth 2.0' ? 'Saved credential' : value;

/**
 * Authentication: the Auth tab's scope, JWT inspector, and inline OAuth state; collection
 * defaults that requests inherit; and the headers, query, and signing each auth type sends.
 */
export const useAuthenticationStore = defineStore('authentication', () => {
  const workspace = useWorkspaceStore();
  /** This request's auth, or the default its collection shares with inheriting requests. */
  const scope = ref<'request' | 'collection'>('request');
  /**
   * The collection or folder the 'collection' scope edits; empty, or not above the open request,
   * means the request's collection. Defaults are keyed by folder path in `collectionAuth`.
   */
  const scopeFolder = ref('');
  const scopeTarget = (request: ApiRequest): string =>
    scopeFolder.value && isWithin(request.folder, scopeFolder.value)
      ? scopeFolder.value
      : collectionOf(request.folder);
  const jwtInspectorOpen = ref(false);
  const oauthPending = ref(false);
  const resolve = (value: string) => workspace.resolve(value);

  /** The default auth saved on exactly this collection or folder. */
  const collectionAuth = (folder: string): AuthConfig | undefined =>
    payload.collectionAuthOf(workspace.state, folder);
  /**
   * The default a request in `folder` inherits, and the level it comes from: the nearest folder
   * (or the collection) whose default is not itself "Inherit from collection".
   */
  const inheritedAuth = (folder: string) => payload.inheritedAuth(workspace.state, folder);
  /** The default to edit; a folder's starts by inheriting, so opening it changes nothing. */
  function editableCollectionAuth(folder: string): AuthConfig {
    workspace.state.collectionAuth ||= {};
    const saved = folderEntry(workspace.state.collectionAuth, folder);
    if (saved) return saved;
    const created: AuthConfig = {
      auth: parentFolder(folder) === undefined ? 'None' : 'Inherit from collection',
      token: '',
      username: '',
      password: '',
    };
    setFolderEntry(workspace.state.collectionAuth, folder, created);
    return created;
  }
  /** The auth a request actually sends, following Inherit through its folders to the collection. */
  const effectiveAuth = (request: ApiRequest): AuthConfig =>
    payload.effectiveAuth(workspace.state, request);
  /** Headers, query parameters, and main-process signing for an auth configuration. */
  const applyRequestAuth = (config: AuthConfig) => payload.applyAuth(config, resolve);
  /** Keeps known string and boolean options from imported data. */
  function importedAuthOptions(value: unknown): AuthOptions | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const options = Object.fromEntries(
      AUTH_OPTION_KEYS.filter(
        (key) =>
          typeof source[key] === 'string' ||
          ((key === 'jwtSecretBase64' || key === 'hawkPayloadHash') &&
            typeof source[key] === 'boolean'),
      ).map((key) => [key, source[key]]),
    ) as AuthOptions;
    return Object.keys(options).length ? options : undefined;
  }
  function importedCollectionAuthConfig(value: unknown): Record<string, AuthConfig> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([folder, raw]) => {
        if (!raw || typeof raw !== 'object') return [];
        const config = { ...(raw as Record<string, unknown>) };
        config.auth = migratedAuthType(config.auth);
        if (
          !AUTH_TYPE_NAMES.includes(config.auth as string) ||
          config.auth === 'Inherit from collection'
        )
          return [];
        const text = (key: string) =>
          typeof config[key] === 'string' ? (config[key] as string) : '';
        return [
          [
            folder,
            {
              auth: config.auth as AuthType,
              token: text('token'),
              username: text('username'),
              password: text('password'),
              authOptions: importedAuthOptions(config.authOptions),
            },
          ],
        ];
      }),
    );
  }

  /** Builds the token request for an inline OAuth 2.0 configuration, resolving variables. */
  function inlineOAuthInput(
    config: AuthConfig,
    grantType: RequestOAuthInput['grantType'],
  ): RequestOAuthInput {
    const options = config.authOptions || {};
    const grant = options.oauth2GrantType || 'authorization_code';
    return {
      grantType,
      authorizationUrl: resolve(options.oauth2AuthorizationUrl || ''),
      tokenUrl: resolve(options.oauth2TokenUrl || ''),
      clientId: resolve(options.oauth2ClientId || ''),
      clientSecret: resolve(options.oauth2ClientSecret || '') || undefined,
      clientAuth: options.oauth2ClientAuth || (grant === 'authorization_code' ? 'none' : 'basic'),
      scope: resolve(options.oauth2Scope || ''),
      audience: resolve(options.oauth2Audience || ''),
      resource: resolve(options.oauth2Resource || '') || undefined,
      callbackPort: Number(resolve(options.oauth2CallbackPort || '')) || 43821,
      username: resolve(config.username),
      password: resolve(config.password),
      refreshToken: options.oauth2RefreshToken,
    };
  }
  function storeInlineOAuthTokens(config: AuthConfig, tokens: OAuthTokens): void {
    config.token = tokens.accessToken;
    config.authOptions = {
      ...config.authOptions,
      oauth2RefreshToken: tokens.refreshToken || config.authOptions?.oauth2RefreshToken,
      oauth2ExpiresAt: tokens.expiresAt,
    };
  }
  /** Renews an inline OAuth 2.0 token before sending when it is missing or expired and renewal needs no browser. */
  async function ensureInlineOAuthToken(request: ApiRequest): Promise<void> {
    const config = effectiveAuth(request);
    if (config.auth !== 'OAuth 2.0 (request)' || !window.workbench?.oauth) return;
    const options = config.authOptions || {};
    // Renew 30 seconds early so the token does not expire in flight.
    const stale =
      !config.token ||
      (options.oauth2ExpiresAt !== undefined && options.oauth2ExpiresAt - 30000 <= Date.now());
    if (!stale) return;
    const grant = options.oauth2GrantType || 'authorization_code';
    const renewal = options.oauth2RefreshToken
      ? 'refresh_token'
      : grant === 'authorization_code'
        ? undefined
        : grant;
    if (!renewal) return;
    storeInlineOAuthTokens(
      config,
      await window.workbench.oauth.token(inlineOAuthInput(config, renewal)),
    );
    workspace.persist();
  }
  return {
    scope,
    scopeFolder,
    scopeTarget,
    inheritedAuth,
    jwtInspectorOpen,
    oauthPending,
    collectionAuth,
    editableCollectionAuth,
    effectiveAuth,
    applyRequestAuth,
    importedAuthOptions,
    importedCollectionAuthConfig,
    inlineOAuthInput,
    storeInlineOAuthTokens,
    ensureInlineOAuthToken,
  };
});
