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

const switcher = (window: Page) => window.locator('button.workspace');
const manager = (window: Page) => window.getByRole('dialog', { name: /A space for every project/ });
const rows = (window: Page) => manager(window).locator('[data-workspace-row]');
const row = (window: Page, name: string) => rows(window).filter({ hasText: name });
async function openManager(window: Page) {
  await switcher(window).click();
  await expect(manager(window)).toBeVisible();
}
/** Creates a workspace from the manager; it opens once created. */
async function createWorkspace(window: Page, name: string) {
  await openManager(window);
  await manager(window).locator('[data-workspace-new]').click();
  await window.locator('#workspace-create-name').fill(name);
  await manager(window).locator('[data-workspace-save]').click();
  await expect(switcher(window)).toContainText(name);
  await expect(manager(window)).toHaveCount(0);
}
async function switchTo(window: Page, name: string) {
  await openManager(window);
  await row(window, name)
    .getByRole('button', { name: `Switch to ${name}` })
    .click();
  await expect(switcher(window)).toContainText(name);
}
async function send(window: Page, pathname: string) {
  await window.locator('#url').fill(`${api.url}${pathname}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText('200');
}

test.describe('workspaces', () => {
  test('the manager lists the current workspace and closes with Escape', async ({ window }) => {
    await expect(switcher(window)).toContainText('Personal workspace');
    await openManager(window);
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('Current workspace');
    await window.keyboard.press('Escape');
    await expect(manager(window)).toHaveCount(0);
  });

  test('a new workspace needs a name, then opens empty', async ({ window }) => {
    await openManager(window);
    await manager(window).locator('[data-workspace-new]').click();
    const name = window.locator('#workspace-create-name');
    await name.fill('   ');
    await expect(manager(window).locator('[data-workspace-save]')).toBeDisabled();
    // Enter does nothing either: a form never submits while its button is disabled.
    await name.press('Enter');
    await expect(manager(window).locator('[data-workspace-new]')).toBeVisible();
    await expect(rows(window)).toHaveCount(1);
    await name.fill('Platform Engineering');
    await expect(manager(window).locator('#workspace-name-count')).toHaveText('20/60');
    await manager(window).locator('[data-workspace-save]').click();
    await expect(switcher(window)).toContainText('Platform Engineering');
    // It starts with one untitled request; the sample requests stay in the first workspace.
    await window.locator('.rail [data-view="Collections"]').click();
    await expect(window.getByRole('button', { name: 'GET Untitled request' })).toBeVisible();
    await expect(window.locator('#url')).toHaveValue('{{base_url}}');
    await expect(window.locator('[data-request-row]', { hasText: 'Get all users' })).toHaveCount(0);

    await openManager(window);
    await expect(rows(window)).toHaveCount(2);
    await expect(row(window, 'Platform Engineering')).toContainText('Current workspace');
  });

  test('workspaces keep their own requests, environments, and history', async ({ window }) => {
    await send(window, '/users/from-personal');
    await createWorkspace(window, 'Second');
    await window.locator('.rail [data-view="History"]').click();
    await expect(window.getByText('No requests in your history')).toBeVisible();
    await window.locator('.rail [data-view="Collections"]').click();
    await send(window, '/users/from-second');

    await switchTo(window, 'Personal workspace');
    await window.locator('.rail [data-view="History"]').click();
    const entries = window.locator('[data-history-entry]');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('/users/from-personal');
    await window.locator('.rail [data-view="Collections"]').click();
    await expect(window.locator('[data-request-row]', { hasText: 'Get all users' })).toBeVisible();

    await switchTo(window, 'Second');
    await window.locator('.rail [data-view="History"]').click();
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('/users/from-second');
  });

  test('search finds a workspace, and renaming changes its name everywhere', async ({ window }) => {
    await createWorkspace(window, 'Billing');
    await createWorkspace(window, 'Search team');
    await openManager(window);
    await expect(rows(window)).toHaveCount(3);
    const search = manager(window).getByRole('searchbox', { name: 'Search workspaces' });
    await search.fill('bill');
    await expect(rows(window)).toHaveCount(1);
    await expect(rows(window).first()).toContainText('Billing');
    await search.fill('');

    await row(window, 'Search team').getByRole('button', { name: 'Rename Search team' }).click();
    const name = window.locator('#workspace-rename-name');
    await expect(name).toHaveValue('Search team');
    await name.fill('Discovery');
    await manager(window).locator('[data-workspace-save]').click();
    await expect(row(window, 'Discovery')).toBeVisible();
    await expect(switcher(window)).toContainText('Discovery');
  });

  test('only a workspace that is not open can be deleted, after asking', async ({ window }) => {
    await createWorkspace(window, 'Throwaway');
    await openManager(window);
    await row(window, 'Throwaway').locator('[data-workspace-inspect]').click();
    // It is open, so it cannot be deleted from here.
    await expect(
      manager(window).getByRole('button', { name: 'Switch to another workspace before deleting' }),
    ).toBeDisabled();
    await window.keyboard.press('Escape');

    await switchTo(window, 'Personal workspace');
    await openManager(window);
    await row(window, 'Throwaway').locator('[data-workspace-inspect]').click();
    await manager(window).getByRole('button', { name: 'Delete Throwaway' }).click();
    await expect(manager(window)).toContainText('Delete Throwaway?');
    await expect(manager(window)).toContainText('This cannot be undone.');
    await manager(window).getByRole('button', { name: 'Keep workspace' }).click();
    await expect(rows(window)).toHaveCount(2);

    await manager(window).getByRole('button', { name: 'Delete Throwaway' }).click();
    await manager(window).locator('[data-workspace-delete-confirm]').click();
    await expect(rows(window)).toHaveCount(1);
    await expect(row(window, 'Throwaway')).toHaveCount(0);
  });

  test('the open workspace is the one that opens after a restart', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await createWorkspace(window, 'Kept open');
      await window.locator('#url').fill(`${api.url}/kept-in-second`);
      await window.keyboard.press('ControlOrMeta+S');
      await expect(window.locator('#save-status')).toHaveText(/Saved/);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await expect(switcher(reopened)).toContainText('Kept open');
      await expect(reopened.locator('#url')).toHaveValue(`${api.url}/kept-in-second`);
      await openManager(reopened);
      await expect(rows(reopened)).toHaveCount(2);
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
