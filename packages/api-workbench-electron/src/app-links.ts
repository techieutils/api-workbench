/**
 * The app's URL scheme. Installed builds register it, so `apiworkbench://` links open API
 * Workbench: macOS and Linux packages through `protocols` in each platform's section of package.json, and Windows from the
 * app itself, since electron-builder does not register schemes there. A link brings the window
 * forward; the app does not act on the rest of the link yet.
 */
export const URL_SCHEME = 'apiworkbench';

/**
 * The executable Windows should start for a link: the portable build's own .exe rather than the
 * temporary folder it runs from, otherwise the running executable.
 */
export function protocolExecutable(env: NodeJS.ProcessEnv, execPath: string): string {
  return env.PORTABLE_EXECUTABLE_FILE || execPath;
}

/**
 * The app's identity on Windows, matching `build.appId`. The installer gives the Start menu
 * shortcut this ID; the running app has to use the same one, or Windows shows it as a separate
 * taskbar button and pinning it pins a different app.
 */
export const APP_USER_MODEL_ID = 'com.techieutils.apiworkbench';
