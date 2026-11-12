import { rm } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

/** Opens Settings at `section`. */
async function openSettings(window: Page, section: string) {
  await window.locator('.rail [data-view="Settings"]').click();
  await window.locator(`[data-settings-section="${section}"]`).click();
  await expect(window.locator(`[data-settings-section="${section}"]`)).toHaveAttribute(
    'aria-current',
    'page',
  );
}
async function saveSettings(window: Page) {
  await window.getByRole('button', { name: 'Save changes' }).click();
  await expect(window.getByText('Preferences saved').last()).toBeVisible();
}
async function choose(window: Page, combobox: string, option: string) {
  await window.getByRole('combobox', { name: combobox }).click();
  await window.getByRole('option', { name: option }).click();
}
const openCollections = (window: Page) => window.locator('.rail [data-view="Collections"]').click();
/** Sends the open request to `path` on the test API and waits for the response line. */
async function send(window: Page, path: string, shows: string | RegExp) {
  await window.locator('#url').fill(`${api.url}${path}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('#response-panel')).toContainText(shows);
}

test.describe('Settings', () => {
  test('every section opens with its heading', async ({ window }) => {
    const headings: [string, RegExp][] = [
      ['General', /Workspace preferences/],
      ['Saving', /Saving/],
      ['Requests', /Workspace HTTP defaults/],
      ['Appearance', /Appearance & editor/],
      ['Privacy', /Privacy & local storage/],
      ['Data', /Import & export/],
      ['Shortcuts', /Keyboard shortcuts/],
      ['Help', /Help/],
    ];
    for (const [section, heading] of headings) {
      await openSettings(window, section);
      await expect(window.locator('#settings-form h2').first()).toHaveText(heading);
    }
    await openSettings(window, 'Certificates');
    await openSettings(window, 'Updates');
    // Sections with nothing to save have no Save button.
    await expect(window.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  });

  test('a change not saved is dropped when another section opens', async ({ window }) => {
    await openSettings(window, 'Appearance');
    const html = window.locator('html');
    await expect(html).toHaveAttribute('data-density', 'comfortable');
    await choose(window, 'density', 'Compact');
    await openSettings(window, 'General');
    await openSettings(window, 'Appearance');
    await expect(window.getByRole('combobox', { name: 'density' })).toContainText('Comfortable');
    await expect(html).toHaveAttribute('data-density', 'comfortable');

    await choose(window, 'density', 'Compact');
    await window.getByLabel('editorFontSize').fill('16');
    await saveSettings(window);
    await expect(html).toHaveAttribute('data-density', 'compact');
    await expect(html).toHaveAttribute('data-font-size', '16');
  });

  test('the default response format is the Accept of new requests', async ({ window }) => {
    await openSettings(window, 'General');
    await choose(window, 'defaultAccept', 'XML');
    await saveSettings(window);
    await openCollections(window);
    await window.keyboard.press('ControlOrMeta+N');
    await send(window, '/echo', '/echo');
    expect(api.received.at(-1)?.headers.accept).toBe('application/xml');
  });

  test('Follow redirects off shows the redirect itself', async ({ window }) => {
    await send(window, '/redirect', 'Ada');
    expect(api.received.at(-1)?.url).toBe('/users');

    await openSettings(window, 'Requests');
    await window.locator('[data-http-field=followRedirects]').uncheck();
    await saveSettings(window);
    await openCollections(window);
    const before = api.received.length;
    await window.locator('#url').fill(`${api.url}/redirect`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('302');
    expect(api.received.slice(before).map((request) => request.url)).toEqual(['/redirect']);
  });

  test('a request taking longer than the timeout fails', async ({ window }) => {
    await openSettings(window, 'Requests');
    const timeout = window.locator('[data-http-field=timeoutMs]');
    // Out of range: the form says so and keeps the saved value.
    await timeout.fill('5');
    await window.getByRole('button', { name: 'Save changes' }).click();
    await expect(timeout).toHaveJSProperty('validity.rangeUnderflow', true);
    await timeout.fill('300');
    await saveSettings(window);
    await openCollections(window);
    await send(window, '/slow', /time/i);
    await expect(window.locator('.response-meta')).not.toContainText('200');
  });

  test('with history off, sends are not recorded', async ({ window }) => {
    await openSettings(window, 'Privacy');
    await window.getByLabel('Record request history').uncheck();
    await saveSettings(window);
    await openCollections(window);
    await send(window, '/users/not-recorded', 'Ada');
    await window.locator('.rail [data-view="History"]').click();
    await expect(window.getByText('History recording is disabled')).toBeVisible();
    await expect(window.locator('[data-history-entry]')).toHaveCount(0);
  });

  test('History retention keeps only the newest entries', async ({ window }) => {
    for (const path of ['/users/1', '/users/2', '/users/3']) await send(window, path, 'Ada');
    await openSettings(window, 'Privacy');
    await window.getByLabel('historyLimit').fill('2');
    await saveSettings(window);
    await window.locator('.rail [data-view="History"]').click();
    const entries = window.locator('[data-history-entry]');
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText('/users/3');
    await expect(entries.nth(1)).toContainText('/users/2');
  });

  test('with auto save off, changes wait for Save', async ({ window }) => {
    await openSettings(window, 'Saving');
    await choose(window, 'Auto save', 'Off · save with ⌘ S');
    await expect(window.getByText('Changes are written only when you press')).toBeVisible();
    await saveSettings(window);
    await openCollections(window);
    await window.locator('#url').fill(`${api.url}/unsaved`);
    await expect(window.locator('#save-status')).toHaveText(/Unsaved/);
    await window.keyboard.press('ControlOrMeta+S');
    await expect(window.locator('#save-status')).toHaveText(/Saved/);
  });

  test('saved settings and kept responses survive a restart', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await openSettings(window, 'Privacy');
      await window.getByLabel('Persist response bodies').check();
      await saveSettings(window);
      await openSettings(window, 'Appearance');
      await choose(window, 'theme', 'Pearl');
      await saveSettings(window);
      await openCollections(window);
      await send(window, '/users/kept', 'Ada');
      await window.keyboard.press('ControlOrMeta+S');
      await expect(window.locator('#save-status')).toHaveText(/Saved/);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'light');
      await openSettings(reopened, 'Privacy');
      await expect(reopened.getByLabel('Persist response bodies')).toBeChecked();
      // With Persist response bodies on, History still has the body after the restart.
      await reopened.locator('.rail [data-view="History"]').click();
      await reopened.locator('[data-history-entry]').first().click();
      await expect(reopened.locator('#history-response-editor')).toContainText('Ada');
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
