import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { dataFolder, downloadTo, expect, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
let folder: string;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});
test.beforeEach(async () => {
  folder = await dataFolder();
});
test.afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A Postman v2.1 collection with a folder, a body, and a collection variable. */
const postman = (baseUrl: string) => ({
  info: {
    name: 'Orders API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{ key: 'orders_url', value: baseUrl }],
  item: [
    { name: 'List orders', request: { method: 'GET', url: '{{orders_url}}/orders?page=1' } },
    {
      name: 'Admin',
      item: [
        {
          name: 'Create order',
          request: {
            method: 'POST',
            url: '{{orders_url}}/orders',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"item":"book"}' },
          },
        },
      ],
    },
  ],
});

const dialog = (window: Page) => window.getByRole('dialog', { name: /Import|Export and share/ });
const confirm = (window: Page) => dialog(window).locator('[data-transfer-confirm]');
const openImport = (window: Page) =>
  window.getByRole('button', { name: 'Import collection' }).click();
async function openExport(window: Page) {
  await window.locator('.rail [data-view="Settings"]').click();
  await window.locator('[data-settings-section="Data"]').click();
  await window.getByRole('button', { name: 'Choose format' }).click();
  await expect(dialog(window)).toBeVisible();
}
/** Picks `option` in the UiSelect whose native select has `id`. */
async function pick(window: Page, id: string, option: string) {
  await window.locator(`.ui-select:has(select#${id}) .ui-select-trigger`).click();
  await window.getByRole('option', { name: new RegExp(`^${option}`) }).click();
}
async function pastePreview(window: Page, text: string) {
  await dialog(window).locator('[data-transfer-tab=Paste]').click();
  await dialog(window).locator('#transfer-source').fill(text);
  await dialog(window).locator('[data-transfer-parse]').click();
}
const rowNamed = (window: Page, name: string) =>
  window.locator('[data-request-row]', { hasText: name });
/** The export's first lines, from its Preview contents panel. */
async function previewContents(window: Page) {
  const contents = dialog(window).locator('[data-transfer-contents]');
  if (!(await contents.isVisible()))
    await dialog(window).locator('summary', { hasText: 'Preview contents' }).click();
  return contents;
}
/** Downloads the export to `file` and returns it. */
const downloadExport = (app: ElectronApplication, window: Page, file: string) =>
  downloadTo(app, file, () => confirm(window).click());

