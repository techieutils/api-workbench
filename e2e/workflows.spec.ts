import { rm } from 'node:fs/promises';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

test('a variable set on the Environments screen resolves in the request', async ({ window }) => {
  await window.locator('.rail [data-view="Environments"]').click();
  // The new workspace's environment has base_url as its first variable.
  const value = window.locator('.environment-editor').getByLabel('Row 1 value');
  await value.fill(api.url);
  await value.press('Tab');
  await window.locator('.rail [data-view="Collections"]').click();
  await window.locator('#url').fill('{{base_url}}/users?page=2');
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText('200 OK');
  expect(api.received.at(-1)?.url).toBe('/users?page=2');
});

test('History lists what was sent, newest first', async ({ window }) => {
  for (const path of ['/users/first', '/missing/second']) {
    await window.locator('#url').fill(`${api.url}${path}`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText(
      path === '/users/first' ? '200' : '404',
    );
  }
  await window.locator('.rail [data-view="History"]').click();
  const entries = window.locator('[data-history-entry]');
  await expect(entries.first()).toContainText('/missing/second');
  await expect(entries.nth(1)).toContainText('/users/first');
});

test('the workspace is kept when the app is closed and opened again', async () => {
  const data = await dataFolder();
  const errors: string[] = [];
  try {
    const first = await launchApp(data, errors);
    const window = await mainWindow(first, errors);
    await window.locator('#url').fill(`${api.url}/kept-after-restart`);
    await window.keyboard.press('ControlOrMeta+S');
    await expect(window.locator('#save-status')).toHaveText(/Saved/);
    await first.close();

    const second = await launchApp(data, errors);
    const reopened = await mainWindow(second, errors);
    await expect(reopened.locator('#url')).toHaveValue(`${api.url}/kept-after-restart`);
    await second.close();
    expect(errors).toEqual([]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
