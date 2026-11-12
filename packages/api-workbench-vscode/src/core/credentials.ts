/**
 * The Credentials page: saved credentials as the app's Credentials screen lists them, and the form
 * that adds or changes one — every kind but client certificates, with each kind's fields as the
 * app has them. A saved secret is never sent to VS Code; one typed in the form goes to the
 * command line's environment only, and an empty one keeps what is saved. What the page posts is
 * checked here before the extension uses it.
 */

/** `secret list --json`: settings and whether secrets are saved, never their values. */
export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  origin: string;
  hasSecret: boolean;
  hasExtraSecret?: boolean;
  updatedAt?: string;
  username?: string;
  headerName?: string;
  options?: Record<string, string | boolean>;
  oauth?: Record<string, string | number>;
  connected?: boolean;
  expiresAt?: number;
  /** Kept by an external provider, or a client certificate: changed in the app. */
  external?: boolean;
  certificate?: boolean;
}

export interface CredentialsView {
  view: 'credentials';
  workspace: string;
  vault: 'unlocked' | 'locked';
  credentials: CredentialRow[];
  /** The one open in the form: `new`, or a credential's id. */
  editing?: string;
  saving?: boolean;
  error?: string;
  /** Changes on each save, so the page drops the form's edits for what was saved. */
  revision: number;
}

export interface CredentialField {
  /** `username`, `headerName`, `secret`, `extraSecret`, `options.<name>`, or `oauth.<name>`. */
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'secretMultiline' | 'multiline' | 'choice' | 'check' | 'number';
  placeholder?: string;
  choices?: readonly { value: string; label: string }[];
  initial?: string | boolean | number;
  /** Shown only while another field has one of these values. */
  when?: { key: string; values: readonly string[] };
}