test.describe('import', () => {
  test('a pasted collection is previewed, then imported and sent', async ({ window }) => {
    await openImport(window);
    await expect(dialog(window)).toBeVisible();
    await pastePreview(window, JSON.stringify(postman(api.url)));
    const preview = dialog(window).getByRole('status', { name: /Postman/ });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('List orders');
    await expect(preview).toContainText('Create order');
    await expect(confirm(window)).toHaveText(/Import 2 requests/);
    await confirm(window).click();
    await expect(dialog(window)).toHaveCount(0);
    await expect(rowNamed(window, 'List orders')).toBeVisible();

    // Collection variables arrive as an environment of their own, to choose when sending.
    await rowNamed(window, 'Create order').click();
    await window.getByRole('combobox', { name: 'Active environment' }).click();
    await window.getByRole('option', { name: /^Orders API variables/ }).click();
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200');
    expect(api.received.at(-1)).toMatchObject({
      method: 'POST',
      url: '/orders',
      body: '{"item":"book"}',
    });
  });

  test('a file chosen from disk is imported, and a curl command too', async ({ window }) => {
    const file = path.join(folder, 'orders.postman_collection.json');
    await writeFile(file, JSON.stringify(postman(api.url)));
    await openImport(window);
    await window.locator('#import-file').setInputFiles(file);
    await expect(confirm(window)).toHaveText(/Import 2 requests/);
    await confirm(window).click();
    await expect(rowNamed(window, 'List orders')).toBeVisible();

    const before = await window.locator('[data-request-row]').count();
    await openImport(window);
    await pastePreview(
      window,
      `curl -X PUT '${api.url}/users/9' -H 'X-Trace: curl-import' -d 'name=Lin'`,
    );
    await expect(confirm(window)).toHaveText(/Import 1 request\b/);
    await confirm(window).click();
    await expect(dialog(window)).toHaveCount(0);
    await expect(window.locator('[data-request-row]')).toHaveCount(before + 1);
    await window.getByPlaceholder(/^Find a request/).fill('users/9');
    await window.locator('[data-request-row]').first().click();
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users/9`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200');
    expect(api.received.at(-1)).toMatchObject({ method: 'PUT', url: '/users/9', body: 'name=Lin' });
    expect(api.received.at(-1)?.headers['x-trace']).toBe('curl-import');
  });

  test('something that is not a collection is explained, not imported', async ({ window }) => {
    const before = await window.locator('[data-request-row]').count();
    await openImport(window);
    await pastePreview(window, '{"hello": "world"}');
    await expect(dialog(window).getByRole('alert')).toBeVisible();
    await dialog(window).locator('[data-transfer-close]').first().click();
    await expect(dialog(window)).toHaveCount(0);
    await expect(window.locator('[data-request-row]')).toHaveCount(before);
  });

  test('scripts in an imported collection are not run', async ({ window }) => {
    const collection = {
      ...postman(api.url),
      event: [
        { listen: 'prerequest', script: { exec: [`pm.sendRequest('${api.url}/script-ran')`] } },
      ],
    };
    await openImport(window);
    await pastePreview(window, JSON.stringify(collection));
    await expect(confirm(window)).toHaveText(/Import 2 requests/);
    await confirm(window).click();
    await expect(rowNamed(window, 'List orders')).toBeVisible();
    expect(api.received.some((request) => request.url === '/script-ran')).toBe(false);
  });
});

test.describe('export', () => {
  test('the preview shows the start of the export, in the chosen format', async ({ window }) => {
    await openExport(window);
    const contents = await previewContents(window);
    await expect(contents).toContainText('"requests"');
    await pick(window, 'transfer-format', 'Postman v2.1');
    await expect(contents).toContainText('schema.getpostman.com');
    await pick(window, 'transfer-format', 'cURL');
    await expect(contents).toContainText('curl');
    await pick(window, 'transfer-format', 'OpenAPI 3.1 YAML');
    await expect(contents).toContainText('openapi: 3.1');
  });

  test('one collection can be exported on its own', async ({ window }) => {
    await openExport(window);
    await pick(window, 'transfer-format', 'cURL');
    await pick(window, 'transfer-scope', 'Posts');
    const contents = await previewContents(window);
    await expect(contents).toContainText('/posts');
    await expect(contents).not.toContainText('/users');
  });

  test('secret-looking values are left out of an export', async ({ app, window }) => {
    await window.locator('.rail [data-view="Environments"]').click();
    const editor = window.locator('.environment-editor');
    await editor.getByRole('button', { name: 'Add variable' }).click();
    await editor.getByLabel('Row 2 key').fill('api_token');
    await editor.getByLabel('Row 2 value').fill('e2e-made-up-export-value');
    await editor.getByLabel('Row 2 value').press('Tab');
    await openExport(window);
    const exported = await downloadExport(app, window, path.join(folder, 'workspace.json'));
    expect(exported).toContain('api_token');
    expect(exported).toContain('Get all users');
    expect(exported).not.toContain('e2e-made-up-export-value');
  });

  test('an export imports back into another workspace', async ({ app, window }) => {
    await openExport(window);
    await pick(window, 'transfer-format', 'Postman v2.1');
    await pick(window, 'transfer-scope', 'Getting started');
    const file = path.join(folder, 'getting-started.postman_collection.json');
    const exported = await downloadExport(app, window, file);
    expect(JSON.parse(exported).info.schema).toContain('v2.1');
    // Downloading closes the dialog.
    await expect(dialog(window)).toHaveCount(0);

    // A fresh workspace, then the export goes in.
    await window.locator('button.workspace').click();
    await window.locator('[data-workspace-new]').click();
    await window.locator('#workspace-create-name').fill('Round trip');
    await window.locator('[data-workspace-save]').click();
    await expect(window.locator('button.workspace')).toContainText('Round trip');
    await window.locator('.rail [data-view="Collections"]').click();
    await expect(rowNamed(window, 'Get all users')).toHaveCount(0);
    // A new workspace may open with the explorer hidden; show it to import and see the requests.
    const show = window.getByRole('button', { name: /^Show explorer/ });
    if (await show.isVisible()) await show.click();

    await openImport(window);
    await window.locator('#import-file').setInputFiles(file);
    await expect(confirm(window)).toHaveText(/Import 5 requests/);
    await confirm(window).click();
    for (const name of ['Get all users', 'Get a user', 'Create a user', 'Delete a user'])
      await expect(rowNamed(window, name)).toBeVisible();
  });
});
