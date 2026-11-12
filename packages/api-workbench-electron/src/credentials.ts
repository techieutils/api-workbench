import { WORKBENCH_VAULT_LOCKED } from './workbench-vault';
import { WORKBENCH_VAULT_NOT_SET_UP } from '@techieutils/api-workbench-common/vault-messages';
import type { VaultStatus } from '@techieutils/api-workbench-common/types';
import { normalizeExternal } from './secret-providers';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  CredentialInput,
  CredentialRecord,
  CredentialSummary,
  RequestPayload,
} from '@techieutils/api-workbench-common/types';
import {
  HAWK_ALGORITHMS,
  JWT_ALGORITHMS,
  type SigningAuth,
} from '@techieutils/api-workbench-common/auth-signing';
/** Vault kinds that are signed per request instead of adding a fixed header. */
export const SIGNING_CREDENTIAL_KINDS = [
  'digest',
  'jwt',
  'aws',
  'oauth1',
  'ntlm',
  'wsse',
  'edgegrid',
  'hawk',
] as const;
import { resourceIndicator, secureEndpoint } from './oauth';
import { VAULT_DENIED, vaultUnavailable } from '@techieutils/api-workbench-common/vault-messages';
import {
  normalizeHostPattern,
  validHostPattern,
  type CertificateProfile,
} from '@techieutils/api-workbench-common/client-certificates';
/** The origin a client certificate is shown as allowed for: its host pattern and port. */
export function certificateOrigin(profile: Pick<CertificateProfile, 'host' | 'port'>): string {
  return `https://${profile.host}${profile.port ? `:${profile.port}` : ''}`;
}
/** OS encryption for secrets at rest: Electron's asynchronous safeStorage API. */
export interface SecretStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  /** `shouldReEncrypt` is set when the OS key has rotated: the data should be encrypted again. */
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
  /**
   * Which store encrypts secrets: the OS's, or the API Workbench vault (used when the OS has
   * none), and for the latter whether it is set up and unlocked.
   */
  vaultState?(): Promise<Omit<VaultStatus, 'available' | 'backend'>>;
}
export function credentialSummary(record: CredentialRecord): CredentialSummary {
  const { clientSecret: _secret, ...oauth } = record.oauth || {};
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    allowedOrigin: record.allowedOrigin,
    username: record.username,
    headerName: record.headerName,
    updatedAt: record.updatedAt,
    oauth: record.oauth ? (oauth as CredentialSummary['oauth']) : undefined,
    external: record.external,
    secretField: record.secretField,
    providerSecretFields: Object.keys(record.providerSecrets || {}),
    options: record.options,
    hasExtraSecret: Boolean(record.extraSecret),
    hasSecret: Boolean(record.external || record.secret || record.oauth?.clientSecret),
    connected: Boolean(record.tokens?.accessToken),
    expiresAt: record.tokens?.expiresAt,
    canRefresh: Boolean(record.tokens?.refreshToken),
    clientCertificate: certificateProfile(record),
  };
}
/** A client certificate's public profile, without its certificate or key material. */
function certificateProfile(record: CredentialRecord): CertificateProfile | undefined {
  if (record.kind !== 'client-certificate' || !record.clientCertificate) return undefined;
  const { type, host, port, subject, issuer, validTo } = record.clientCertificate;
  return { type, host, ...(port ? { port } : {}), subject, issuer, validTo };
}
export function validateCredential(input: CredentialInput): void {
  if (!input.name?.trim() || input.name.length > 100)
    throw new Error('Enter a credential name of up to 100 characters.');
  if (
    ![
      'bearer',
      'basic',
      'api-key',
      'digest',
      'jwt',
      'aws',
      'oauth1',
      'ntlm',
      'wsse',
      'edgegrid',
      'hawk',
      'oauth2',
      'client-certificate',
    ].includes(input.kind)
  )
    throw new Error('Unsupported credential type.');
  if (input.kind === 'client-certificate') {
    const profile = input.clientCertificate;
    if (!profile || !['pem', 'pfx'].includes(profile.type))
      throw new Error('Choose a PEM certificate and key, or a PFX/P12 bundle.');
    if (!validHostPattern(normalizeHostPattern(profile.host || '')))
      throw new Error('Enter a host such as api.example.com or *.example.com.');
    if (
      profile.port !== undefined &&
      (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535)
    )
      throw new Error('Port must be between 1 and 65535.');
    if (!input.secret || (profile.type === 'pem' && !(profile as { certPem?: string }).certPem))
      throw new Error(
        profile.type === 'pfx'
          ? 'Choose a PFX/P12 bundle.'
          : 'Choose a certificate and its private key.',
      );
    if (
      input.extraSecret !== undefined &&
      (typeof input.extraSecret !== 'string' || input.extraSecret.length > 8192)
    )
      throw new Error('Invalid certificate passphrase.');
    if (input.external) throw new Error('Client certificates are stored in the local vault.');
    return;
  }
  const options = input.options || {};
  if (
    input.options !== undefined &&
    (typeof input.options !== 'object' || Array.isArray(input.options))
  )
    throw new Error('Invalid credential options.');
  for (const [key, value] of Object.entries(options))
    if (!['string', 'boolean'].includes(typeof value) || String(value).length > 65536)
      throw new Error(`Invalid credential option ${key}.`);
  if (
    input.extraSecret !== undefined &&
    (typeof input.extraSecret !== 'string' || input.extraSecret.length > 65536)
  )
    throw new Error('Invalid credential secret.');
  if (
    ['digest', 'oauth1', 'aws', 'ntlm', 'wsse', 'edgegrid', 'hawk'].includes(input.kind) &&
    !input.username?.trim()
  )
    throw new Error(
      input.kind === 'aws'
        ? 'Enter an AWS access key ID.'
        : input.kind === 'oauth1'
          ? 'Enter an OAuth 1.0 consumer key.'
          : input.kind === 'edgegrid'
            ? 'Enter an EdgeGrid client token.'
            : input.kind === 'hawk'
              ? 'Enter a Hawk ID.'
              : 'Enter a username.',
    );
  if (input.kind === 'edgegrid' && !input.id && !input.extraSecret)
    throw new Error('Enter an EdgeGrid access token.');
  if (
    input.kind === 'edgegrid' &&
    options.edgegridMaxBody &&
    !/^\d+$/.test(options.edgegridMaxBody)
  )
    throw new Error('EdgeGrid max body size must be a whole number of bytes.');
  if (
    input.kind === 'hawk' &&
    options.hawkAlgorithm &&
    !HAWK_ALGORITHMS.includes(options.hawkAlgorithm)
  )
    throw new Error('Choose a Hawk algorithm.');
  if (input.kind === 'aws' && (!options.awsRegion?.trim() || !options.awsService?.trim()))
    throw new Error('Enter an AWS region and service name.');
  if (
    input.kind === 'oauth1' &&
    options.oauth1SignatureMethod &&
    !['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT'].includes(options.oauth1SignatureMethod)
  )
    throw new Error('Choose an OAuth 1.0 signature method.');
  if (input.kind === 'jwt') {
    if (options.jwtAlgorithm && !JWT_ALGORITHMS.includes(options.jwtAlgorithm))
      throw new Error('Choose a supported JWT algorithm.');
    for (const [field, label] of [
      ['jwtPayload', 'JWT payload'],
      ['jwtHeader', 'JWT header'],
    ] as const) {
      const source = options[field]?.trim();
      if (!source) continue;
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch {
        throw new Error(`${label} must be valid JSON.`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} must be a JSON object.`);
    }
    if (options.jwtExpiresIn && !/^\d+$/.test(options.jwtExpiresIn))
      throw new Error('JWT expiry must be a whole number of seconds.');
  }
  if (
    input.kind === 'api-key' &&
    options.apiKeyIn &&
    !['header', 'query'].includes(options.apiKeyIn)
  )
    throw new Error('Choose where to send the API key.');
  const origin = new URL(input.allowedOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Enter an API origin only, for example https://api.example.com.');
  if (input.kind === 'basic' && !input.username) throw new Error('Enter a username.');
  if (input.external) {
    normalizeExternal(input.external, input.providerSecrets);
    if (
      input.secretField &&
      (!input.secretField.startsWith('/') ||
        input.secretField.length > 1024 ||
        /~(?![01])/.test(input.secretField))
    )
      throw new Error('Enter a valid JSON Pointer, for example /api_key.');
  }
  if (input.kind !== 'oauth2' && !input.external && !input.secret)
    throw new Error('Enter a credential secret.');
  if (
    input.kind === 'api-key' &&
    options.apiKeyIn === 'query' &&
    (!input.headerName?.trim() || input.headerName.length > 256)
  )
    throw new Error('Enter a query parameter name for the API key.');
  else if (
    input.kind === 'api-key' &&
    (!input.headerName ||
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(input.headerName) ||
      ['host', 'content-length', 'connection'].includes(input.headerName.toLowerCase()))
  )
    throw new Error('Enter a valid API key header name.');
  if (input.kind === 'oauth2') {
    const config = input.oauth;
    if (!config?.clientId?.trim()) throw new Error('Enter an OAuth client ID.');
    if (!['authorization_code', 'client_credentials'].includes(config.grantType))
      throw new Error('Unsupported OAuth grant.');
    if (!['none', 'basic', 'body'].includes(config.clientAuth))
      throw new Error('Unsupported client authentication.');
    secureEndpoint(config.tokenUrl);
    if (config.resource) resourceIndicator(config.resource);
    if (config.grantType === 'authorization_code') secureEndpoint(config.authorizationUrl);
    if (
      config.grantType === 'client_credentials' &&
      ((!config.clientSecret && !input.external) || config.clientAuth === 'none')
    )
      throw new Error(
        'Client credentials requires a client secret and Basic or body client authentication.',
      );
    if (config.clientAuth === 'basic' && !config.clientSecret && !input.external)
      throw new Error('Basic client authentication requires a client secret.');
    if (input.external && config.clientAuth === 'none')
      throw new Error('External OAuth client secrets require Basic or body client authentication.');
    if (
      !Number.isInteger(config.callbackPort) ||
      config.callbackPort < 1024 ||
      config.callbackPort > 65535
    )
      throw new Error('Callback port must be between 1024 and 65535.');
  }
}
export function credentialHeaders(
  record: CredentialRecord,
  request: RequestPayload,
): Record<string, string> {
  if (record.kind === 'client-certificate')
    throw new Error(
      'Client certificates are presented automatically for their host; choose another credential for authorization.',
    );
  if (new URL(request.url).origin !== new URL(record.allowedOrigin).origin)
    throw new Error(`Credential is restricted to ${record.allowedOrigin}.`);
  const header = (name: string, value: string): Record<string, string> => {
    try {
      new Headers({ [name]: value });
      return { [name]: value };
    } catch {
      throw new Error(
        'The saved credential cannot be used as an HTTP header. Check its value and header name.',
      );
    }
  };
  if (record.kind === 'basic')
    return header(
      'Authorization',
      `Basic ${Buffer.from(`${record.username}:${record.secret}`).toString('base64')}`,
    );
  if (record.kind === 'api-key')
    return record.options?.apiKeyIn === 'query' ? {} : header(record.headerName!, record.secret!);
  if ((SIGNING_CREDENTIAL_KINDS as readonly string[]).includes(record.kind)) return {};
  if (record.kind === 'bearer') return header('Authorization', `Bearer ${record.secret}`);
  if (!record.tokens?.accessToken)
    throw new Error('Connect this OAuth profile before sending a request.');
  if (record.tokens.expiresAt && record.tokens.expiresAt <= Date.now())
    throw new Error('OAuth token expired. Refresh or reconnect in Credentials.');
  return header('Authorization', `Bearer ${record.tokens.accessToken}`);
}
/**
 * A request with a saved credential applied, as the app and the command line send it: only to the
 * origin the credential is for, with its headers, its query parameter, or its signing.
 */
export function withCredential(request: RequestPayload, record: CredentialRecord): RequestPayload {
  if (new URL(request.url).origin !== new URL(record.allowedOrigin).origin)
    throw new Error(`Credential is restricted to ${record.allowedOrigin}.`);
  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(credentialHeaders(record, request)))
    headers.set(key, value);
  let applied: RequestPayload = { ...request, headers: Object.fromEntries(headers) };
  const query = credentialQuery(record);
  if (query) {
    const url = new URL(applied.url);
    url.searchParams.set(query[0], query[1]);
    applied = { ...applied, url: url.toString() };
  }
  const signing = credentialSigning(record);
  return signing ? { ...applied, signing } : applied;
}
/** The query parameter a vault API key adds, when it is sent in the query string. */
export function credentialQuery(record: CredentialRecord): [string, string] | undefined {
  return record.kind === 'api-key' && record.options?.apiKeyIn === 'query'
    ? [record.headerName!, record.secret || '']
    : undefined;
}
/** Converts a signing vault credential into the configuration the HTTP transport signs with. */
export function credentialSigning(record: CredentialRecord): SigningAuth | undefined {
  const options = record.options || {};
  if (record.kind === 'digest')
    return { type: 'digest', username: record.username || '', password: record.secret || '' };
  if (record.kind === 'aws')
    return {
      type: 'aws',
      accessKeyId: record.username || '',
      secretAccessKey: record.secret || '',
      sessionToken: record.extraSecret || undefined,
      region: options.awsRegion?.trim() || '',
      service: options.awsService?.trim() || '',
    };
  if (record.kind === 'oauth1')
    return {
      type: 'oauth1',
      consumerKey: record.username || '',
      consumerSecret: record.secret || '',
      token: options.oauth1Token || undefined,
      tokenSecret: record.extraSecret || undefined,
      signatureMethod: options.oauth1SignatureMethod || 'HMAC-SHA1',
      realm: options.oauth1Realm || undefined,
    };
  if (record.kind === 'ntlm')
    return {
      type: 'ntlm',
      username: record.username || '',
      password: record.secret || '',
      domain: options.ntlmDomain?.trim() || undefined,
      workstation: options.ntlmWorkstation?.trim() || undefined,
    };
  if (record.kind === 'wsse')
    return { type: 'wsse', username: record.username || '', password: record.secret || '' };
  if (record.kind === 'edgegrid')
    return {
      type: 'edgegrid',
      clientToken: record.username?.trim() || '',
      clientSecret: record.secret?.trim() || '',
      accessToken: record.extraSecret?.trim() || '',
      headersToSign: (options.edgegridHeadersToSign || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
      maxBody: options.edgegridMaxBody ? Number(options.edgegridMaxBody) : undefined,
    };
  if (record.kind === 'hawk')
    return {
      type: 'hawk',
      id: record.username || '',
      key: record.secret || '',
      algorithm: options.hawkAlgorithm || 'sha256',
      ext: options.hawkExt || undefined,
      app: options.hawkApp || undefined,
      dlg: options.hawkDlg || undefined,
      includePayloadHash: options.hawkPayloadHash === true,
    };
  if (record.kind === 'jwt') {
    const object = (source?: string) =>
      source?.trim() ? (JSON.parse(source) as Record<string, unknown>) : {};
    return {
      type: 'jwt',
      algorithm: options.jwtAlgorithm || 'HS256',
      secret: record.secret || '',
      secretBase64: options.jwtSecretBase64 === true,
      payload: object(options.jwtPayload),
      header: object(options.jwtHeader),
      prefix: options.jwtPrefix ?? 'Bearer',
      expiresInSeconds: Number(options.jwtExpiresIn || 0),
    };
  }
  return undefined;
}
export class CredentialVault {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly storage: SecretStorage,
  ) {}
  async status(): Promise<VaultStatus> {
    const backend =
      this.storage.getSelectedStorageBackend?.() ||
      (process.platform === 'darwin' ? 'Keychain' : 'OS encryption');
    const state = (await this.storage.vaultState?.()) ?? {
      kind: 'os' as const,
      setUp: true,
      locked: false,
    };
    return {
      available: (await this.storage.isAsyncEncryptionAvailable()) && backend !== 'basic_text',
      backend,
      ...state,
    };
  }
  private async ensureAvailable(): Promise<void> {
    const { available, backend, kind, setUp } = await this.status();
    if (available) return;
    if (kind === 'workbench')
      throw new Error(setUp ? WORKBENCH_VAULT_LOCKED : WORKBENCH_VAULT_NOT_SET_UP);
    throw new Error(vaultUnavailable(backend));
  }
  /** The saved records, and whether they should be encrypted again with the OS's current key. */
  private async read(): Promise<{ records: CredentialRecord[]; stale: boolean }> {
    await this.ensureAvailable();
    try {
      const encrypted = await fs.readFile(this.file);
      const { result, shouldReEncrypt } = await this.storage.decryptStringAsync(encrypted);
      return { records: JSON.parse(result) as CredentialRecord[], stale: shouldReEncrypt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], stale: false };
      throw new Error(VAULT_DENIED, { cause: error });
    }
  }
  /** Reads the records for a lookup, saving them again when the OS key has rotated. */
  private async readCurrent(): Promise<CredentialRecord[]> {
    await this.queue;
    const { records, stale } = await this.read();
    if (stale) await this.mutate(() => undefined);
    return records;
  }
  private mutate<T>(operation: (records: CredentialRecord[]) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const { records } = await this.read();
      const result = operation(records);
      const encrypted = await this.storage.encryptStringAsync(JSON.stringify(records));
      await fs.writeFile(`${this.file}.tmp`, encrypted, {
        mode: 0o600,
      });
      await fs.rename(`${this.file}.tmp`, this.file);
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async list(): Promise<CredentialSummary[]> {
    return (await this.readCurrent()).map(credentialSummary);
  }
  async get(id: string): Promise<CredentialRecord> {
    const record = (await this.readCurrent()).find((item) => item.id === id);
    if (!record) throw new Error('Credential no longer exists. Choose another credential.');
    return record;
  }
  async save(input: CredentialInput): Promise<CredentialSummary> {
    return this.mutate((records) => {
      const index = input.id ? records.findIndex((item) => item.id === input.id) : -1;
      if (input.id && index < 0) throw new Error('Credential no longer exists.');
      const previous = records[index];
      const record: CredentialRecord = {
        ...input,
        id: previous?.id || randomUUID(),
        name: input.name.trim(),
        secret: input.secret || (previous?.kind === input.kind ? previous.secret : undefined),
        extraSecret:
          input.extraSecret || (previous?.kind === input.kind ? previous.extraSecret : undefined),
        oauth:
          input.kind === 'oauth2' && input.oauth
            ? {
                ...input.oauth,
                clientSecret:
                  input.oauth.clientSecret ||
                  (previous?.kind === 'oauth2' ? previous.oauth?.clientSecret : undefined),
              }
            : undefined,
        updatedAt: new Date().toISOString(),
      };
      if (input.external) {
        const retain =
          previous?.external?.provider === input.external.provider &&
          previous.external.config.auth === input.external.config.auth;
        const supplied = { ...(retain ? previous.providerSecrets : {}) };
        for (const [key, value] of Object.entries(input.providerSecrets || {}))
          if (value) supplied[key] = value;
        const normalized = normalizeExternal(input.external, supplied);
        record.external = normalized.external;
        record.providerSecrets = normalized.secrets;
        record.secret = undefined;
        if (record.oauth) record.oauth.clientSecret = undefined;
      } else {
        record.external = undefined;
        record.providerSecrets = undefined;
        record.secretField = undefined;
        if (previous?.external) {
          record.secret = input.secret;
          if (record.oauth) record.oauth.clientSecret = input.oauth?.clientSecret;
        }
      }
      if (record.kind === 'client-certificate') {
        record.clientCertificate = {
          ...record.clientCertificate!,
          host: normalizeHostPattern(record.clientCertificate!.host),
        };
        record.allowedOrigin = certificateOrigin(record.clientCertificate);
      }
      validateCredential(record);
      if (record.kind !== 'client-certificate')
        record.allowedOrigin = new URL(record.allowedOrigin).origin;
      // Changing a profile invalidates its issued tokens; reconnect explicitly.
      if (index >= 0) records[index] = record;
      else records.push(record);
      return credentialSummary(record);
    });
  }
  async setTokens(id: string, tokens: CredentialRecord['tokens']): Promise<CredentialSummary> {
    return this.mutate((records) => {
      const record = records.find((item) => item.id === id);
      if (!record) throw new Error('Credential no longer exists.');
      record.tokens = tokens;
      record.updatedAt = new Date().toISOString();
      return credentialSummary(record);
    });
  }
  async delete(id: string): Promise<void> {
    await this.mutate((records) => {
      const index = records.findIndex((item) => item.id === id);
      if (index >= 0) records.splice(index, 1);
    });
  }
}
