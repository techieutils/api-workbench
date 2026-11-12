import { vaultLocked } from '@techieutils/api-workbench-common/vault-messages';
import type { CredentialRecord, ProtocolPayload } from '@techieutils/api-workbench-common/types';
import { mqttOriginURL } from '@techieutils/api-workbench-common/protocol-config';
import { credentialHeaders, credentialQuery, credentialSigning } from './credentials';

/**
 * Vault origins use HTTP(S): WS maps to HTTP, WSS to HTTPS, gRPC follows TLS, and MQTT brokers map
 * to HTTP(S) on the broker's port.
 */
export function protocolCredentialURL(input: ProtocolPayload): string {
  if (input.protocol === 'mqtt') {
    const target = new URL(input.url);
    if (target.username || target.password)
      throw new Error('Enter a valid protocol URL without embedded credentials.');
    return mqttOriginURL(input.url).toString();
  }
  if (input.protocol === 'grpc') {
    const target = new URL(`http://${input.url}`);
    if (target.host !== input.url || !target.port || target.username || target.password)
      throw new Error('Use a gRPC host:port destination.');
    return `${input.grpc?.tls ? 'https:' : 'http:'}//${target.host}/`;
  }
  const target = new URL(input.url);
  const schemes =
    input.protocol === 'websocket'
      ? ['ws:', 'wss:']
      : input.protocol === 'sse' || input.protocol === 'ndjson'
        ? ['http:', 'https:']
        : input.protocol === 'socketio'
          ? ['http:', 'https:', 'ws:', 'wss:']
          : [];
  if (!schemes.includes(target.protocol) || target.username || target.password)
    throw new Error('Enter a valid protocol URL without embedded credentials.');
  if (target.protocol === 'ws:') target.protocol = 'http:';
  if (target.protocol === 'wss:') target.protocol = 'https:';
  return target.toString();
}
interface ProtocolCredentialAccess {
  unlocked: boolean;
  get(id: string): Promise<CredentialRecord>;
  resolve(record: CredentialRecord, signal: AbortSignal): Promise<CredentialRecord>;
}
export async function authorizeProtocol(
  input: ProtocolPayload,
  access: ProtocolCredentialAccess,
  signal: AbortSignal,
): Promise<ProtocolPayload> {
  if (!input.credentialId) return input;
  if (!access.unlocked) throw new Error(vaultLocked('connect with its saved credential'));
  const url = protocolCredentialURL(input);
  signal.throwIfAborted();
  const saved = await access.get(input.credentialId);
  signal.throwIfAborted();
  if (new URL(url).origin !== new URL(saved.allowedOrigin).origin)
    throw new Error(`Credential is restricted to ${saved.allowedOrigin}.`);
  const record = saved.kind === 'oauth2' ? saved : await access.resolve(saved, signal);
  signal.throwIfAborted();
  const headers = new Headers(input.headers);
  for (const [key, value] of Object.entries(
    credentialHeaders(record, {
      id: input.sessionId,
      url,
      method: 'GET',
      headers: input.headers,
      body: '',
    }),
  ))
    headers.set(key, value);
  let destination = input.url;
  const query = credentialQuery(record);
  if (query) {
    if (input.protocol === 'grpc')
      throw new Error(
        'gRPC has no query string. Change the saved API key to use a header (metadata).',
      );
    if (input.protocol === 'mqtt')
      throw new Error('MQTT brokers take a username and password. Use a Basic auth credential.');
    const target = new URL(input.url);
    target.searchParams.set(query[0], query[1]);
    destination = target.toString();
  }
  const signing = credentialSigning(record);
  return {
    ...input,
    url: destination,
    headers: Object.fromEntries(headers),
    ...(signing ? { signing } : {}),
  };
}
