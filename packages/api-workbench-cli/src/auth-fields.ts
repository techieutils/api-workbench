import { HAWK_ALGORITHMS, JWT_ALGORITHMS } from '@techieutils/api-workbench-common/auth-signing';
import type { ApiRequest, AuthOptions } from '@techieutils/api-workbench-common/types';
import { dynamicValue } from '@techieutils/api-workbench-common/variables';
import { requestOAuthToken } from '@techieutils/api-workbench-electron/oauth';
import { SECRET_OPTIONS, takeAuth } from '@techieutils/api-workbench-electron/team-files';
import { UsageError } from './args';
import {
  findRequest,
  one,
  positionals,
  printable,
  variableAssignment,
  type CommandContext,
  type Parsed,
} from './command-kit';
import { chooseEnvironment } from './run';
import { sourceFromTarget } from './source';
import type { Target } from './target';

/**
 * Every kind of auth from the command line, as the app's Auth tab sets it: the type-specific
 * settings, and their secrets, which come from an environment variable and are never printed.
 */

/** `--auth` names, as `request update` takes them, and the app's auth types they are. */
export const AUTH_NAMES: Record<string, ApiRequest['auth']> = {
  none: 'None',
  inherit: 'Inherit from collection',
  bearer: 'Bearer token',
  basic: 'Basic auth',
  'api-key': 'API key',
  digest: 'Digest auth',
  jwt: 'JWT bearer',
  aws: 'AWS Signature',
  oauth1: 'OAuth 1.0',
  ntlm: 'NTLM',
  wsse: 'WSSE',
  edgegrid: 'Akamai EdgeGrid',
  hawk: 'Hawk',
  oauth2: 'OAuth 2.0 (request)',
  credential: 'Saved credential',
};

/** Settings that are plain text: regions, URLs, claims, names. */
const TEXT_OPTIONS = [
  'awsRegion',
  'awsService',
  'jwtPayload',
  'jwtHeader',
  'jwtPrefix',
  'jwtExpiresIn',
  'oauth1Realm',
  'ntlmDomain',
  'ntlmWorkstation',
  'edgegridHeadersToSign',
  'edgegridMaxBody',
  'hawkExt',
  'hawkApp',
  'hawkDlg',
  'oauth2AuthorizationUrl',
  'oauth2TokenUrl',
  'oauth2ClientId',
  'oauth2Scope',
  'oauth2Audience',
  'oauth2Resource',
  'oauth2CallbackPort',
] as const satisfies readonly (keyof AuthOptions)[];
/** Settings chosen from a list. */
const CHOICE_OPTIONS: Partial<Record<keyof AuthOptions, readonly string[]>> = {
  apiKeyIn: ['header', 'query'],
  jwtAlgorithm: JWT_ALGORITHMS,
  oauth1SignatureMethod: ['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'],
  hawkAlgorithm: HAWK_ALGORITHMS,
  oauth2GrantType: ['authorization_code', 'client_credentials', 'password'],
  oauth2ClientAuth: ['none', 'basic', 'body'],
};
const BOOLEAN_OPTIONS = ['jwtSecretBase64', 'hawkPayloadHash'] as const;
/** Secret settings that can be typed in; a refresh token and its expiry come only from a token. */
const SETTABLE_SECRETS = [
  'awsSessionToken',
  'oauth1Token',
  'oauth1TokenSecret',
  'oauth2ClientSecret',
] as const satisfies readonly (keyof AuthOptions)[];
/** What a hidden value reads as: a value still `<hidden>` keeps the saved one. */
const HIDDEN = '<hidden>';
const MAX = 64 * 1024;

/**
 * Applies `--auth-fields-from-env <VAR>`: the variable holds JSON, `{"username", "password",
 * "token", "options": {…}}`, each optional. An option set to `null` or `""` is removed.
 */
