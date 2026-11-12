import { app, dialog, BrowserWindow, safeStorage } from 'electron';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness, keychain, pause, temporary, type SmokeContext } from './ui-smoke/harness';
import { selectParts, type SmokePart } from './smoke-parts';
import startupAndShell from './ui-smoke/01-startup-and-shell';
import responsePreviews from './ui-smoke/02-response-previews';
import panesAndDevTools from './ui-smoke/03-panes-and-dev-tools';
import rowsBodiesAndCode from './ui-smoke/04-rows-bodies-and-code';
import settingsAndAuthentication from './ui-smoke/05-settings-and-authentication';
import oauthAndVault from './ui-smoke/06-oauth-and-vault';
import overviewImportAndEditors from './ui-smoke/07-overview-import-and-editors';
import textMenusAndRunner from './ui-smoke/08-text-menus-and-runner';
import chainingCookiesAndAuth from './ui-smoke/09-chaining-cookies-and-auth';
import certificatesAndComparison from './ui-smoke/10-certificates-and-comparison';
import searchWorkspacesAndHistory from './ui-smoke/11-search-workspaces-and-history';
import collectionsAndFiles from './ui-smoke/12-collections-and-files';
import interceptorAndShortcuts from './ui-smoke/13-interceptor-and-shortcuts';
import specsAndMocks from './ui-smoke/14-specs-and-mocks';
import teamWorkspaces from './ui-smoke/15-team-workspaces';
import dataDrivenRuns from './ui-smoke/16-data-driven-runs';
import gitSyncAndLinks from './ui-smoke/17-git-sync-and-links';
import savingAndStorage from './ui-smoke/18-saving-and-storage';
import workbenchVault from './ui-smoke/19-workbench-vault';
import requestScripts from './ui-smoke/20-request-scripts';
import requestTags from './ui-smoke/21-request-tags';

// Run the real app against disposable data. No provider login or real credentials. The checks
// themselves are in ui-smoke/, one file per area, run in order against the same window.
app.setPath('userData', temporary);
// Avoid touching the real system keychain in automated UI checks.
safeStorage.isAsyncEncryptionAvailable = async () => {
  keychain.checks++;
  return false;
};
safeStorage.getSelectedStorageBackend = () => 'unknown';
// The main process asks before HTTPS decryption or trusting a certificate, in a
// native dialog (packages/api-workbench-electron/src/confirmations.ts); tests answer yes.
dialog.showMessageBox = (async () => ({
  response: 0,
  checkboxChecked: false,
})) as typeof dialog.showMessageBox;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Register the app's ready listener synchronously before the test's listener.
require('@techieutils/api-workbench-electron/bootstrap');
// A hung run fails rather than waiting forever. A full run takes about five minutes; the limit
// leaves room for slower machines and CI runners.
const watchdog = setTimeout(() => {
  console.error('UI test watchdog expired');
  app.exit(1);
}, 900000);
/** Every area of the app, in the order a full run checks them; see smoke-parts.ts for --only. */
const PARTS: SmokePart<SmokeContext>[] = [
  ['startup-and-shell', startupAndShell],
  ['response-previews', responsePreviews],
  ['panes-and-dev-tools', panesAndDevTools],
  ['rows-bodies-and-code', rowsBodiesAndCode],
  ['settings-and-authentication', settingsAndAuthentication],
  ['oauth-and-vault', oauthAndVault],
  ['overview-import-and-editors', overviewImportAndEditors],
  ['text-menus-and-runner', textMenusAndRunner],
  ['chaining-cookies-and-auth', chainingCookiesAndAuth],
  ['certificates-and-comparison', certificatesAndComparison],
  ['search-workspaces-and-history', searchWorkspacesAndHistory],
  ['collections-and-files', collectionsAndFiles],
  ['interceptor-and-shortcuts', interceptorAndShortcuts],
  ['specs-and-mocks', specsAndMocks],
  ['team-workspaces', teamWorkspaces],
  ['data-driven-runs', dataDrivenRuns],
  ['git-sync-and-links', gitSyncAndLinks],
  ['saving-and-storage', savingAndStorage],
  ['workbench-vault', workbenchVault],
  ['request-scripts', requestScripts],
  ['request-tags', requestTags],
];
const parts = selectParts(PARTS);
const errors: string[] = [];
let exitCode = 0;
app
  .whenReady()
  .then(async () => {
    for (let attempt = 0; !BrowserWindow.getAllWindows().length && attempt < 250; attempt++)
      await pause(20);
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.removeAllListeners('ready-to-show');
    window.hide();
    window.setSize(1440, 960);
    window.webContents.on('console-message', ({ level, message }) => {
      // The content policy check in part 1 is blocked on purpose; any other error fails the run.
      if (level === 'error' && !message.includes('csp-probe.invalid')) errors.push(message);
    });
    window.webContents.on('did-fail-load', (_event, code, description) =>
      console.error('Page load failed', code, description),
    );
    window.webContents.on('render-process-gone', (_event, details) =>
      console.error('Renderer exited', details),
    );
    const context = createHarness(window);
    try {
      await context.prepare();
      // Each part starts on the screen the app boots to, whatever screen the part before it ended
      // on (part 6 ends on Overview, say), so a part never depends on which ran first.
      const bootView = String(await context.run('view'));
      for (const part of parts.selected) {
        console.log(`Part ${part.number}: ${part.name}`);
        await context.run(`view=${JSON.stringify(bootView)};render()`);
        await part.run(context);
      }
      console.log('Renderer behavioral assertions complete.');
      assert.deepEqual(errors, [], 'no renderer console errors');
      if (!parts.all)
        console.log(
          `UI smoke checks passed for ${parts.selected.map((part) => `${part.number} ${part.name}`).join(', ')}.`,
        );
      else
        console.log(
          'UI smoke checks passed: boot, settings save, appearance, request defaults, credential dialog, OAuth fields, keyboard close, authentication, overview, collection rename, docked panels, live code, dev tools console, network, performance, and terminal, variable capture and chaining, dynamic variables, response filter, JWT inspector, cookie jar, command palette, authentication types, explorer, environments, history, overview banner, client certificates, vault and request auth parity, method colors, pane layout, response comparison, API specifications, and mock servers. Use --screenshots for optional image capture in artifacts/',
        );
    } catch (error) {
      console.error(error);
      exitCode = 1;
    } finally {
      clearTimeout(watchdog);
      window.destroy();
      await pause(100);
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      app.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
