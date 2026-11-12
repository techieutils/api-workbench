import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { ProxyAgent, Pool, type Dispatcher, type Agent } from 'undici';
import { proxyForURL } from '@techieutils/api-workbench-common/proxy';
import { createTimingAgent } from './network-timing';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import type { LoadedClientCertificate } from './client-certificates';
interface PoolEntry {
  agent: Dispatcher;
  active: number;
}
const pools = new Map<string, PoolEntry>();
export function acquireHTTPTransport(
  settings: HTTPSettings,
  destination?: string | URL,
  clientCertificate?: LoadedClientCertificate,
): { agent: Dispatcher; release(): void } {
  if (settings.proxyMode === 'custom' && !destination)
    throw new Error('A destination is required to select the proxy route.');
  const proxy = destination ? proxyForURL(settings, destination) : undefined;
  const key = JSON.stringify({
    settings,
    proxy: proxy?.href || null,
    client: clientCertificate?.fingerprint || null,
  });
  let entry = settings.keepAlive ? pools.get(key) : undefined;
  if (!entry) {
    const ca = settings.caCertificates.trim();
    if (ca) {
      const blocks = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (
        !blocks?.length ||
        ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
      )
        throw new Error('Enter a valid PEM CA certificate bundle.');
      try {
        blocks.forEach((block) => new X509Certificate(block));
      } catch {
        throw new Error('Enter a valid PEM CA certificate bundle.');
      }
    }
    const options = {
      rejectUnauthorized: settings.verifyTLS,
      minVersion: settings.tlsMinVersion,
      maxVersion: settings.tlsMaxVersion,
      ...(settings.tlsCiphers ? { ciphers: settings.tlsCiphers } : {}),
      ...(ca ? { ca } : {}),
      ...(clientCertificate
        ? {
            cert: clientCertificate.cert,
            key: clientCertificate.key,
            pfx: clientCertificate.pfx,
            passphrase: clientCertificate.passphrase,
          }
        : {}),
    };
    try {
      createSecureContext(options);
    } catch {
      throw new Error('Invalid TLS version, cipher suite, or CA configuration.');
    }
    const connectOptions = {
      ...options,
      timeout: settings.connectTimeoutMs,
      allowH2: settings.httpVersion !== '1.1',
      family: settings.addressFamily === 'ipv4' ? 4 : settings.addressFamily === 'ipv6' ? 6 : 0,
      autoSelectFamily: settings.addressFamily === 'auto' && settings.autoSelectFamily,
      autoSelectFamilyAttemptTimeout: settings.autoSelectFamilyAttemptTimeoutMs,
    };
    const agentOptions = {
      allowH2: settings.httpVersion !== '1.1',
      headersTimeout: settings.headersTimeoutMs,
      bodyTimeout: settings.bodyTimeoutMs,
      keepAliveTimeout: settings.keepAliveTimeoutMs,
      keepAliveMaxTimeout: settings.keepAliveTimeoutMs,
      maxHeaderSize: settings.maxHeaderSizeKB * 1024,
      maxOrigins: 32,
      connections: settings.maxConnections || null,
      pipelining: settings.keepAlive ? settings.pipelining : 1,
      maxRequestsPerClient: settings.maxRequestsPerConnection || undefined,
      maxConcurrentStreams: settings.maxConcurrentStreams,
    };
    const agent = proxy
      ? new ProxyAgent({
          ...agentOptions,
          uri: proxy.href,
          proxyTunnel: false,
          ...(settings.proxyUsername || settings.proxyPassword
            ? {
                token: `Basic ${Buffer.from(`${settings.proxyUsername}:${settings.proxyPassword}`).toString('base64')}`,
              }
            : {}),
          requestTls: connectOptions,
          proxyTls: { ...connectOptions, allowH2: false },
          clientFactory: (origin, clientOptions) =>
            new Pool(origin, { ...agentOptions, ...clientOptions, allowH2: false }),
          factory: (origin, rawOptions) => {
            const factoryOptions = rawOptions as Agent.Options;
            return createTimingAgent(
              connectOptions,
              { ...agentOptions, ...factoryOptions },
              settings.httpVersion === '2',
              typeof factoryOptions.connect === 'function' ? factoryOptions.connect : undefined,
              origin,
            );
          },
        })
      : createTimingAgent(connectOptions, agentOptions, settings.httpVersion === '2');
    entry = { active: 0, agent };
    if (settings.keepAlive) pools.set(key, entry);
  } else {
    pools.delete(key);
    pools.set(key, entry);
  }
  const current = entry;
  current.active++;
  let released = false;
  return {
    agent: current.agent,
    release() {
      if (released) return;
      released = true;
      current.active--;
      if (!settings.keepAlive) {
        void current.agent.destroy();
        return;
      }
      if (pools.size > 32)
        for (const [poolKey, pool] of pools) {
          if (!pool.active) {
            pools.delete(poolKey);
            void pool.agent.destroy();
            if (pools.size <= 32) break;
          }
        }
    },
  };
}
export async function closeHTTPTransports(): Promise<void> {
  const agents = [...pools.values()].map((pool) => pool.agent);
  pools.clear();
  await Promise.allSettled(agents.map((agent) => agent.destroy()));
}