const choices = (...values: string[]) => values.map((value) => ({ value, label: value }));
const JWT_HMAC = ['HS256', 'HS384', 'HS512'];
const JWT_ALL = [...JWT_HMAC, 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'];

/** The kinds the page makes, in the app's order, with what each is called. */
export const CREDENTIAL_KINDS: readonly { value: string; label: string }[] = [
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic auth' },
  { value: 'api-key', label: 'API key' },
  { value: 'oauth2', label: 'OAuth 2.0' },
  { value: 'digest', label: 'Digest' },
  { value: 'jwt', label: 'JWT' },
  { value: 'aws', label: 'AWS Signature' },
  { value: 'oauth1', label: 'OAuth 1.0' },
  { value: 'ntlm', label: 'NTLM' },
  { value: 'wsse', label: 'WSSE' },
  { value: 'edgegrid', label: 'Akamai EdgeGrid' },
  { value: 'hawk', label: 'Hawk' },
];

export const CREDENTIAL_FORMS: Record<string, readonly CredentialField[]> = {
  bearer: [{ key: 'secret', label: 'Token', kind: 'secret', placeholder: 'The bearer token' }],
  basic: [
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'secret', label: 'Password', kind: 'secret' },
  ],
  'api-key': [
    {
      key: 'headerName',
      label: 'Name',
      kind: 'text',
      placeholder: 'X-API-Key',
      initial: 'X-API-Key',
    },
    {
      key: 'options.apiKeyIn',
      label: 'Sent in',
      kind: 'choice',
      choices: [
        { value: 'header', label: 'A header' },
        { value: 'query', label: 'A query parameter' },
      ],
      initial: 'header',
    },
    { key: 'secret', label: 'Key', kind: 'secret' },
  ],
  digest: [
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'secret', label: 'Password', kind: 'secret' },
  ],
  jwt: [
    {
      key: 'options.jwtAlgorithm',
      label: 'Algorithm',
      kind: 'choice',
      choices: choices(...JWT_ALL),
      initial: 'HS256',
    },
    {
      key: 'options.jwtPrefix',
      label: 'Header prefix',
      kind: 'text',
      placeholder: 'Bearer',
      initial: 'Bearer',
    },
    {
      key: 'options.jwtExpiresIn',
      label: 'Expires in (seconds)',
      kind: 'text',
      placeholder: '0 = no exp claim',
    },
    {
      key: 'secret',
      label: 'Secret',
      kind: 'secret',
      when: { key: 'options.jwtAlgorithm', values: JWT_HMAC },
    },
    {
      key: 'options.jwtSecretBase64',
      label: 'Secret is Base64 encoded',
      kind: 'check',
      when: { key: 'options.jwtAlgorithm', values: JWT_HMAC },
    },
    {
      key: 'secret',
      label: 'Private key (PEM)',
      kind: 'secretMultiline',
      placeholder: '-----BEGIN PRIVATE KEY-----',
      when: {
        key: 'options.jwtAlgorithm',
        values: JWT_ALL.filter((name) => !JWT_HMAC.includes(name)),
      },
    },
    {
      key: 'options.jwtPayload',
      label: 'Payload (JSON)',
      kind: 'multiline',
      placeholder: '{"sub": "service"}',
    },
    { key: 'options.jwtHeader', label: 'Extra header claims (JSON, optional)', kind: 'multiline' },
  ],
  aws: [
    { key: 'username', label: 'Access key ID', kind: 'text', placeholder: 'AKIA…' },
    { key: 'secret', label: 'Secret access key', kind: 'secret' },
    { key: 'options.awsRegion', label: 'Region', kind: 'text', placeholder: 'us-east-1' },
    { key: 'options.awsService', label: 'Service', kind: 'text', placeholder: 'execute-api' },
    { key: 'extraSecret', label: 'Session token (optional)', kind: 'secret' },
  ],
  oauth1: [
    { key: 'username', label: 'Consumer key', kind: 'text' },
    { key: 'secret', label: 'Consumer secret', kind: 'secret' },
    { key: 'options.oauth1Token', label: 'Access token', kind: 'text', placeholder: 'Optional' },
    { key: 'extraSecret', label: 'Token secret', kind: 'secret', placeholder: 'Optional' },
    {
      key: 'options.oauth1SignatureMethod',
      label: 'Signature method',
      kind: 'choice',
      choices: choices('HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'),
      initial: 'HMAC-SHA1',
    },
    { key: 'options.oauth1Realm', label: 'Realm', kind: 'text', placeholder: 'Optional' },
  ],
  ntlm: [
    { key: 'username', label: 'Username', kind: 'text', placeholder: 'user, or DOMAIN\\user' },
    { key: 'secret', label: 'Password', kind: 'secret' },
    { key: 'options.ntlmDomain', label: 'Domain', kind: 'text', placeholder: 'Optional' },
    { key: 'options.ntlmWorkstation', label: 'Workstation', kind: 'text', placeholder: 'Optional' },
  ],
  wsse: [
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'secret', label: 'Password', kind: 'secret' },
  ],
  edgegrid: [
    { key: 'username', label: 'Client token', kind: 'text', placeholder: 'akab-…' },
    { key: 'secret', label: 'Client secret', kind: 'secret' },
    { key: 'extraSecret', label: 'Access token', kind: 'secret' },
    { key: 'options.edgegridHeadersToSign', label: 'Headers to sign (optional)', kind: 'text' },
    {
      key: 'options.edgegridMaxBody',
      label: 'Max body size (bytes)',
      kind: 'text',
      placeholder: '131072',
    },
  ],
  hawk: [
    { key: 'username', label: 'Hawk ID', kind: 'text' },
    { key: 'secret', label: 'Hawk key', kind: 'secret' },
    {
      key: 'options.hawkAlgorithm',
      label: 'Algorithm',
      kind: 'choice',
      choices: choices('sha256', 'sha1'),
      initial: 'sha256',
    },
    { key: 'options.hawkExt', label: 'Extra data (ext)', kind: 'text', placeholder: 'Optional' },
    { key: 'options.hawkApp', label: 'App ID', kind: 'text', placeholder: 'Optional' },
    { key: 'options.hawkDlg', label: 'Delegated by (dlg)', kind: 'text', placeholder: 'Optional' },
    { key: 'options.hawkPayloadHash', label: 'Include a payload hash', kind: 'check' },
  ],
  oauth2: [
    {
      key: 'oauth.grantType',
      label: 'Grant type',
      kind: 'choice',
      choices: [
        { value: 'client_credentials', label: 'Client credentials' },
        { value: 'authorization_code', label: 'Authorization code (PKCE)' },
      ],
      initial: 'client_credentials',
    },
    {
      key: 'oauth.clientAuth',
      label: 'Client authentication',
      kind: 'choice',
      choices: [
        { value: 'basic', label: 'Basic header' },
        { value: 'body', label: 'In the request body' },
        { value: 'none', label: 'None (public client)' },
      ],
      initial: 'basic',
    },
    {
      key: 'oauth.authorizationUrl',
      label: 'Authorization URL',
      kind: 'text',
      when: { key: 'oauth.grantType', values: ['authorization_code'] },
    },
    {
      key: 'oauth.tokenUrl',
      label: 'Token URL',
      kind: 'text',
      placeholder: 'https://identity.example.com/oauth/token',
    },
    { key: 'oauth.clientId', label: 'Client ID', kind: 'text' },
    {
      key: 'oauth.clientSecret',
      label: 'Client secret',
      kind: 'secret',
      placeholder: 'Optional for a public client',
    },
    { key: 'oauth.scope', label: 'Scope', kind: 'text', placeholder: 'read write' },
    { key: 'oauth.audience', label: 'Audience', kind: 'text', placeholder: 'Optional' },
    { key: 'oauth.resource', label: 'Resource', kind: 'text', placeholder: 'Optional' },
    {
      key: 'oauth.callbackPort',
      label: 'Callback port',
      kind: 'number',
      initial: 43821,
      when: { key: 'oauth.grantType', values: ['authorization_code'] },
    },
  ],
};

