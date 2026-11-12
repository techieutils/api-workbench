import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';

// A new workspace has three collections: Getting started (five requests), Posts, and GraphQL.
const collection = (window: Page, name: string) => window.locator(`[data-collection="${name}"]`);
const request = (window: Page, name: string) => window.locator('.request-item', { hasText: name });
const rows = (window: Page) => window.locator('[data-request-row]');
/** Chooses an item from the ⋯ menu of a collection, folder, or request in the explorer. */
async function menu(window: Page, label: string, item: string) {
  await window.getByRole('button', { name: `Actions for ${label}`, exact: true }).click();
  await window
    .getByRole('menu', { name: `Actions for ${label}`, exact: true })
    .locator(`[data-menu-item="${item}"]`)
    .click();
}
const dialog = (window: Page) => window.locator('[data-confirm-dialog]');

test.describe('collections', () => {
  test('a new collection starts with a request, and is named as it is made', async ({ window }) => {
    await window.locator('[data-new-collection]').click();
    const name = window.locator('[data-folder-rename="New collection"]');
    await expect(name).toBeFocused();
    await name.fill('Billing');
    await name.press('Enter');
    await expect(collection(window, 'Billing')).toContainText('Untitled request');
    await expect(window.locator('.breadcrumb')).toContainText('Billing');
    await expect(window.locator('#url')).toHaveValue('https://');
  });

  test('a collection is renamed with a double-click, and its requests move with it', async ({
    window,
  }) => {
    await window.locator('[data-folder-toggle="Posts"]').dblclick();
    const name = window.locator('[data-folder-rename="Posts"]');
    await name.fill('Articles');
    await name.press('Enter');
    await expect(collection(window, 'Articles')).toContainText('Get all posts');
    await expect(collection(window, 'Posts')).toHaveCount(0);
  });

  test('a collection cannot take the name of another', async ({ window }) => {
    await window.locator('[data-folder-toggle="Posts"]').dblclick();
    const name = window.locator('[data-folder-rename="Posts"]');
    await name.fill('GraphQL');
    await name.press('Enter');
    await expect(window.locator('#folder-rename-error')).toBeVisible();
    await name.press('Escape');
    await expect(collection(window, 'Posts')).toBeVisible();
  });

  test('a folder made inside a collection holds its own request', async ({ window }) => {
    await menu(window, 'Posts', 'new-folder');
    const name = window.locator('[data-folder-rename="Posts/New folder"]');
    await expect(name).toBeFocused();
    await name.fill('Drafts');
    await name.press('Enter');
    const folder = window.locator('[data-folder="Posts/Drafts"]');
    await expect(folder).toBeVisible();
    await expect(window.locator('.breadcrumb')).toContainText('Drafts');
    // Collapsing the collection hides its folder and requests.
    await window.locator('[data-folder-toggle="Posts"]').click();
    await expect(window.locator('[data-folder-toggle="Posts"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(folder).toBeHidden();
    await expect(request(window, 'Get all posts')).toBeHidden();
    await window.locator('[data-folder-toggle="Posts"]').click();
    await expect(folder).toBeVisible();
  });

  test('New request here adds a request to that collection', async ({ window }) => {
    await menu(window, 'GraphQL', 'new');
    await expect(collection(window, 'GraphQL').locator('[data-request-row]')).toHaveCount(2);
    await expect(window.locator('.breadcrumb')).toContainText('GraphQL');
  });

  test('Duplicate collection copies its requests under a new name', async ({ window }) => {
    await menu(window, 'Posts', 'duplicate');
    await expect(collection(window, 'Posts copy')).toContainText('Get all posts');
    await expect(rows(window)).toHaveCount(8);
  });

  test('deleting a collection asks first, then removes its requests', async ({ window }) => {
    await menu(window, 'Posts', 'delete');
    await expect(dialog(window)).toBeVisible();
    await dialog(window).locator('[data-confirm-cancel]').click();
    await expect(collection(window, 'Posts')).toBeVisible();

    await menu(window, 'Posts', 'delete');
    await dialog(window).locator('[data-confirm-accept]').click();
    await expect(collection(window, 'Posts')).toHaveCount(0);
    await expect(rows(window)).toHaveCount(6);
  });

  test('the filter finds requests by name', async ({ window }) => {
    await window.locator('#filter').fill('posts');
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window)).toContainText('Get all posts');
    await window.locator('#filter').fill('nothing like this');
    await expect(rows(window)).toHaveCount(0);
    await expect(window.getByText('No matching requests')).toBeVisible();
    await window.locator('#filter').fill('');
    await expect(rows(window)).toHaveCount(7);
  });
});

