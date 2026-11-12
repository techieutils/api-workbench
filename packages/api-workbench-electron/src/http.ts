import { createHash } from 'node:crypto';
import { crc32, xxhash3, xxhash64, xxhash128 } from 'hash-wasm';
import { proxyForURL } from '@techieutils/api-workbench-common/proxy';
import {
  payloadSettings,
  type HTTPSettings,
  type IntegrityAlgorithm,
  type IntegrityHeader,
} from '@techieutils/api-workbench-common/http-settings';
import { acquireHTTPTransport } from './http-transport';
// Web types from undici itself, matching its fetch: Node's globals bundle an older undici.
import { FormData, Headers, Response, type BodyInit, type Dispatcher } from 'undici';
import { NetworkTimingRecorder } from './network-timing';
import {
  cookieHeader,
  mergeCookieHeader,
  sanitizeJar,
  storeCookies,
} from '@techieutils/api-workbench-common/cookies';
import {
  checkedSigningAuth,
  cachedJWT,
  digestAuthorization,
  edgeGridHeader,
  hawkHeader,
  oauth1Header,
  parseDigestChallenge,
  signAWS,
  wsseHeaders,
} from '@techieutils/api-workbench-common/auth-signing';
import {
  ntlmAuthenticate,
  ntlmNegotiate,
  parseNTLMChallenge,
} from '@techieutils/api-workbench-common/ntlm';
import type { SetCookieHeader } from '@techieutils/api-workbench-common/cookies';
import { checkedCertificatePayload } from '@techieutils/api-workbench-common/client-certificates';
import { vaultLocked } from '@techieutils/api-workbench-common/vault-messages';
import { loadClientCertificate, type LoadedClientCertificate } from './client-certificates';
import type { RequestPayload, RequestResponse } from '@techieutils/api-workbench-common/types';
import {
  isTextType,
  PREVIEW_BYTE_LIMIT,
  sniff,
} from '@techieutils/api-workbench-common/response-body';
export async function sendHttpRequest(
  request: RequestPayload,
  controller: AbortController,
  dispatcher?: Dispatcher,
  /** A certificate the caller already loaded, such as one from the credential vault. */
  resolvedCertificate?: LoadedClientCertificate,
): Promise<RequestResponse> {
  const start = performance.now();
  let timing = new NetworkTimingRecorder(dispatcher);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  try {
    const config = payloadSettings(request);
    timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let url = new URL(request.url);
    if (config.httpVersion === '2' && url.protocol !== 'https:')
      throw new Error('HTTP/2 only requires an HTTPS URL.');
    const certificatePayload = checkedCertificatePayload(request.clientCertificate);
    if (certificatePayload && 'credentialId' in certificatePayload && !resolvedCertificate)
      throw new Error(vaultLocked("present this request's client certificate"));
    const clientCertificate =
      resolvedCertificate ??
      (certificatePayload && !('credentialId' in certificatePayload)
        ? await loadClientCertificate(certificatePayload)
        : undefined);
    // CONNECT goes to the proxy when one applies, or else to the server itself, over HTTP/1.1:
    // the request is the proxy's to answer, so it is sent straight to it.
    const tunnelProxy = request.method === 'CONNECT' ? proxyForURL(config, url) : undefined;
    if (!dispatcher) {
      const transport =
        request.method === 'CONNECT'
          ? acquireHTTPTransport(
              { ...config, proxyMode: 'direct', httpVersion: '1.1' },
              tunnelProxy ?? url,
              tunnelProxy ? undefined : clientCertificate,
            )
          : acquireHTTPTransport(config, url, clientCertificate);
      dispatcher = transport.agent;
      release = transport.release;
    }
    timing = new NetworkTimingRecorder(dispatcher);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    let method = request.method;
    const headers = new Headers(request.headers);
    if (headers.has('proxy-authorization'))
      throw new Error(
        'Set proxy credentials in Proxy settings instead of a Proxy-Authorization request header.',
      );
    let body: BodyInit | undefined = request.body || undefined;
    if (request.multipart) {
      const form = new FormData();
      for (const field of request.multipart) {
        if (field.file)
          form.append(
            field.name,
            new Blob([Buffer.from(field.file.base64, 'base64')], {
              type: field.file.type || 'application/octet-stream',
            }),
            field.file.name,
          );
        else form.append(field.name, field.value);
      }
      headers.delete('content-type');
      headers.delete('content-length');
      body = form;
    } else if (request.binary) {
      body = Buffer.from(request.binary.base64, 'base64');
      if (!headers.has('content-type'))
        headers.set('content-type', request.binary.type || 'application/octet-stream');
      headers.delete('content-length');
    }
    // TRACE must not carry a body, and CONNECT's would be sent through the tunnel.
    if (['GET', 'HEAD', 'TRACE', 'CONNECT'].includes(method)) body = undefined;
    // The integrity hash covers the exact bytes sent, so it is added before any signing.
    let integrityName: string | undefined;
    if (config.integrityHeader !== 'none' && body !== undefined) {
      if (body instanceof FormData) {
        // Encode the form once, so the bytes hashed are the bytes sent, boundary included.
        const encoded = new Response(body);
        headers.set('content-type', encoded.headers.get('content-type')!);
        body = Buffer.from(await encoded.arrayBuffer());
      }
      const bytes = typeof body === 'string' ? Buffer.from(body) : (body as Buffer);
      const [name, value] =
        config.integrityHeader === 'custom-header'
          ? await customIntegrityHeader(config, bytes)
          : integrityHeader(config.integrityHeader, bytes);
      // A header the request sets itself wins.
      if (!headers.has(name)) {
        headers.set(name, value);
        integrityName = name;
      }
    }
    const signing = checkedSigningAuth(request.signing);
    if (signing?.type === 'jwt')
      headers.set('authorization', `${signing.prefix} ${cachedJWT(signing)}`.trim());
    let digestAttempted = false;
    // NTLM authenticates the connection: negotiate, then answer the challenge on the same socket,
    // which the keep-alive pool reuses for the retry.
    let ntlmAttempted = false;
    if (signing?.type === 'ntlm') headers.set('authorization', ntlmNegotiate());
    let response: Response | undefined;
    // Jar cookies are recomputed per hop so same-origin redirects see cookies set along the way.
    const useJar = Array.isArray(request.cookieJar);
    let jar = useJar ? sanitizeJar(request.cookieJar) : [];
    const explicitCookie = headers.get('cookie') ?? undefined;
    const setCookies: SetCookieHeader[] = [];
    for (let redirects = 0; redirects <= config.maxRedirects; redirects++) {
      if (useJar) {
        const cookie = mergeCookieHeader(explicitCookie, cookieHeader(jar, url.toString()));
        if (cookie) headers.set('cookie', cookie);
        else headers.delete('cookie');
      }
      // Signatures cover the final method, URL, and body, so each hop is signed again.
      if (signing?.type === 'aws')
        signAWS(signing, {
          method,
          url,
          headers,
          body: typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined,
          unsignedPayload: body instanceof FormData,
        });
      else if (signing?.type === 'oauth1')
        headers.set(
          'authorization',
          oauth1Header(signing, {
            method,
            url,
            formParams:
              typeof body === 'string' &&
              /application\/x-www-form-urlencoded/i.test(headers.get('content-type') || '')
                ? [...new URLSearchParams(body)]
                : undefined,
          }),
        );
      else if (signing?.type === 'wsse')
        for (const [name, value] of Object.entries(wsseHeaders(signing))) headers.set(name, value);
      else if (signing?.type === 'edgegrid')
        headers.set(
          'authorization',
          edgeGridHeader(signing, {
            method,
            url,
            headers,
            body: typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined,
          }),
        );
      else if (signing?.type === 'hawk')
        headers.set(
          'authorization',
          hawkHeader(signing, {
            method,
            url,
            contentType: headers.get('content-type') ?? undefined,
            body: typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined,
          }),
        );
      if (method === 'CONNECT') {
        const tunnel = new Headers(headers);
        tunnel.set('host', connectAuthority(url));
        if (tunnelProxy && (config.proxyUsername || config.proxyPassword))
          tunnel.set(
            'proxy-authorization',
            `Basic ${Buffer.from(`${config.proxyUsername}:${config.proxyPassword}`).toString('base64')}`,
          );
        response = await timing.connect(
          tunnelProxy ?? url,
          connectAuthority(url),
          tunnel,
          controller.signal,
          config.maxResponseSizeMB * 1048576,
        );
      } else
        response = await timing.fetch(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
      const headerBytes = [...response.headers].reduce(
        (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
        0,
      );
      if (headerBytes > config.maxHeaderSizeKB * 1024) {
        await response.body?.cancel();
        throw new Error('Response headers exceed the configured size limit.');
      }
      const hopCookies = response.headers
        .getSetCookie()
        .map((header) => ({ url: url.toString(), header }));
      setCookies.push(...hopCookies);
      if (useJar && hopCookies.length) jar = storeCookies(jar, hopCookies);
      if (signing?.type === 'digest' && response.status === 401 && !digestAttempted) {
        const challenge = parseDigestChallenge(response.headers.get('www-authenticate'));
        if (challenge) {
          digestAttempted = true;
          await response.body?.cancel();
          timing.completeHop();
          headers.set(
            'authorization',
            digestAuthorization(signing, challenge, method, url.pathname + url.search),
          );
          // The challenge round trip does not count toward the redirect limit.
          redirects--;
          continue;
        }
      }
      if (signing?.type === 'ntlm' && response.status === 401 && !ntlmAttempted) {
        const challenge = parseNTLMChallenge(response.headers.get('www-authenticate'));
        if (challenge) {
          ntlmAttempted = true;
          // Read the challenge body to the end: cancelling it would close the authenticated socket.
          await response.arrayBuffer();
          // Let the pool take the socket back first, or the retry would open a new connection.
          await new Promise((resolve) => setImmediate(resolve));
          timing.completeHop();
          headers.set('authorization', ntlmAuthenticate(signing, challenge));
          redirects--;
          continue;
        }
      }
      if (
        method === 'CONNECT' ||
        !config.followRedirects ||
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !response.headers.has('location')
      )
        break;
      const next = new URL(response.headers.get('location')!, url);
      await response.body?.cancel();
      timing.completeHop();
      if (next.origin !== url.origin)
        throw new Error(
          'Cross-origin redirect blocked. Create a request to the destination explicitly.',
        );
      if (redirects === config.maxRedirects) throw new Error('Too many redirects.');
      if (
        (response.status === 303 && method !== 'HEAD') ||
        ([301, 302].includes(response.status) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('content-length');
        if (integrityName) headers.delete(integrityName);
      }
      url = next;
    }
    if (!response) throw new Error('No response received.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > config.maxResponseSizeMB * 1048576)
            throw new Error('Response body exceeds the configured size limit.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks);
    const bodyText = bytes.toString('utf8');
    const contentType = response.headers.get('content-type') || undefined;
    // Binary bodies keep their bytes: decoding an image or PDF as UTF-8 would corrupt it.
    const keepBytes =
      bytes.length > 0 &&
      bytes.length <= PREVIEW_BYTE_LIMIT &&
      (contentType ? !isTextType(contentType) : Boolean(sniff(bytes.subarray(0, 16))));
    timing.completeHop();
    const tls = timing.tlsSnapshot();
    if (tls && clientCertificate)
      tls.clientCertificate = {
        subject: clientCertificate.subject || 'Client certificate',
        issuer: clientCertificate.issuer,
        validTo: clientCertificate.validTo,
      };
    return {
      timings: timing.snapshot(),
      tls,
      httpVersion: timing.httpVersionSnapshot(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      ...(setCookies.length ? { setCookies } : {}),
      body: bodyText,
      ...(keepBytes ? { bodyBase64: bytes.toString('base64') } : {}),
      time: Math.round(performance.now() - start),
      size: bytes.length,
      url: response.url,
    };
  } catch (error) {
    timing.completeHop();
    return {
      timings: timing.snapshot(),
      tls: timing.tlsSnapshot(),
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'Request cancelled or timed out.'
          : error instanceof Error
            ? transportErrorMessage(error)
            : String(error),
    };
  } finally {
    clearTimeout(timer);
    release?.();
  }
}

/** Where a CONNECT asks for a tunnel to: the URL's host and port, such as `api.example.com:443`. */
export function connectAuthority(url: URL): string {
  return url.port ? url.host : `${url.host}:${url.protocol === 'https:' ? 443 : 80}`;
}

/** The header that carries a hash of the body, in the chosen scheme. */
export function integrityHeader(kind: IntegrityHeader, bytes: Buffer): [string, string] {
  const hash = (algorithm: string) => createHash(algorithm).update(bytes).digest('base64');
  switch (kind) {
    case 'content-digest-sha512':
      return ['content-digest', `sha-512=:${hash('sha512')}:`];
    case 'digest-sha256':
      return ['digest', `SHA-256=${hash('sha256')}`];
    case 'content-md5':
      return ['content-md5', hash('md5')];
    case 'amz-checksum-sha256':
      return ['x-amz-checksum-sha256', hash('sha256')];
    case 'amz-checksum-sha1':
      return ['x-amz-checksum-sha1', hash('sha1')];
    default:
      return ['content-digest', `sha-256=:${hash('sha256')}:`];
  }
}

/** CRC-32C's (Castagnoli) reversed polynomial; CRC-32 is the default one. */
const CRC32C_POLYNOMIAL = 0x82f63b78;
/** The digest of `bytes`, big-endian as each algorithm's reference output is written. */
export async function integrityDigest(
  algorithm: IntegrityAlgorithm,
  bytes: Buffer,
): Promise<Buffer> {
  const hex = async (digest: Promise<string>) => Buffer.from(await digest, 'hex');
  switch (algorithm) {
    case 'crc32':
      return hex(crc32(bytes));
    case 'crc32c':
      return hex(crc32(bytes, CRC32C_POLYNOMIAL));
    case 'xxhash64':
      return hex(xxhash64(bytes));
    case 'xxhash3':
      return hex(xxhash3(bytes));
    case 'xxhash128':
      return hex(xxhash128(bytes));
    default:
      return createHash(algorithm).update(bytes).digest();
  }
}
/** The custom integrity header: the chosen name, carrying the chosen hash in the chosen encoding. */
export async function customIntegrityHeader(
  settings: Pick<HTTPSettings, 'integrityHeaderName' | 'integrityAlgorithm' | 'integrityEncoding'>,
  bytes: Buffer,
): Promise<[string, string]> {
  const digest = await integrityDigest(settings.integrityAlgorithm, bytes);
  return [
    settings.integrityHeaderName.trim().toLowerCase(),
    digest.toString(settings.integrityEncoding),
  ];
}

export function transportErrorMessage(error: Error): string {
  const causes: { code?: string; message?: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    causes.push(current as { code?: string; message?: string });
    current = (current as { cause?: unknown }).cause;
  }
  if (
    causes.some((cause) =>
      /Proxy response \(407\)|Proxy Authentication Required.*407/i.test(cause.message || ''),
    )
  )
    return 'Proxy authentication failed (407). Check the proxy username and password.';
  const proxyFailure = causes
    .map((cause) => cause.message?.match(/Proxy response \((\d{3})\)/)?.[1])
    .find(Boolean);
  if (proxyFailure) return `Proxy tunnel failed (HTTP ${proxyFailure}).`;
  const code = causes.map((cause) => cause.code).find((code) => code && code !== 'UND_ERR_ABORTED');
  const messages: Record<string, string> = {
    AW_HTTP2_REQUIRED: 'The server did not negotiate required HTTP/2.',
    ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL: 'The server did not negotiate required HTTP/2.',
    ERR_SSL_NO_APPLICATION_PROTOCOL: 'The server did not negotiate required HTTP/2.',
    ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION:
      'The server does not support the configured TLS protocol range.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The server certificate is self-signed and is not trusted.',
    SELF_SIGNED_CERT_IN_CHAIN:
      'The server certificate chain contains an untrusted self-signed certificate.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server certificate chain could not be verified.',
    CERT_HAS_EXPIRED: 'The server certificate has expired.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The server certificate does not match the requested hostname.',
    UND_ERR_CONNECT_TIMEOUT: 'Connection timed out.',
    UND_ERR_HEADERS_TIMEOUT: 'Response headers timed out.',
    UND_ERR_BODY_TIMEOUT: 'Response body timed out.',
    UND_ERR_HEADERS_OVERFLOW: 'Response headers exceed the configured size limit.',
  };
  return code && messages[code] ? messages[code] : error.message;
}
