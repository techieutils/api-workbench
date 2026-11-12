/** The link schemes the app opens outside itself, in the system browser or mail app. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * True for an absolute web or mail link. The renderer uses it to decide what to show as a link,
 * and the main process checks it again before opening anything.
 */
export function isExternalLink(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
