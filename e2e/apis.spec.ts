import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';

const openApis = (window: Page) => window.locator('.rail [data-view="APIs"]').click();
const specs = (window: Page) => window.locator('[data-spec-select]');
const status = (window: Page) => window.locator('[data-spec-status]');
const endpoints = (window: Page) => window.locator('[data-spec-endpoint]');
const toast = (window: Page, text: string | RegExp) => window.getByText(text).last();
/** Replaces the open specification's text in its editor. */
async function setSpecText(window: Page, text: string) {
  await window.getByRole('textbox', { name: 'Specification editor' }).click();
  await window.keyboard.press('ControlOrMeta+A');
  // Clear first: typing over a selection that starts on highlighted YAML makes Chromium try to
  // add an inline style, which the content policy blocks and logs (the text itself is right).
  await window.keyboard.press('Backspace');
  await window.keyboard.insertText(text);
}
async function newSpec(window: Page) {
  await openApis(window);
  await window.locator('[data-spec-new]').click();
  await expect(window.locator('#spec-name')).toHaveValue('New API');
}

/** A Swagger 2.0 description of a small pet store, as a file might hold it. */
const swagger = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Pets', version: '1.0.0' },
  host: 'pets.example.test',
  basePath: '/v1',
  paths: {
    '/pets': {
      get: { summary: 'List pets', tags: ['Pets'], responses: { 200: { description: 'OK' } } },
      post: { summary: 'Add a pet', tags: ['Pets'], responses: { 201: { description: 'OK' } } },
    },
    '/owners/{id}': {
      get: {
        summary: 'Get an owner',
        tags: ['Owners'],
        parameters: [{ name: 'id', in: 'path', required: true, type: 'integer' }],
        responses: { 200: { description: 'OK' } },
      },
    },
  },
});

