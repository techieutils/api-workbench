/* eslint-disable preserve-caught-error -- Provider errors intentionally omit causes so secret payloads cannot reach IPC errors. */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-providers';
import { GoogleAuth } from 'google-auth-library';
import { definition, visibleFields } from '@techieutils/api-workbench-common/secret-providers';
import type { CredentialRecord } from '@techieutils/api-workbench-common/types';
import type { ExternalSecretConfig } from '@techieutils/api-workbench-common/secret-providers';

export function providerEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid secret service URL.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error(
      'Secret services require HTTPS, or HTTP on localhost for development, without URL credentials, query, or fragment.',
    );
  return url;
}
function path(value: string): string {
  if (
    !value ||
    value
      .split('/')
      .some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          [...segment].some((character) => character.charCodeAt(0) < 32 || character === '\\'),
      )
  )
    throw new Error('Enter a valid secret path without empty or traversal segments.');
  return value.split('/').map(encodeURIComponent).join('/');
}
export function normalizeExternal(
  external: ExternalSecretConfig,
  secrets: Record<string, string> = {},
): { external: ExternalSecretConfig; secrets: Record<string, string> } {
  const provider = definition(external.provider);
  const config: Record<string, string> = {};
  for (const field of provider.fields.filter((field) => !field.secret)) {
    const value = external.config?.[field.key] ?? field.default ?? '';
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      [...value].some((character) => character.charCodeAt(0) < 32)
    )
      throw new Error('Invalid provider configuration field.');
    config[field.key] = value.trim();
  }
  const normalized: ExternalSecretConfig = { provider: provider.id, config };
  const authSecrets: Record<string, string> = {};
  for (const field of visibleFields(normalized)) {
    const value = field.secret ? secrets[field.key] || '' : config[field.key];
    if (typeof value !== 'string' || value.length > 65536)
      throw new Error('Invalid provider authentication value.');
    if (field.required && !value.trim()) throw new Error(`Enter ${field.label}.`);
    if (field.options && !field.options.some(([key]) => key === value))
      throw new Error(`Choose a valid ${field.label}.`);
    if (field.secret && value) authSecrets[field.key] = value;
  }
  for (const key of ['vaultUrl', 'serviceUrl']) if (config[key]) providerEndpoint(config[key]);
  if (provider.id.startsWith('aws-') && !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(config.region))
    throw new Error('Enter a valid AWS region.');
  if (provider.id === 'azure-key-vault') {
    if (providerEndpoint(config.vaultUrl).pathname !== '/')
      throw new Error('Azure vault URL must contain an origin only.');
    for (const key of ['secretName', 'version', 'tenantId'])
      if (config[key] && !/^[a-zA-Z0-9-]+$/.test(config[key]))
        throw new Error('Invalid Azure secret, version, or tenant identifier.');
  }
  if (provider.id === 'hashicorp-vault') {
    path(config.mount);
    path(config.path);
    if (config.auth === 'approle') path(config.authMount);
    if (config.version && !/^[1-9]\d*$/.test(config.version))
      throw new Error('Vault version must be a positive integer.');
  }
  if (provider.id === 'gcp-secret-manager') {
    for (const key of ['projectId', 'secretName', 'version'])
      if (!/^[a-zA-Z0-9_-]+$/.test(config[key]))
        throw new Error('Invalid Google Cloud resource identifier.');
    if (config.auth === 'service-account') {
      let account;
      try {
        account = JSON.parse(authSecrets.serviceAccount);
      } catch {
        throw new Error('Enter valid service account JSON.');
      }
      if (
        !account ||
        account.type !== 'service_account' ||
        typeof account.client_email !== 'string' ||
        typeof account.private_key !== 'string'
      )
        throw new Error('A service account JSON key is required.');
      if (
        (account.token_uri && account.token_uri !== 'https://oauth2.googleapis.com/token') ||
        (account.universe_domain && account.universe_domain !== 'googleapis.com')
      )
        throw new Error('Only Google public-cloud service account keys are supported.');
    }
  }
  return { external: normalized, secrets: authSecrets };
}
function selectedSecret(value: unknown, pointer: string | undefined): string {
  if (pointer) {
    if (!pointer.startsWith('/'))
      throw new Error('Secret field must be a JSON Pointer, for example /api_key.');
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error('The remote secret is not valid JSON for field selection.');
      }
    }
    for (const segment of pointer.slice(1).split('/')) {
      if (/~(?![01])/.test(segment)) throw new Error('Invalid JSON Pointer escape.');
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key))
        throw new Error('The selected field does not exist in the remote secret.');
      value = (value as Record<string, unknown>)[key];
    }
  }
  if (typeof value !== 'string' || !value || value.length > 1048576)
    throw new Error('Select a non-empty string secret. Use a JSON Pointer for structured secrets.');
  return value;
}
async function responseText(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Secret service returned HTTP ${response.status}. Check authentication and read permissions.`,
    );
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Secret service returned an empty response.');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2097152) throw new Error('Secret service response exceeds 2 MiB.');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function utf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}
async function abortableLookup<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export async function resolveExternalSecret(
  record: CredentialRecord,
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<string> {
  if (!record.external) throw new Error('Choose an external secret provider.');
  const { external, secrets } = normalizeExternal(record.external, record.providerSecrets);
  const config = external.config;
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const request = async (url: string | URL, init: RequestInit = {}) =>
    responseText(await transport(url, { ...init, redirect: 'error', signal: combinedSignal }));
  const json = async (
    url: string | URL,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> => JSON.parse(await request(url, init));
  const endpoint = (base: string, suffix: string): URL =>
    new URL(providerEndpoint(base).toString().replace(/\/$/, '') + '/' + suffix);
  try {
    combinedSignal.throwIfAborted();
    return await abortableLookup(combinedSignal, async () => {
      let value: unknown;
      if (external.provider === 'aws-secrets-manager' || external.provider === 'aws-ssm') {
        const credentials =
          config.auth === 'keys'
            ? {
                accessKeyId: secrets.accessKeyId,
                secretAccessKey: secrets.secretAccessKey,
                sessionToken: secrets.sessionToken || undefined,
              }
            : config.auth === 'profile'
              ? fromIni({ profile: config.profile })
              : undefined;
        const options = {
          region: config.region,
          credentials,
          maxAttempts: 2,
          requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
        };
        if (external.provider === 'aws-secrets-manager') {
          const client = new SecretsManagerClient(options);
          try {
            const result = await client.send(
              new GetSecretValueCommand({
                SecretId: config.secretId,
                VersionStage: config.version || undefined,
              }),
              { abortSignal: combinedSignal },
            );
            value =
              result.SecretString ?? (result.SecretBinary ? utf8(result.SecretBinary) : undefined);
          } finally {
            client.destroy();
          }
        } else {
          const client = new SSMClient(options);
          try {
            const result = await client.send(
              new GetParameterCommand({ Name: config.secretId, WithDecryption: true }),
              { abortSignal: combinedSignal },
            );
            value = result.Parameter?.Value;
          } finally {
            client.destroy();
          }
        }
      } else if (external.provider === 'azure-key-vault') {
        let token = secrets.accessToken;
        if (config.auth === 'client-secret') {
          const result = await json(
            `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: config.clientId,
                client_secret: secrets.clientSecret,
                scope: 'https://vault.azure.net/.default',
              }),
            },
          );
          token = selectedSecret(result.access_token, undefined);
        }
        const url = endpoint(
          config.vaultUrl,
          `secrets/${encodeURIComponent(config.secretName)}${config.version ? '/' + encodeURIComponent(config.version) : ''}`,
        );
        url.searchParams.set('api-version', '2025-07-01');
        value = (await json(url, { headers: { Authorization: `Bearer ${token}` } })).value;
      } else if (external.provider === 'hashicorp-vault') {
        const headers: Record<string, string> = config.namespace
          ? { 'X-Vault-Namespace': config.namespace }
          : {};
        let token = secrets.token;
        if (config.auth === 'approle') {
          const result = await json(
            endpoint(config.vaultUrl, `v1/auth/${path(config.authMount)}/login`),
            {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ role_id: secrets.roleId, secret_id: secrets.secretId }),
            },
          );
          token = selectedSecret(
            (result.auth as Record<string, unknown> | undefined)?.client_token,
            undefined,
          );
        }
        const url = endpoint(
          config.vaultUrl,
          `v1/${path(config.mount)}/${config.kvVersion === '2' ? 'data/' : ''}${path(config.path)}`,
        );
        if (config.kvVersion === '2' && config.version)
          url.searchParams.set('version', config.version);
        const result = await json(url, { headers: { ...headers, 'X-Vault-Token': token } });
        value =
          config.kvVersion === '2'
            ? (result.data as Record<string, unknown> | undefined)?.data
            : result.data;
      } else if (external.provider === 'sap-btp') {
        const url = endpoint(config.serviceUrl, config.credentialType);
        url.searchParams.set('name', config.credentialName);
        const payload = await request(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${secrets.bindingUsername}:${secrets.bindingPassword}`).toString('base64')}`,
            'sapcp-credstore-namespace': config.namespace,
            Accept: 'application/jose',
          },
        });
        const { compactDecrypt, importPKCS8 } = await import('jose');
        const pem = secrets.privateKey.includes('-----BEGIN')
          ? secrets.privateKey
          : `-----BEGIN PRIVATE KEY-----\n${secrets.privateKey.replace(/\s/g, '')}\n-----END PRIVATE KEY-----`;
        const key = await importPKCS8(pem, 'RSA-OAEP-256');
        const decrypted = await compactDecrypt(payload.trim(), key, {
          keyManagementAlgorithms: ['RSA-OAEP-256'],
          contentEncryptionAlgorithms: ['A256GCM'],
        });
        value = (JSON.parse(utf8(decrypted.plaintext)) as Record<string, unknown>).value;
      } else {
        let token = secrets.accessToken;
        if (config.auth !== 'token') {
          const credentials =
            config.auth === 'service-account' ? JSON.parse(secrets.serviceAccount) : undefined;
          const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            clientOptions: {
              transporterOptions: { timeout: 15000, retry: false, signal: combinedSignal },
            },
          });
          const client = await auth.getClient();
          combinedSignal.throwIfAborted();
          const result = await client.getAccessToken();
          token = selectedSecret(result.token, undefined);
        }
        combinedSignal.throwIfAborted();
        const result = await json(
          `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/secrets/${encodeURIComponent(config.secretName)}/versions/${encodeURIComponent(config.version)}:access`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = (result.payload as Record<string, unknown> | undefined)?.data;
        if (typeof data !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data))
          throw new Error('Secret service returned invalid base64 payload.');
        value = utf8(Buffer.from(data, 'base64'));
      }
      combinedSignal.throwIfAborted();
      return selectedSecret(value, record.secretField);
    });
  } catch (error) {
    if (combinedSignal.aborted)
      throw new Error(signal?.aborted ? 'Secret lookup cancelled.' : 'Secret lookup timed out.');
    // Never propagate SDK, network, JSON, or cryptography messages: they can contain tokens or payloads.
    const message = error instanceof Error ? error.message : '';
    const safe =
      /^(Secret service returned HTTP \d{3}\. Check authentication and read permissions\.|Secret service response exceeds 2 MiB\.|The remote secret is not valid JSON for field selection\.|The selected field does not exist in the remote secret\.|Select a non-empty string secret\. Use a JSON Pointer for structured secrets\.|Secret field must be a JSON Pointer, for example \/api_key\.|Invalid JSON Pointer escape\.)$/.test(
        message,
      )
        ? message
        : 'Could not read the secret. Check provider configuration, authentication, permissions, and connectivity.';
    throw new Error(`${definition(external.provider).label}: ${safe}`);
  }
}
export async function resolveCredential(
  record: CredentialRecord,
  signal?: AbortSignal,
): Promise<CredentialRecord> {
  if (!record.external) return record;
  const secret = await resolveExternalSecret(record, signal);
  return record.kind === 'oauth2'
    ? { ...record, oauth: { ...record.oauth!, clientSecret: secret } }
    : { ...record, secret };
}
