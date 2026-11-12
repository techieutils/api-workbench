/**
 * The desktop window sends every request from the main process, so its page needs no network
 * access of its own. index.html allows connections for the browser build, which sends requests
 * with fetch; in the desktop app a second policy forbids them. Browsers enforce every policy a
 * page has, so this can only narrow index.html's, and nothing later can loosen it. Imported
 * first, so it applies before anything else in the page runs.
 */
export const DESKTOP_POLICY = "connect-src 'none'";

export function narrowDesktopPolicy(): void {
  if (!window.workbench) return;
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = DESKTOP_POLICY;
  policy.dataset.desktopPolicy = '';
  document.head.prepend(policy);
}
narrowDesktopPolicy();
