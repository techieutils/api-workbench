import type { HTTPSettings } from './http-settings';
export type ProxySettings = Pick<
  HTTPSettings,
  'proxyMode' | 'proxyUrl' | 'proxyUsername' | 'proxyPassword' | 'proxyBypass'
>;
interface BypassRule {
  host: string;
  port?: number;
}
function bypassRules(value: string): BypassRule[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((rule) => {
      if (rule === '*') return { host: '*' };
      if (/[\s/@?#]/.test(rule) || (rule.includes('*') && !rule.startsWith('*.')))
        throw new Error(
          'Proxy bypass accepts comma-separated hosts, optional ports, domain suffixes, and *.',
        );
      const parts = rule.startsWith('[')
        ? rule.match(/^\[([\da-f:]+)\](?::(\d+))?$/i)
        : rule.match(/^([^:]+)(?::(\d+))?$/);
      if (!parts) throw new Error('Invalid proxy bypass host. Put IPv6 addresses in brackets.');
      const host = parts[1].replace(/^\*\.|^\./, '');
      if (!host || host.includes('*')) throw new Error('Invalid proxy bypass host.');
      let parsed: URL;
      try {
        parsed = new URL(`http://${host.includes(':') ? `[${host}]` : host}`);
      } catch {
        throw new Error('Invalid proxy bypass host.');
      }
      const port = parts[2] === undefined ? undefined : Number(parts[2]);
      if (port !== undefined && (port < 1 || port > 65535))
        throw new Error('Proxy bypass port must be between 1 and 65535.');
      return {
        host: parsed.hostname
          .replace(/^\[|\]$/g, '')
          .replace(/\.$/, '')
          .toLowerCase(),
        port,
      };
    });
}
export function validateProxyURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter an HTTP or HTTPS proxy URL, for example http://localhost:8080.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP or HTTPS proxy URL without a path or embedded credentials. Enter proxy credentials separately.',
    );
  return url;
}
export function validateProxy(settings: ProxySettings): void {
  if (settings.proxyUrl) validateProxyURL(settings.proxyUrl);
  if (settings.proxyMode === 'custom' && !settings.proxyUrl)
    throw new Error('Enter a proxy URL or choose Direct connection.');
  if (settings.proxyUsername.includes(':'))
    throw new Error('Proxy usernames cannot contain a colon.');
  bypassRules(settings.proxyBypass);
}
export function proxyForURL(settings: ProxySettings, destination: string | URL): URL | undefined {
  if (settings.proxyMode === 'direct') return undefined;
  validateProxy(settings);
  const url = typeof destination === 'string' ? new URL(destination) : destination;
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const port = Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80));
  if (
    bypassRules(settings.proxyBypass).some(
      (rule) =>
        (rule.port === undefined || rule.port === port) &&
        (rule.host === '*' ||
          host === rule.host ||
          (!rule.host.includes(':') &&
            !/^[\d.]+$/.test(rule.host) &&
            host.endsWith('.' + rule.host))),
    )
  )
    return undefined;
  return validateProxyURL(settings.proxyUrl);
}
/** Exports keep proxy routes while excluding proxy credentials at every scope. */
export function redactProxySettings<T>(input: T): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const copy = { ...input } as T & { proxyUsername?: string; proxyPassword?: string };
  if (Object.hasOwn(copy, 'proxyUsername')) copy.proxyUsername = '';
  if (Object.hasOwn(copy, 'proxyPassword')) copy.proxyPassword = '';
  return copy;
}
