import type { WebContents } from 'electron';

/**
 * Electron's web content defaults, tightened. Electron grants every permission a page asks for
 * unless the app says otherwise, and only windows the app sets up refuse navigation and pop-ups;
 * these apply to every web content the app ever creates.
 */

/** The only permissions the interface uses: reading and writing the clipboard. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
]);

/** Whether to grant `permission`: only the clipboard, and only to the app's own window. */
export function permissionAllowed(permission: string, fromAppWindow: boolean): boolean {
  return fromAppWindow && ALLOWED_PERMISSIONS.has(permission);
}

/** The parts of Electron's Session these handlers use, so tests can stand in for it. */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
}
/** Refuses every permission request and check except the clipboard, for the app's window. */
export function restrictPermissions(
  session: PermissionSession,
  isAppWindow: (contents: unknown) => boolean,
): void {
  session.setPermissionRequestHandler((contents, permission, callback) =>
    callback(permissionAllowed(permission, isAppWindow(contents))),
  );
  session.setPermissionCheckHandler((contents, permission) =>
    permissionAllowed(permission, isAppWindow(contents)),
  );
}

/**
 * No pop-up windows, no navigation away from the app, and no `<webview>`: links open in the
 * system browser only through the app's own, confirmed path.
 */
export function guardWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Whether an IPC call comes from the app window's top frame — the only place the preload, and so
 * the bridge, runs. Calls from another window, or from a frame inside the page, are not.
 */
export function fromAppWindow(
  event: { sender: unknown; senderFrame: unknown },
  appWindow: { mainFrame: unknown } | undefined,
): boolean {
  return (
    Boolean(appWindow) && event.sender === appWindow && event.senderFrame === appWindow!.mainFrame
  );
}