test.describe('API specifications', () => {
  test('a new workspace has none, and a new one starts from a valid template', async ({
    window,
  }) => {
    await openApis(window);
    await expect(window.getByText('No API specifications yet')).toBeVisible();
    await window.locator('[data-spec-new]').click();
    await expect(specs(window)).toHaveCount(1);
    await expect(specs(window).first()).toContainText('2 endpoints');
    await expect(status(window)).toContainText('YAML');
    await expect(status(window)).toContainText('Valid');

    await window.locator('[data-spec-tab=Endpoints]').click();
    await expect(endpoints(window)).toHaveCount(2);
    await expect(window.locator('.spec-endpoint-group h4')).toHaveText(['Items']);
    await expect(endpoints(window).first()).toContainText('/items');
    await expect(endpoints(window).nth(1)).toContainText('/items/{id}');
  });

  test('problems are listed as they are typed, and block a collection', async ({ window }) => {
    await newSpec(window);
    await setSpecText(window, 'openapi: 3.0.3\ninfo:\n  title: Broken\npaths:\n  /a: [');
    await expect(status(window)).toContainText(/\d+ errors?/);
    await expect(window.locator('[data-spec-problem]').first()).toBeVisible();
    // The list marks the specification with its error count too.
    await expect(specs(window).first().locator('.badge.danger')).toBeVisible();
    await window.locator('[data-spec-collection]').click();
    await expect(
      toast(window, 'Fix the specification’s errors before generating a collection.'),
    ).toBeVisible();

    await setSpecText(
      window,
      'openapi: 3.0.3\ninfo:\n  title: Fixed\n  version: "1"\npaths:\n  /ping:\n    get:\n      responses:\n        "200":\n          description: OK\n',
    );
    await expect(status(window)).toContainText('Valid');
    await expect(window.locator('[data-spec-problem]')).toHaveCount(0);
    await expect(window.locator('[data-spec-tab=Endpoints]')).toContainText('1');
  });

  test('a Swagger file opens with its endpoints grouped by tag', async ({ window }) => {
    const folder = await dataFolder();
    try {
      const file = path.join(folder, 'pets.json');
      await writeFile(file, swagger);
      await openApis(window);
      await window.locator('[data-spec-file]').setInputFiles(file);
      await expect(toast(window, 'Opened pets')).toBeVisible();
      await expect(window.locator('#spec-name')).toHaveValue('pets');
      await expect(status(window)).toContainText('JSON');
      await expect(specs(window).first()).toContainText('3 endpoints');
      await window.locator('[data-spec-tab=Endpoints]').click();
      await expect(window.locator('.spec-endpoint-group h4')).toHaveText(['Pets', 'Owners']);
      await expect(endpoints(window).filter({ hasText: 'Add a pet' })).toContainText('POST');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('Generate collection makes requests, and refreshes them after asking', async ({
    window,
  }) => {
    await newSpec(window);
    await window.locator('[data-spec-collection]').click();
    await expect(toast(window, 'Created the New API collection with 2 requests')).toBeVisible();
    await expect(status(window)).toContainText('Collection: New API');

    await window.locator('.rail [data-view="Collections"]').click();
    await expect(window.locator('[data-request-row]', { hasText: 'List items' })).toBeVisible();
    await expect(window.locator('[data-request-row]', { hasText: 'Get an item' })).toBeVisible();

    await openApis(window);
    await window.locator('[data-spec-collection]').click();
    const dialog = window.locator('[data-confirm-dialog]');
    await expect(dialog).toContainText('Refresh the “New API” collection?');
    await dialog.locator('[data-confirm-accept]').click();
    await expect(toast(window, 'Refreshed the New API collection with 2 requests')).toBeVisible();
  });

  test('a specification can describe an existing collection', async ({ window }) => {
    await openApis(window);
    await window
      .getByRole('combobox', { name: 'Create a specification from a collection' })
      .click();
    await window.getByRole('option', { name: /^Getting started/ }).click();
    await expect(toast(window, 'Created a specification from Getting started')).toBeVisible();
    await expect(window.locator('#spec-name')).toHaveValue('Getting started API');
    await expect(status(window)).toContainText('Collection: Getting started');
    await window.locator('[data-spec-tab=Endpoints]').click();
    // GET and POST /users, and GET, PATCH, and DELETE /users/1.
    await expect(endpoints(window)).toHaveCount(5);
  });

  test('Start mock serves the specification’s examples', async ({ window }) => {
    await newSpec(window);
    await window.locator('[data-spec-mock]').click();
    await expect(window.locator('[data-mock-stop]')).toBeVisible();
    await expect(window.locator('[data-mock-route]')).toHaveCount(2);
    const port = await window.locator('#mock-port').inputValue();
    const response = await fetch(`http://127.0.0.1:${port}/items`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1, name: 'First item' }]);
    await window.locator('[data-mock-stop]').click();
    await expect(window.locator('[data-mock-start]')).toBeVisible();
  });

  test('specifications are renamed, duplicated, and deleted after asking', async ({ window }) => {
    await newSpec(window);
    const name = window.locator('#spec-name');
    await name.fill('Catalog API');
    await name.press('Enter');
    await expect(specs(window).first()).toContainText('Catalog API');

    await window.getByRole('button', { name: 'More specification actions' }).click();
    await window.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(toast(window, 'Duplicated Catalog API')).toBeVisible();
    await expect(specs(window)).toHaveCount(2);

    await specs(window).first().click({ button: 'right' });
    await window.locator('[data-spec-menu] [data-menu-item=delete]').click();
    const dialog = window.locator('[data-confirm-dialog]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-confirm-cancel]').click();
    await expect(specs(window)).toHaveCount(2);
    await specs(window).first().click({ button: 'right' });
    await window.locator('[data-spec-menu] [data-menu-item=delete]').click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(specs(window)).toHaveCount(1);
  });

  test('specifications are kept when the app is closed and opened again', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await newSpec(window);
      await window.locator('#spec-name').fill('Kept API');
      await window.locator('#spec-name').press('Enter');
      await window.keyboard.press('ControlOrMeta+S');
      await expect(window.locator('#save-status')).toHaveText(/Saved/);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await openApis(reopened);
      await expect(specs(reopened)).toHaveCount(1);
      await expect(specs(reopened).first()).toContainText('Kept API');
      await expect(status(reopened)).toContainText('Valid');
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