const SECRET_KINDS = new Set(['secret', 'secretMultiline']);

/** A field's value as the form starts it: the credential's, or the kind's default. */
export function credentialValue(
  row: CredentialRow | undefined,
  field: CredentialField,
): string | boolean | number {
  if (SECRET_KINDS.has(field.kind)) return '';
  const [group, name] = field.key.split('.');
  const value =
    group === 'options'
      ? row?.options?.[name]
      : group === 'oauth'
        ? row?.oauth?.[name]
        : (row as unknown as Record<string, unknown> | undefined)?.[group];
  if (value !== undefined && value !== '') return value as string | boolean | number;
  return field.initial ?? (field.kind === 'check' ? false : '');
}

/** Whether a secret field already has a value saved, so leaving it empty keeps it. */
export function secretSaved(row: CredentialRow | undefined, field: CredentialField): boolean {
  if (!row) return false;
  if (field.key === 'secret') return row.hasSecret;
  if (field.key === 'extraSecret') return Boolean(row.hasExtraSecret);
  // An OAuth client secret is not listed; the vault keeps it unless a new one is given.
  return field.key === 'oauth.clientSecret' && row.type === 'oauth2';
}

/** Whether a field shows, given the form's other values. */
export function credentialFieldShows(
  values: Record<string, unknown>,
  field: CredentialField,
): boolean {
  return !field.when || field.when.values.includes(String(values[field.when.key]));
}

/** What `secret set` takes: its arguments, and the fields (secrets among them) as JSON. */
export interface CredentialSave {
  name: string;
  type: string;
  origin: string;
  /** `secret set --fields-from-env`: only what was given; secrets left empty keep what is saved. */
  fields: Record<string, unknown>;
  /** Whether it is a new credential, which needs its secret. */
  isNew: boolean;
}

