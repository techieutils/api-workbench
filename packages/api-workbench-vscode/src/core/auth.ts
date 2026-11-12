/**
 * The auth types the request editor sets with a form of their own — JWT, AWS Signature, OAuth 1.0
 * and 2.0, NTLM, WSSE, Akamai EdgeGrid, and Hawk — described as data: the webview draws a form
 * from it, and `draftFrom` accepts only the fields it names. The labels match the app's Auth tab.
 */

export interface AuthField {
  /** `username`, `password`, `token`, or a setting's name (`awsRegion`, `oauth2TokenUrl`, …). */
  key: string;
  label: string;
  /** `secret` is never shown once saved: a new value replaces it. */
  kind: 'text' | 'secret' | 'multiline' | 'secretMultiline' | 'choice' | 'check';
  placeholder?: string;
  choices?: readonly { value: string; label: string }[];
  /** What it is when the request has none saved. */
  initial?: string | boolean;
  /** Takes a whole row: URLs and other long values. */
  wide?: boolean;
  /** Shown only while another field has one of these values. */
  when?: { key: string; values: readonly string[] };
}

const choices = (...values: string[]) => values.map((value) => ({ value, label: value }));
/**
 * The JWT algorithms common's signing supports (`auth.spec.ts` checks they match); copied, as the
 * webview's bundle cannot load the signing code, which needs Node's crypto.
 */
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
];
const HMAC = JWT_ALGORITHMS.filter((name) => name.startsWith('HS'));

export const AUTH_FORMS: Record<string, readonly AuthField[]> = {
  'JWT bearer': [
    {
      key: 'jwtAlgorithm',
      label: 'Algorithm',
      kind: 'choice',
      choices: choices(...JWT_ALGORITHMS),
      initial: 'HS256',
    },
    {
      key: 'jwtPrefix',
      label: 'Header prefix',
      kind: 'text',
      placeholder: 'Bearer',
      initial: 'Bearer',
    },
    {
      key: 'jwtExpiresIn',
      label: 'Expires in (seconds)',
      kind: 'text',
      placeholder: '0 = no exp claim',
    },
    {
      key: 'password',
      label: 'Secret',
      kind: 'secret',
      placeholder: 'Shared secret or {{variable}}',
      when: { key: 'jwtAlgorithm', values: HMAC },
    },
    {
      key: 'jwtSecretBase64',
      label: 'Secret is Base64 encoded',
      kind: 'check',
      when: { key: 'jwtAlgorithm', values: HMAC },
    },
    {
      key: 'password',
      label: 'Private key (PEM)',
      kind: 'secretMultiline',
      placeholder: '-----BEGIN PRIVATE KEY-----',
      when: {
        key: 'jwtAlgorithm',
        values: JWT_ALGORITHMS.filter((name) => !name.startsWith('HS')),
      },
    },
    {
      key: 'jwtPayload',
      label: 'Payload (JSON)',
      kind: 'multiline',
      placeholder: '{"sub": "{{user_id}}"}',
    },
    {
      key: 'jwtHeader',
      label: 'Extra header claims (JSON, optional)',
      kind: 'multiline',
      placeholder: '{"kid": "key-1"}',
    },
  ],
  'AWS Signature': [
    {
      key: 'username',
      label: 'Access key ID',
      kind: 'text',
      placeholder: 'AKIA… or {{aws_access_key}}',
    },
    { key: 'password', label: 'Secret access key', kind: 'secret' },
    { key: 'awsRegion', label: 'Region', kind: 'text', placeholder: 'us-east-1' },
    { key: 'awsService', label: 'Service', kind: 'text', placeholder: 'execute-api, s3, lambda…' },
    {
      key: 'awsSessionToken',
      label: 'Session token (optional)',
      kind: 'secret',
      placeholder: 'For temporary credentials',
    },
  ],
  'OAuth 1.0': [
    { key: 'username', label: 'Consumer key', kind: 'text' },
    { key: 'password', label: 'Consumer secret', kind: 'secret' },
    { key: 'oauth1Token', label: 'Access token', kind: 'secret', placeholder: 'Optional' },
    { key: 'oauth1TokenSecret', label: 'Token secret', kind: 'secret', placeholder: 'Optional' },
    {
      key: 'oauth1SignatureMethod',
      label: 'Signature method',
      kind: 'choice',
      choices: choices('HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'),
      initial: 'HMAC-SHA1',
    },
    { key: 'oauth1Realm', label: 'Realm', kind: 'text', placeholder: 'Optional' },
  ],
  NTLM: [
    { key: 'username', label: 'Username', kind: 'text', placeholder: 'user, or DOMAIN\\user' },
    { key: 'password', label: 'Password', kind: 'secret' },
    { key: 'ntlmDomain', label: 'Domain', kind: 'text', placeholder: 'Optional' },
    { key: 'ntlmWorkstation', label: 'Workstation', kind: 'text', placeholder: 'Optional' },
  ],
  WSSE: [
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'secret' },
  ],
  'Akamai EdgeGrid': [
    {
      key: 'username',
      label: 'Client token',
      kind: 'text',
      placeholder: 'akab-… or {{client_token}}',
    },
    { key: 'password', label: 'Client secret', kind: 'secret' },
    {
      key: 'token',
      label: 'Access token',
      kind: 'secret',
      placeholder: 'akab-… or {{access_token}}',
    },
    {
      key: 'edgegridHeadersToSign',
      label: 'Headers to sign (optional)',
      wide: true,
      kind: 'text',
      placeholder: 'X-Custom-Header, Content-Type',
    },
    { key: 'edgegridMaxBody', label: 'Max body size (bytes)', kind: 'text', placeholder: '131072' },
  ],
  Hawk: [
    { key: 'username', label: 'Hawk ID', kind: 'text' },
    { key: 'password', label: 'Hawk key', kind: 'secret' },
    {
      key: 'hawkAlgorithm',
      label: 'Algorithm',
      kind: 'choice',
      choices: choices('sha256', 'sha1'),
      initial: 'sha256',
    },
    { key: 'hawkExt', label: 'Extra data (ext)', kind: 'text', placeholder: 'Optional' },
    { key: 'hawkApp', label: 'App ID', kind: 'text', placeholder: 'Optional' },
    {
      key: 'hawkDlg',
      label: 'Delegated by (dlg)',
      kind: 'text',
      placeholder: 'Optional, with an app ID',
    },
    { key: 'hawkPayloadHash', label: 'Include a payload hash', kind: 'check' },
  ],
  'OAuth 2.0 (request)': [
    {
      key: 'oauth2GrantType',
      label: 'Grant type',
      kind: 'choice',
      choices: [
        { value: 'authorization_code', label: 'Authorization code (PKCE)' },
        { value: 'client_credentials', label: 'Client credentials' },
        { value: 'password', label: 'Password' },
      ],
      initial: 'authorization_code',
    },
    {
      key: 'oauth2ClientAuth',
      label: 'Client authentication',
      kind: 'choice',
      choices: [
        { value: 'none', label: 'None (public client)' },
        { value: 'basic', label: 'Basic header' },
        { value: 'body', label: 'In the request body' },
      ],
    },
    {
      key: 'oauth2AuthorizationUrl',
      label: 'Authorization URL',
      wide: true,
      kind: 'text',
      placeholder: 'https://identity.example.com/authorize',
      when: { key: 'oauth2GrantType', values: ['authorization_code'] },
    },
    {
      key: 'oauth2TokenUrl',
      label: 'Token URL',
      wide: true,
      kind: 'text',
      placeholder: 'https://identity.example.com/oauth/token',
    },
    { key: 'oauth2ClientId', label: 'Client ID', kind: 'text' },
    {
      key: 'oauth2ClientSecret',
      label: 'Client secret',
      kind: 'secret',
      placeholder: 'Optional for a public client',
    },
    { key: 'oauth2Scope', label: 'Scope', kind: 'text', placeholder: 'read write' },
    {
      key: 'oauth2Audience',
      label: 'Audience',
      wide: true,
      kind: 'text',
      placeholder: 'Optional · some providers, such as Auth0, require it',
    },
    {
      key: 'oauth2Resource',
      label: 'Resource',
      wide: true,
      kind: 'text',
      placeholder: 'Optional · the API the token is for (RFC 8707)',
    },
    {
      key: 'oauth2CallbackPort',
      label: 'Callback port',
      kind: 'text',
      placeholder: '43821',
      when: { key: 'oauth2GrantType', values: ['authorization_code'] },
    },
    {
      key: 'username',
      label: 'Username',
      kind: 'text',
      when: { key: 'oauth2GrantType', values: ['password'] },
    },
    {
      key: 'password',
      label: 'Password',
      kind: 'secret',
      when: { key: 'oauth2GrantType', values: ['password'] },
    },
    {
      key: 'token',
      label: 'Access token',
      kind: 'secret',
      placeholder: 'Get a token, or paste one',
      wide: true,
    },
  ],
};

