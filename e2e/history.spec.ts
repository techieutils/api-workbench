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

/** Sends the open request to `path` on the test API and waits for its status. */
async function send(window: Page, path: string, status: string) {
  await window.locator('#url').fill(`${api.url}${path}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText(status);
}
const openHistory = (window: Page) => window.locator('.rail [data-view="History"]').click();
const entries = (window: Page) => window.locator('[data-history-entry]');

test.describe('History', () => {
  test('a new workspace has no history, and Clear history is off', async ({ window }) => {
    await openHistory(window);
    await expect(window.getByText('No requests in your history')).toBeVisible();
    await expect(window.locator('[data-action=clear-history]')).toBeDisabled();
  });

  test('selecting an entry shows the response it got, body and headers', async ({ window }) => {
    await send(window, '/users', '200');
    await openHistory(window);
    await expect(entries(window)).toHaveCount(1);
    await expect(entries(window).first()).toContainText('GET');
    await entries(window).first().click();
    const detail = window.locator('[data-history-detail]');
    await expect(detail).toContainText('200 OK');
    await expect(detail).toContainText(`${api.url}/users`);
    await expect(window.locator('#history-response-editor')).toContainText('Ada');
    await window.locator('[data-history-tab=Headers]').click();
    await expect(window.locator('[data-history-header="content-type"]')).toContainText(
      'application/json',
    );
    await window.locator('[data-history-headers-view=Raw]').click();
    await expect(window.locator('#history-headers-editor')).toContainText(
      'set-cookie: session=e2e',
    );
    await window.locator('[data-history-close]').click();
    await expect(detail).toHaveCount(0);
  });

  test('search and the status filters narrow the list', async ({ window }) => {
    await send(window, '/users', '200');
    await send(window, '/missing', '404');
    await send(window, '/echo/orders', '200');
    await openHistory(window);
    await expect(entries(window)).toHaveCount(3);
    await expect(window.locator('[data-history-status="2xx"] .history-count')).toHaveText('2');
    await expect(window.locator('[data-history-status="4xx"] .history-count')).toHaveText('1');

    await window.locator('[data-history-status="4xx"]').click();
    await expect(entries(window)).toHaveCount(1);
    await expect(entries(window).first()).toContainText('/missing');
    await window.locator('[data-history-status=All]').click();

    await window.getByRole('searchbox', { name: 'Search history' }).fill('orders');
    await expect(entries(window)).toHaveCount(1);
    await expect(entries(window).first()).toContainText('/echo/orders');
    await window.getByRole('searchbox', { name: 'Search history' }).fill('nothing-like-this');
    await expect(window.getByText('No matching requests')).toBeVisible();
  });

  test('Open request goes back to the request that was sent', async ({ window }) => {
    await send(window, '/users/first', '200');
    await window.keyboard.press('ControlOrMeta+N');
    await expect(window.locator('#url')).toHaveValue('https://');
    await send(window, '/users/second', '200');
    await openHistory(window);
    // Newest first: the second request's entry is on top.
    await expect(entries(window).first()).toContainText('/users/second');
    await entries(window).nth(1).click();
    await window.locator('[data-history-open]').click();
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users/first`);
  });

  test('the entry menu sends again, filters by status, and removes', async ({ window }) => {
    await send(window, '/missing', '404');
    await send(window, '/users/again', '200');
    await openHistory(window);
    const menu = window.locator('[data-history-menu]');

    await entries(window).first().click({ button: 'right' });
    await menu.locator('[data-menu-item=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200');
    expect(api.received.filter((request) => request.url === '/users/again')).toHaveLength(2);
    await openHistory(window);
    await expect(entries(window)).toHaveCount(3);

    await entries(window).last().click({ button: 'right' });
    await expect(menu.locator('[data-menu-item=filter]')).toContainText('Show only 4xx');
    await menu.locator('[data-menu-item=filter]').click();
    await expect(entries(window)).toHaveCount(1);
    await expect(window.locator('[data-history-status="4xx"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await entries(window).first().click({ button: 'right' });
    await menu.locator('[data-menu-item=remove]').click();
    await expect(window.getByText('No matching requests')).toBeVisible();
    await window.locator('[data-history-status=All]').click();
    await expect(entries(window)).toHaveCount(2);
  });

  test('Compare shows how two responses of a request differ', async ({ window }) => {
    await send(window, '/echo?n=1', '200');
    await send(window, '/echo?n=2', '200');
    await openHistory(window);
    await entries(window).first().click();
    await window.locator('[data-history-tab=Compare]').click();
    const detail = window.locator('[data-history-detail]');
    await expect(detail).toContainText('/echo?n=1');
    await expect(detail).toContainText('/echo?n=2');
    await expect(window.locator('[data-compare-row]').first()).toBeVisible();
  });

  test('Clear history asks first, then empties it', async ({ window }) => {
    await send(window, '/users', '200');
    await send(window, '/missing', '404');
    await openHistory(window);
    const dialog = window.locator('[data-confirm-dialog]');

    await window.locator('[data-action=clear-history]').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-confirm-cancel]').click();
    await expect(entries(window)).toHaveCount(2);

    await window.locator('[data-action=clear-history]').click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(window.getByText('No requests in your history')).toBeVisible();
    await expect(entries(window)).toHaveCount(0);
  });

  test('entries are kept across a restart, but responses only when chosen', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await send(window, '/users/kept', '200');
      await openHistory(window);
      await expect(entries(window)).toHaveCount(1);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await openHistory(reopened);
      await expect(entries(reopened)).toHaveCount(1);
      await expect(entries(reopened).first()).toContainText('/users/kept');
      // Persist response bodies is off by default, so the body stayed with the session.
      await entries(reopened).first().click();
      await expect(reopened.locator('[data-history-detail]')).toContainText('Response not kept');
      await expect(reopened.locator('[data-history-detail]')).toContainText('200');
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
