/** A cookie stored in a workspace jar, following RFC 6265 storage and matching rules. */
export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case host or domain, without a leading dot. */
  domain: string;
  /** True when the cookie had no Domain attribute and is sent only to the exact host. */
  hostOnly: boolean;
  path: string;
  /** Expiry in epoch milliseconds; undefined for session cookies. */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  created: number;
}
export interface SetCookieHeader {
  /** URL of the response that set the cookie. */
  url: string;
  header: string;
}
const isIP = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
const local = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || (!isIP(host) && host.endsWith(`.${domain}`));
}
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  return (
    requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/')
  );
}
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname.lastIndexOf('/') === 0) return '/';
  return pathname.slice(0, pathname.lastIndexOf('/'));
}
/** Parses one Set-Cookie header; returns undefined for malformed or rejected cookies. */
export function parseSetCookie(
  header: string,
  url: string,
  now = Date.now(),
): StoredCookie | undefined {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  const [pair, ...attributes] = header.split(';');
  const separator = pair.indexOf('=');
  if (separator < 1) return undefined;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name || [...name].some((char) => char <= ' ' || char === '\u007f')) return undefined;
  const cookie: StoredCookie = {
    name,
    value,
    domain: host,
    hostOnly: true,
    path: defaultPath(target.pathname),
    secure: false,
    httpOnly: false,
    created: now,
  };
  let maxAge: number | undefined;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const attributeValue = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'domain' && attributeValue) {
      const domain = attributeValue.replace(/^\./, '').toLowerCase();
      if (!domainMatches(host, domain)) return undefined;
      // Without a public suffix list, refuse single-label domains such as "com" or "local".
      if (!domain.includes('.') && domain !== host) return undefined;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === 'path')
      cookie.path = attributeValue.startsWith('/') ? attributeValue : defaultPath(target.pathname);
    else if (key === 'max-age' && /^-?\d+$/.test(attributeValue)) maxAge = Number(attributeValue);
    else if (key === 'expires' && cookie.expires === undefined) {
      const time = Date.parse(attributeValue);
      if (!Number.isNaN(time)) cookie.expires = time;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const mode = attributeValue.toLowerCase();
      cookie.sameSite = mode === 'strict' ? 'Strict' : mode === 'none' ? 'None' : 'Lax';
    }
  }
  // Max-Age takes precedence over Expires.
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  if (cookie.secure && target.protocol !== 'https:' && !local(host)) return undefined;
  return cookie;
}
const sameIdentity = (a: StoredCookie, b: StoredCookie) =>
  a.name === b.name && a.domain === b.domain && a.path === b.path;
export const isExpired = (cookie: StoredCookie, now = Date.now()) =>
  cookie.expires !== undefined && cookie.expires <= now;
/** Returns a new jar with the headers applied; expired cookies delete their stored match. */
export function storeCookies(
  jar: StoredCookie[],
  headers: SetCookieHeader[],
  now = Date.now(),
): StoredCookie[] {
  let next = jar.filter((cookie) => !isExpired(cookie, now));
  for (const { url, header } of headers) {
    const cookie = parseSetCookie(header, url, now);
    if (!cookie) continue;
    const existing = next.find((item) => sameIdentity(item, cookie));
    next = next.filter((item) => !sameIdentity(item, cookie));
    if (!isExpired(cookie, now))
      next.push(existing ? { ...cookie, created: existing.created } : cookie);
  }
  return next;
}
/** Cookies to send to a URL, ordered by longest path, then earliest creation. */
export function cookiesFor(jar: StoredCookie[], url: string, now = Date.now()): StoredCookie[] {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return [];
  }
  if (!['http:', 'https:'].includes(target.protocol)) return [];
  const host = target.hostname.toLowerCase();
  return jar
    .filter(
      (cookie) =>
        !isExpired(cookie, now) &&
        (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
        pathMatches(target.pathname || '/', cookie.path) &&
        (!cookie.secure || target.protocol === 'https:' || local(host)),
    )
    .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
}
export function cookieHeader(jar: StoredCookie[], url: string, now = Date.now()): string {
  return cookiesFor(jar, url, now)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
/** Merges jar cookies into an explicit Cookie header; explicit names win. */
export function mergeCookieHeader(explicit: string | undefined, fromJar: string): string {
  if (!explicit?.trim()) return fromJar;
  if (!fromJar) return explicit;
  const names = new Set(explicit.split(';').map((part) => part.split('=')[0].trim()));
  const extra = fromJar.split('; ').filter((part) => !names.has(part.split('=')[0]));
  return [explicit.trim(), ...extra].join('; ');
}
/** Validates a jar received over IPC or from a saved workspace, dropping malformed entries. */
export function sanitizeJar(value: unknown, limit = 3000): StoredCookie[] {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max;
  return value
    .filter(
      (cookie): cookie is StoredCookie =>
        !!cookie &&
        typeof cookie === 'object' &&
        text(cookie.name, 256) &&
        cookie.name.length > 0 &&
        text(cookie.value, 8192) &&
        text(cookie.domain, 253) &&
        cookie.domain.length > 0 &&
        text(cookie.path, 2048) &&
        cookie.path.startsWith('/') &&
        (cookie.expires === undefined || Number.isFinite(cookie.expires)) &&
        Number.isFinite(cookie.created),
    )
    .slice(0, limit)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.toLowerCase(),
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(['Strict', 'Lax', 'None'].includes(cookie.sameSite as string)
        ? { sameSite: cookie.sameSite }
        : {}),
      created: cookie.created,
    }));
}