test.describe('requests in the explorer', () => {
  test('a request is renamed with a double-click', async ({ window }) => {
    await request(window, 'Get a user').dblclick();
    const name = window.locator('[data-request-rename]');
    await expect(name).toBeFocused();
    await name.fill('Fetch one user');
    await name.press('Enter');
    await expect(request(window, 'Fetch one user')).toBeVisible();
    await expect(request(window, 'Get a user')).toHaveCount(0);
  });

  test('Escape leaves the name as it was', async ({ window }) => {
    await request(window, 'Get a user').dblclick();
    const name = window.locator('[data-request-rename]');
    await name.fill('Something else');
    await name.press('Escape');
    await expect(request(window, 'Get a user')).toBeVisible();
  });

  test('Duplicate opens a copy of the request', async ({ window }) => {
    await menu(window, 'Get a user', 'duplicate');
    await expect(rows(window)).toHaveCount(8);
    await expect(window.locator('#request-name')).toHaveText(/Get a user/);
    await expect(request(window, 'Get a user').nth(1)).toBeVisible();
  });

  test('Move down and Alt+Arrow change the order', async ({ window }) => {
    const names = () =>
      collection(window, 'Getting started').locator('.request-item .truncate').allTextContents();
    await menu(window, 'Get all users', 'down');
    await expect
      .poll(names)
      .toEqual(['Get a user', 'Get all users', 'Create a user', 'Update a user', 'Delete a user']);
    await request(window, 'Get all users').focus();
    await window.keyboard.press('Alt+ArrowUp');
    await expect.poll(async () => (await names())[0]).toBe('Get all users');
  });

  test('deleting a request asks first', async ({ window }) => {
    await menu(window, 'Delete a user', 'delete');
    await expect(dialog(window)).toContainText('Delete “Delete a user”?');
    await dialog(window).locator('[data-confirm-cancel]').click();
    await expect(rows(window)).toHaveCount(7);

    await window.getByRole('button', { name: 'Delete Delete a user', exact: true }).click();
    await dialog(window).locator('[data-confirm-accept]').click();
    await expect(rows(window)).toHaveCount(6);
    await expect(request(window, 'Delete a user')).toHaveCount(0);
  });

  test('a request opened from the explorer opens in a tab', async ({ window }) => {
    await request(window, 'Get all posts').click();
    await expect(window.locator('#request-name')).toHaveText('Get all posts');
    await expect(request(window, 'Get all posts')).toHaveAttribute('aria-current', 'true');
    await expect(window.locator('.request-tab', { hasText: 'Get all posts' })).toBeVisible();
  });
});

test('collections, folders, and names are kept after a restart', async () => {
  const data = await dataFolder();
  const errors: string[] = [];
  try {
    const first = await launchApp(data, errors);
    const window = await mainWindow(first, errors);
    await menu(window, 'Posts', 'new-folder');
    const folder = window.locator('[data-folder-rename="Posts/New folder"]');
    await folder.fill('Drafts');
    await folder.press('Enter');
    await request(window, 'Get a user').dblclick();
    await window.locator('[data-request-rename]').fill('Fetch one user');
    await window.locator('[data-request-rename]').press('Enter');
    await window.keyboard.press('ControlOrMeta+S');
    await expect(window.locator('#save-status')).toHaveText(/Saved/);
    await first.close();

    const second = await launchApp(data, errors);
    const reopened = await mainWindow(second, errors);
    await expect(reopened.locator('[data-folder="Posts/Drafts"]')).toBeVisible();
    await expect(request(reopened, 'Fetch one user')).toBeVisible();
    await second.close();
    expect(errors).toEqual([]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
