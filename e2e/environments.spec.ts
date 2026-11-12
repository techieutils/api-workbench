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

const openEnvironments = (window: Page) =>
  window.locator('.rail [data-view="Environments"]').click();
const openCollections = (window: Page) => window.locator('.rail [data-view="Collections"]').click();
const editor = (window: Page) => window.locator('.environment-editor');
const environments = (window: Page) => window.locator('[data-env-select]');
/** Sets row `row` (1-based) of the selected environment to `key` = `value`. */
async function setVariable(window: Page, row: number, key: string, value: string) {
  await editor(window).getByLabel(`Row ${row} key`).fill(key);
  await editor(window).getByLabel(`Row ${row} value`).fill(value);
  await editor(window).getByLabel(`Row ${row} value`).press('Tab');
}
/** Sends `url` from the open request and returns the path the test API received. */
async function send(window: Page, url: string): Promise<string | undefined> {
  const before = api.received.length;
  await window.locator('#url').fill(url);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText(/\d{3}/);
  await expect.poll(() => api.received.length).toBeGreaterThan(before);
  return api.received.at(-1)?.url;
}
/** Chooses the active environment from the request heading. */
async function chooseEnvironment(window: Page, name: string) {
  await window.getByRole('combobox', { name: 'Active environment' }).click();
  await window.getByRole('option', { name }).click();
}