/** Fields whose values are secrets: never sent to VS Code, only replaced. */
export const SECRET_FIELDS = new Set(
  Object.values(AUTH_FORMS).flatMap((fields) =>
    fields
      .filter((field) => field.kind === 'secret' || field.kind === 'secretMultiline')
      .map((field) => field.key),
  ),
);
/** Settings (beyond username) that are not secrets, by name, and whether each is a check box. */
export const OPTION_FIELDS = new Map(
  Object.values(AUTH_FORMS).flatMap((fields) =>
    fields
      .filter((field) => !SECRET_FIELDS.has(field.key) && field.key !== 'username')
      .map((field) => [field.key, field] as const),
  ),
);

/** The value a field has in the editor: a setting as saved, or its initial value. */
export function optionValue(
  options: Record<string, string | boolean>,
  field: AuthField,
): string | boolean {
  if (field.key === 'oauth2ClientAuth' && options[field.key] === undefined)
    // As in the app: a public client by default with a browser sign-in, Basic otherwise.
    return (options.oauth2GrantType ?? 'authorization_code') === 'authorization_code'
      ? 'none'
      : 'basic';
  return options[field.key] ?? field.initial ?? (field.kind === 'check' ? false : '');
}

/** Whether a field shows, given the other settings (a JWT's key, OAuth 2.0's grant). */
export function fieldShows(
  options: Record<string, string | boolean>,
  field: AuthField,
  fields: readonly AuthField[],
): boolean {
  if (!field.when) return true;
  const other = fields.find((item) => item.key === field.when!.key);
  const value = other ? optionValue(options, other) : options[field.when.key];
  return field.when.values.includes(String(value));
}