export function updateAuthFields(request: ApiRequest, text: string | undefined): void {
  if (text === undefined) return;
  let fields: unknown;
  try {
    fields = JSON.parse(text);
  } catch {
    throw new UsageError(
      '--auth-fields-from-env reads JSON: {"username", "password", "token", "options": {…}}.',
    );
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new UsageError('--auth-fields-from-env reads a JSON object.');
  const given = fields as Record<string, unknown>;
  for (const key of Object.keys(given))
    if (!['username', 'password', 'token', 'options'].includes(key))
      throw new UsageError(`--auth-fields-from-env has no field “${printable(key)}”.`);
  const value = (key: string, input: unknown): string | undefined => {
    if (input === undefined || input === HIDDEN) return undefined;
    if (typeof input !== 'string' || input.length > MAX)
      throw new UsageError(`The auth field “${key}” is text.`);
    return input;
  };
  const username = value('username', given.username);
  if (username !== undefined) {
    if (/[\r\n]/.test(username)) throw new UsageError('A username is one line.');
    request.username = username;
  }
  const password = value('password', given.password);
  if (password !== undefined) request.password = password;
  const token = value('token', given.token);
  if (token !== undefined) {
    request.token = token;
    // A token typed in has no known expiry; the one from `request token` sets it again.
    if (request.authOptions?.oauth2ExpiresAt !== undefined) {
      const { oauth2ExpiresAt: _expired, ...rest } = request.authOptions;
      request.authOptions = rest;
    }
  }
  if (given.options === undefined) return;
  if (!given.options || typeof given.options !== 'object' || Array.isArray(given.options))
    throw new UsageError('The auth field “options” is an object.');
  const options: Record<string, unknown> = { ...request.authOptions };
  for (const [key, input] of Object.entries(given.options as Record<string, unknown>)) {
    if (input === undefined || input === HIDDEN) continue;
    if (input === null || input === '') {
      if (!knownOption(key)) throw new UsageError(`No auth option “${printable(key)}”.`);
      delete options[key];
      continue;
    }
    if ((TEXT_OPTIONS as readonly string[]).includes(key)) {
      options[key] = value(key, input);
    } else if ((SETTABLE_SECRETS as readonly string[]).includes(key)) {
      options[key] = value(key, input);
    } else if (Object.hasOwn(CHOICE_OPTIONS, key)) {
      const allowed = CHOICE_OPTIONS[key as keyof AuthOptions]!;
      if (typeof input !== 'string' || !allowed.includes(input))
        throw new UsageError(`The auth option “${key}” is ${allowed.join(', ')}.`);
      options[key] = input;
    } else if ((BOOLEAN_OPTIONS as readonly string[]).includes(key)) {
      if (typeof input !== 'boolean')
        throw new UsageError(`The auth option “${key}” is true or false.`);
      options[key] = input;
    } else throw new UsageError(`No auth option “${printable(key)}”.`);
  }
  request.authOptions = options as AuthOptions;
}

const knownOption = (key: string) =>
  (TEXT_OPTIONS as readonly string[]).includes(key) ||
  (SETTABLE_SECRETS as readonly string[]).includes(key) ||
  Object.hasOwn(CHOICE_OPTIONS, key) ||
  (BOOLEAN_OPTIONS as readonly string[]).includes(key);

/**
 * A request's auth as `request show --json` gives it: settings as they are, and for each secret
 * only whether it is saved, never its value.
 */
export function authDetails(request: ApiRequest) {
  const all = (request.authOptions ?? {}) as Record<string, unknown>;
  const options = Object.fromEntries(
    Object.entries(all).filter(
      ([key, value]) =>
        !(SECRET_OPTIONS as readonly string[]).includes(key) &&
        (typeof value === 'string' || typeof value === 'boolean'),
    ),
  );
  const saved = [
    ...(request.password ? ['password'] : []),
    ...(request.token ? ['token'] : []),
    ...SECRET_OPTIONS.filter((key) => key !== 'oauth2ExpiresAt' && all[key]),
  ];
  return {
    type: request.auth,
    username: request.username ?? '',
    hasSecret: Boolean(request.token || request.password),
    apiKeyIn: request.authOptions?.apiKeyIn ?? 'header',
    ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    options,
    saved,
    ...(typeof all.oauth2ExpiresAt === 'number' ? { expiresAt: all.oauth2ExpiresAt } : {}),
  };
}

/**
 * A team folder shares no secret values. One the app on this computer has open keeps a request's
 * literal token, password, or secret setting with the app's own secrets for it; one it does not
 * would lose them with the command line's temporary copy, so they are refused instead.
 */
export function teamSecretsProblem(target: Target, request: ApiRequest): void {
  if (!target.joined || target.keepAuthSecrets) return;
  const [, secrets] = takeAuth(request);
  if (secrets.token || secrets.password || Object.keys(secrets.authOptions ?? {}).length)
    throw new UsageError(
      'A team folder keeps no secret values here: use a {{variable}} from an environment, or open the folder in the API Workbench app on this computer, which keeps them for you.',
    );
}

/**
 * `request token`: gets a request's OAuth 2.0 access token as **Get new access token** does in the
 * app, and keeps it, its refresh token, and when it expires in the request. The token itself is
 * never printed. An authorization-code grant prints the address to sign in at and waits for the
 * browser to come back; `--refresh` uses the saved refresh token instead.
 */
export async function requestToken(
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const asJson = parsed.flags.has('--json');
  const [wanted] = positionals(parsed, ['request']);
  const request = findRequest(target.state, wanted);
  if (request.auth !== 'OAuth 2.0 (request)')
    throw new UsageError(`${printable(request.name)} does not use OAuth 2.0 auth.`);
  const environment = chooseEnvironment(sourceFromTarget(target), {
    environment: one(parsed, '--environment'),
    variables: (parsed.values.get('--var') ?? []).map((text) =>
      variableAssignment(text, context.env),
    ),
  });
  const resolve = (value: string | undefined) =>
    String(value ?? '').replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const name = key.trim();
      return (
        environment?.variables.find((variable) => variable.enabled && variable.key === name)
          ?.value ??
        dynamicValue(name) ??
        match
      );
    });
  const options = request.authOptions ?? {};
  const grant = options.oauth2GrantType || 'authorization_code';
  const refresh = parsed.flags.has('--refresh');
  if (refresh && !options.oauth2RefreshToken)
    throw new UsageError(`${printable(request.name)} has no refresh token: get a new token.`);
  // Where the token will be kept, before the provider is asked for one.
  if (target.joined && !target.keepAuthSecrets)
    throw new UsageError(
      'A team folder keeps no tokens here: open it in the API Workbench app on this computer, which keeps them for you.',
    );
  const controller = new AbortController();
  const stop = () => controller.abort();
  context.interrupt?.addEventListener('abort', stop, { once: true });
  let tokens: Awaited<ReturnType<typeof requestOAuthToken>>;
  try {
    tokens = await requestOAuthToken(
      {
        grantType: refresh ? 'refresh_token' : grant,
        authorizationUrl: resolve(options.oauth2AuthorizationUrl),
        tokenUrl: resolve(options.oauth2TokenUrl),
        clientId: resolve(options.oauth2ClientId),
        clientSecret: resolve(options.oauth2ClientSecret) || undefined,
        clientAuth: options.oauth2ClientAuth || (grant === 'authorization_code' ? 'none' : 'basic'),
        scope: resolve(options.oauth2Scope),
        audience: resolve(options.oauth2Audience),
        resource: resolve(options.oauth2Resource) || undefined,
        callbackPort: Number(resolve(options.oauth2CallbackPort)) || 43821,
        username: resolve(request.username),
        password: resolve(request.password),
        refreshToken: options.oauth2RefreshToken,
      },
      async (url) => {
        // The address holds no secret: PKCE keeps the verifier here.
        if (asJson) output.out(JSON.stringify({ type: 'authorize', url }));
        else output.err(`Sign in at this address; this waits for your browser:\n${url}`);
      },
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) throw new UsageError('Stopped before a token was received.');
    throw new UsageError((error as Error).message);
  } finally {
    context.interrupt?.removeEventListener('abort', stop);
  }
  request.token = tokens.accessToken;
  request.authOptions = {
    ...request.authOptions,
    oauth2RefreshToken: tokens.refreshToken || request.authOptions?.oauth2RefreshToken,
    oauth2ExpiresAt: tokens.expiresAt,
  };
  if (!request.authOptions.oauth2RefreshToken) delete request.authOptions.oauth2RefreshToken;
  if (request.authOptions.oauth2ExpiresAt === undefined) delete request.authOptions.oauth2ExpiresAt;
  await target.save();
  await target.keepAuthSecrets?.(request);
  const result = {
    type: 'token',
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    refreshToken: Boolean(request.authOptions.oauth2RefreshToken),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
  // One line, as the authorize line before it, for whatever reads the output line by line.
  if (asJson) output.out(JSON.stringify(result));
  else
    output.out(
      `Got an access token for “${printable(request.name)}”${
        tokens.expiresAt ? `, until ${new Date(tokens.expiresAt).toLocaleString()}` : ''
      }.`,
    );
  return 0;
}
