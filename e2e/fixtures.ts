import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

/** Starts the compiled app with its data in `data`, recording the errors it logs. */
export async function launchApp(data: string, errors: string[]): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: [path.join(root, 'dist/scripts/e2e-main.js')],
    cwd: root,
    env: { ...process.env, API_WORKBENCH_E2E_DATA: data, NODE_ENV: 'test' },
  });
  app.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return app;
}
/** The app's main window, once the shell has rendered, recording errors its page logs. */
export async function mainWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const window = await app.firstWindow();
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  window.on('pageerror', (error) => errors.push(error.message));
  await window.locator('.rail').waitFor();
  return window;
}
/**
 * Runs `trigger`, which starts a download in the app window, and saves that download to `file`:
 * the main process gives it the path, as a person choosing it in the save dialog would. Returns
 * what was written.
 */
export async function downloadTo(
  app: ElectronApplication,
  file: string,
  trigger: () => Promise<void>,
): Promise<string> {
  await app.evaluate(({ BrowserWindow }, savePath) => {
    const state = globalThis as { e2eDownload?: string };
    state.e2eDownload = '';
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(savePath);
      item.once('done', (_done, result) => (state.e2eDownload = result));
    });
  }, file);
  await trigger();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { e2eDownload?: string }).e2eDownload))
    .toBe('completed');
  return readFile(file, 'utf8');
}
/** A new, empty folder for the app's data. */
export const dataFolder = () => mkdtemp(path.join(os.tmpdir(), 'api-workbench-e2e-'));

/**
 * `app` is the running desktop app with its own empty data folder; `window` is its main window,
 * ready once the shell has rendered. Errors the page logs fail the test, as in the UI smoke runs.
 */
export const test = base.extend<{ app: ElectronApplication; window: Page; errors: string[] }>({
  // Playwright reads a fixture's dependencies from its first parameter, so it stays a pattern.
  // eslint-disable-next-line no-empty-pattern
  errors: async ({}, use) => {
    await use([]);
  },
  app: async ({ errors }, use) => {
    const data = await dataFolder();
    const app = await launchApp(data, errors);
    try {
      await use(app);
    } finally {
      await app.close().catch(() => undefined);
      await rm(data, { recursive: true, force: true });
    }
  },
  window: async ({ app, errors }, use) => {
    const window = await mainWindow(app, errors);
    await use(window);
    expect(errors, 'the app logged no errors').toEqual([]);
  },
});
export { expect };