test.describe('environments', () => {
  test('a new workspace has Development, active, and Production', async ({ window }) => {
    await openEnvironments(window);
    await expect(environments(window)).toHaveCount(2);
    await expect(environments(window).first()).toContainText('Development');
    await expect(environments(window).first()).toContainText('Active');
    await expect(environments(window).first()).toContainText('1 variable');
    await expect(environments(window).nth(1)).toContainText('Production');
    await expect(window.locator('#environment-name')).toHaveValue('Development');
  });

  test('the active environment decides what a variable resolves to', async ({ window }) => {
    await openEnvironments(window);
    await setVariable(window, 1, 'base_url', `${api.url}/dev`);
    await environments(window).nth(1).click();
    await expect(environments(window).nth(1)).toHaveAttribute('aria-pressed', 'true');
    await setVariable(window, 1, 'base_url', `${api.url}/prod`);

    await openCollections(window);
    // Production was selected last on the Environments screen, so it is active here too.
    expect(await send(window, '{{base_url}}/users')).toBe('/prod/users');
    await chooseEnvironment(window, 'Development');
    expect(await send(window, '{{base_url}}/users')).toBe('/dev/users');
  });

  test('several variables combine, and a switched-off one is not used', async ({ window }) => {
    await openEnvironments(window);
    await setVariable(window, 1, 'base_url', api.url);
    await editor(window).getByRole('button', { name: 'Add variable' }).click();
    await setVariable(window, 2, 'resource', 'users');
    await editor(window).getByRole('button', { name: 'Add variable' }).click();
    await setVariable(window, 3, 'page', '2');
    await expect(environments(window).first()).toContainText('3 variables');

    await openCollections(window);
    expect(await send(window, '{{base_url}}/{{resource}}?page={{page}}')).toBe('/users?page=2');

    await openEnvironments(window);
    await editor(window).getByLabel('Enable row 3').uncheck();
    await openCollections(window);
    // Switched off, `page` is kept but no longer supplies a value.
    const sent = await send(window, '{{base_url}}/{{resource}}?page={{page}}');
    expect(sent).toMatch(/^\/users\?page=/);
    expect(sent).not.toBe('/users?page=2');
  });

  test('values of secret-looking names are masked until revealed', async ({ window }) => {
    await openEnvironments(window);
    await setVariable(window, 1, 'base_url', api.url);
    await editor(window).getByRole('button', { name: 'Add variable' }).click();
    await setVariable(window, 2, 'api_token', 'made-up-token-123');
    const value = editor(window).getByLabel('Row 2 value');
    await expect(value).toHaveAttribute('type', 'password');
    await expect(editor(window)).toContainText('1 masked');
    await editor(window).locator('[data-reveal-variable=api_token]').click();
    await expect(value).toHaveAttribute('type', 'text');
    await editor(window).locator('[data-reveal-variable=api_token]').click();
    await expect(value).toHaveAttribute('type', 'password');

    // Masking is for the screen only: the request still gets the value.
    await openCollections(window);
    expect(await send(window, '{{base_url}}/echo?token={{api_token}}')).toBe(
      '/echo?token=made-up-token-123',
    );
  });

  test('a new environment is named, filled, and made active', async ({ window }) => {
    await openEnvironments(window);
    await window.getByRole('button', { name: 'New environment' }).click();
    await expect(environments(window)).toHaveCount(3);
    await expect(environments(window).nth(2)).toContainText('Environment 3');
    await expect(environments(window).nth(2)).toContainText('Active');
    await expect(environments(window).nth(2)).toContainText('0 variables');

    await window.locator('#environment-name').fill('Staging');
    await expect(environments(window).nth(2)).toContainText('Staging');
    await editor(window).getByRole('button', { name: 'Add variable' }).click();
    await setVariable(window, 1, 'base_url', `${api.url}/staging`);
    await expect(environments(window).nth(2)).toContainText('1 variable');

    await openCollections(window);
    await expect(window.getByRole('combobox', { name: 'Active environment' })).toContainText(
      'Staging',
    );
    expect(await send(window, '{{base_url}}/users')).toBe('/staging/users');
  });

  test('Duplicate copies the variables into a new, active environment', async ({ window }) => {
    await openEnvironments(window);
    await setVariable(window, 1, 'base_url', `${api.url}/original`);
    await window.locator('[data-env-duplicate]').click();
    await expect(window.getByText('Duplicated Development')).toBeVisible();
    await expect(environments(window)).toHaveCount(3);
    await expect(window.locator('#environment-name')).toHaveValue('Development copy');
    await expect(editor(window).getByLabel('Row 1 value')).toHaveValue(`${api.url}/original`);

    // The copy is independent of the original.
    await setVariable(window, 1, 'base_url', `${api.url}/copy`);
    await environments(window).first().click();
    await expect(editor(window).getByLabel('Row 1 value')).toHaveValue(`${api.url}/original`);
  });

  test('the row menu makes active, renames, and deletes after asking', async ({ window }) => {
    await openEnvironments(window);
    const menu = window.locator('[data-environment-menu]');
    const dialog = window.locator('[data-confirm-dialog]');

    await environments(window).nth(1).click({ button: 'right' });
    await menu.locator('[data-menu-item=activate]').click();
    await expect(environments(window).nth(1)).toContainText('Active');

    await environments(window).nth(1).click({ button: 'right' });
    await expect(menu.locator('[data-menu-item=activate]')).toBeDisabled();
    await menu.locator('[data-menu-item=rename]').click();
    await expect(window.locator('#environment-name')).toBeFocused();
    await window.keyboard.type('Live');
    await expect(environments(window).nth(1)).toContainText('Live');

    await environments(window).nth(1).click({ button: 'right' });
    await menu.locator('[data-menu-item=delete]').click();
    await expect(dialog).toContainText('Delete the Live environment?');
    await dialog.locator('[data-confirm-cancel]').click();
    await expect(environments(window)).toHaveCount(2);

    await window.locator('[data-action=delete-env]').click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(environments(window)).toHaveCount(1);
    await expect(environments(window).first()).toContainText('Development');
    // The last environment cannot be deleted.
    await expect(window.locator('[data-action=delete-env]')).toBeDisabled();
  });

  test('environments are kept when the app is closed and opened again', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await openEnvironments(window);
      await window.getByRole('button', { name: 'New environment' }).click();
      await window.locator('#environment-name').fill('QA');
      await editor(window).getByRole('button', { name: 'Add variable' }).click();
      await setVariable(window, 1, 'base_url', `${api.url}/qa`);
      await window.keyboard.press('ControlOrMeta+S');
      await expect(window.locator('#save-status')).toHaveText(/Saved/);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await openEnvironments(reopened);
      await expect(environments(reopened)).toHaveCount(3);
      await expect(environments(reopened).nth(2)).toContainText('QA');
      await expect(environments(reopened).nth(2)).toContainText('Active');
      await openCollections(reopened);
      expect(await send(reopened, '{{base_url}}/users')).toBe('/qa/users');
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
