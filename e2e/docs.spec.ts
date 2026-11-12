import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { dataFolder, downloadTo, expect, test } from './fixtures';

const openDocs = (window: Page) => window.locator('.rail [data-view="Documentation"]').click();
const endpoints = (window: Page) => window.locator('.docs-endpoint');
const source = (window: Page) => window.locator('#documentation-source .cm-content');
const mode = (window: Page, name: string) => window.locator(`[data-docs-mode="${name}"]`).click();
async function chooseCollection(window: Page, name: string) {
  await window.locator('.ui-select:has(select#docs-collection) .ui-select-trigger').click();
  await window.getByRole('option', { name: new RegExp(`^${name}`) }).click();
}

test.describe('API documentation', () => {
  test('a collection’s requests are listed as endpoints', async ({ window }) => {
    await openDocs(window);
    await expect(window.locator('.docs-collection-picker')).toContainText('Getting started');
    await expect(window.locator('.docs-collection-picker')).toContainText(
      '5 requests · Generated from saved requests',
    );
    await expect(endpoints(window)).toHaveCount(5);
    await expect(endpoints(window).first()).toContainText('GET');
    await expect(endpoints(window).first()).toContainText('{{base_url}}/users');
    await expect(endpoints(window).first()).toContainText('Get all users');

    await chooseCollection(window, 'Posts');
    await expect(endpoints(window)).toHaveCount(1);
    await expect(endpoints(window).first()).toContainText('Get all posts');
  });

  test('an endpoint opens to show its body, and opens its request', async ({ window }) => {
    await openDocs(window);
    const create = endpoints(window).filter({ hasText: 'Create a user' });
    await create.locator('summary').click();
    await expect(create).toContainText('Request body');
    await expect(create).toContainText('alex@example.com');
    await expect(create).toContainText('Content-Type');
    await create.getByRole('button', { name: 'Open request' }).click();
    await expect(window.locator('#url')).toHaveValue('{{base_url}}/users');
    await expect(window.getByRole('button', { name: 'POST Create a user' }).first()).toBeVisible();
  });

  test('each format shows the collection in that form', async ({ window }) => {
    await openDocs(window);
    await mode(window, 'YAML');
    await expect(source(window)).toContainText('openapi:');
    await expect(source(window)).toContainText('/users');
    await mode(window, 'OpenAPI JSON');
    await expect(source(window)).toContainText('"openapi"');
    await mode(window, 'Swagger JSON');
    await expect(source(window)).toContainText('"swagger": "2.0"');
    await mode(window, 'JSON');
    await expect(source(window)).toContainText('"requests"');
    await expect(window.locator('[data-docs-mode=JSON]')).toHaveAttribute('aria-pressed', 'true');
    // Swagger, the endpoint view, has no source to format.
    await mode(window, 'Swagger');
    await expect(window.locator('[data-docs-format]')).toHaveCount(0);
  });

  test('Download saves the whole specification', async ({ app, window }) => {
    const folder = await dataFolder();
    try {
      await openDocs(window);
      await mode(window, 'YAML');
      const yaml = await downloadTo(app, path.join(folder, 'getting-started.yaml'), () =>
        window.locator('[data-docs-download]').click(),
      );
      expect(yaml).toMatch(/^openapi: 3/m);
      for (const operation of ['/users:', '/users/1:', 'get:', 'post:', 'patch:', 'delete:'])
        expect(yaml).toContain(operation);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('the docs follow changes to the requests', async ({ window }) => {
    await window.locator('[data-request-row]', { hasText: 'Get a user' }).click();
    await window.locator('#url').fill('{{base_url}}/users/42?expand=true');
    await openDocs(window);
    await expect(endpoints(window).filter({ hasText: '/users/42' })).toHaveCount(1);
    // The query is part of the request, not of the path the docs show.
    await expect(endpoints(window).filter({ hasText: 'expand=true' })).toHaveCount(0);
  });

  test('tags filter the documented requests', async ({ window }) => {
    await window.locator('[data-action=add-tag]').first().click();
    const field = window.locator('[data-tag-input]');
    await field.fill('public');
    await field.press('Enter');
    await openDocs(window);
    const chip = window.locator('[data-docs-tags] [data-runner-tag=public]');
    await chip.click();
    await expect(window.locator('.docs-collection-picker')).toContainText(
      '1 of 5 requests · tagged public',
    );
    await expect(endpoints(window)).toHaveCount(1);
    await expect(endpoints(window).first()).toContainText('public');
  });

  test('Start mock serves the collection from a local mock server', async ({ window }) => {
    await openDocs(window);
    await window.locator('[data-docs-mock]').click();
    await expect(window.locator('[data-mock-stop]')).toBeVisible();
    await expect(window.locator('[data-mock-route]')).toHaveCount(5);
    const port = await window.locator('#mock-port').inputValue();
    const response = await fetch(`http://127.0.0.1:${port}/users`);
    expect(response.status).toBeLessThan(500);
    await window.locator('[data-mock-stop]').click();
  });

  test('Import specification opens the import dialog', async ({ window }) => {
    await openDocs(window);
    await window.locator('.docs-page [data-action=import]').click();
    await expect(window.getByRole('dialog', { name: 'Import' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Import' })).toHaveCount(0);
  });
});