/** The form a page posted, checked; or why it cannot be saved. */
export function credentialFrom(
  value: unknown,
  rows: readonly CredentialRow[],
): CredentialSave | string {
  if (!value || typeof value !== 'object') return 'The form could not be read.';
  const given = value as {
    id?: unknown;
    name?: unknown;
    type?: unknown;
    origin?: unknown;
    values?: unknown;
  };
  const existing =
    typeof given.id === 'string' ? rows.find((row) => row.id === given.id) : undefined;
  if (given.id !== undefined && given.id !== 'new' && !existing) return 'That credential is gone.';
  const name = typeof given.name === 'string' ? given.name.trim() : '';
  if (!name || name.length > 100 || /[\r\n]/.test(name)) return 'Give it a name, on one line.';
  if (!existing && rows.some((row) => row.name.toLowerCase() === name.toLowerCase()))
    return `There is already a credential “${name}”.`;
  const type = typeof given.type === 'string' ? given.type : '';
  const form = Object.prototype.hasOwnProperty.call(CREDENTIAL_FORMS, type)
    ? CREDENTIAL_FORMS[type]
    : undefined;
  if (!form) return 'Choose its kind.';
  const origin = typeof given.origin === 'string' ? given.origin.trim() : '';
  try {
    if (!['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error();
  } catch {
    return 'Its allowed origin is an http or https address, such as https://api.example.com.';
  }
  const values = (given.values && typeof given.values === 'object' ? given.values : {}) as Record<
    string,
    unknown
  >;
  const fields: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  const oauth: Record<string, unknown> = {};
  const isNew = !existing || existing.type !== type;
  for (const field of form) {
    if (!credentialFieldShows(values, field)) continue;
    const raw = Object.prototype.hasOwnProperty.call(values, field.key)
      ? values[field.key]
      : undefined;
    let item: unknown;
    if (field.kind === 'check') {
      if (raw !== undefined && typeof raw !== 'boolean') return `${field.label} is on or off.`;
      item = raw ?? false;
    } else if (field.kind === 'number') {
      const number = Number(raw ?? field.initial);
      if (!Number.isInteger(number) || number < 1024 || number > 65535)
        return `${field.label} is from 1024 to 65535.`;
      item = number;
    } else {
      if (raw !== undefined && (typeof raw !== 'string' || raw.length > 64 * 1024))
        return `${field.label} is text.`;
      const text = (raw as string | undefined) ?? '';
      if (field.kind === 'text' && /[\r\n]/.test(text)) return `${field.label} is one line.`;
      if (
        field.kind === 'choice' &&
        text &&
        !field.choices?.some((choice) => choice.value === text)
      )
        return `Choose ${field.label.toLowerCase()}.`;
      // A secret left empty keeps what is saved.
      if (SECRET_KINDS.has(field.kind) && !text) continue;
      item = SECRET_KINDS.has(field.kind) ? text : text.trim();
    }
    const [group, name] = field.key.split('.');
    if (group === 'options') options[name] = item;
    else if (group === 'oauth') oauth[name] = item;
    else fields[group] = item;
  }
  if (isNew && type !== 'oauth2' && !fields.secret) {
    const label =
      form.find((field) => field.key === 'secret' && credentialFieldShows(values, field))?.label ??
      'secret';
    return `Give its ${label.toLowerCase()}.`;
  }
  if (
    (type === 'basic' || type === 'digest' || type === 'ntlm' || type === 'wsse') &&
    !fields.username
  )
    return 'Give its username.';
  if (type === 'oauth2' && (!oauth.tokenUrl || !oauth.clientId))
    return 'Give its token URL and client ID.';
  if (Object.keys(options).length) fields.options = options;
  if (Object.keys(oauth).length) fields.oauth = oauth;
  return { name: existing?.name ?? name, type, origin, fields, isNew };
}

/** How a credential stands, as the app's Status column says it. */
export function credentialStatus(row: CredentialRow): {
  label: string;
  tone: 'good' | 'warn' | 'muted';
} {
  if (row.external || row.certificate) return { label: 'In the app', tone: 'muted' };
  if (row.type === 'oauth2')
    return row.connected
      ? row.expiresAt && row.expiresAt <= Date.now()
        ? { label: 'Expired', tone: 'warn' }
        : { label: 'Connected', tone: 'good' }
      : { label: 'Not connected', tone: 'warn' };
  return row.hasSecret ? { label: 'Ready', tone: 'good' } : { label: 'No secret', tone: 'warn' };
}
