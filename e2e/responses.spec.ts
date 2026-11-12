import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

const body = (window: Page) => window.locator('#response-source-editor .cm-content');
/** Sends `path` on the test API and waits for its status. */
async function send(window: Page, path: string, status = '200') {
  await window.locator('#url').fill(`${api.url}${path}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText(status);
}

test.describe('the response', () => {
  test('a new request waits for a response', async ({ window }) => {
    await expect(window.locator('#response-panel')).toContainText('Ready when you are');
  });

  test('JSON is shown formatted in Pretty, and as received in Raw', async ({ window }) => {
    await send(window, '/users');
    await expect(window.locator('[data-mode=Pretty]')).toHaveAttribute('aria-pressed', 'true');
    // Pretty spreads the JSON over several lines; Raw keeps it on the one it came on.
    await expect(body(window).locator('.cm-line')).not.toHaveCount(1);
    await window.locator('[data-mode=Raw]').click();
    await expect(window.locator('#response-panel')).toContainText(
      '{"users":[{"id":1,"name":"Ada"}]}',
    );
  });

  test('a JSON path filter shows only what it matches', async ({ window }) => {
    await send(window, '/users');
    await window.locator('#response-filter').fill('$.users[*].name');
    await expect(body(window)).toContainText('Ada');
    await expect(body(window)).not.toContainText('"id"');
    await window.locator('#response-filter').press('Escape');
    await expect(window.locator('#response-filter')).toHaveValue('');
    await expect(body(window)).toContainText('"id"');
  });

  test('a filter that is not a JSON path says so', async ({ window }) => {
    await send(window, '/users');
    await window.locator('#response-filter').fill('$.users[');
    await expect(window.locator('#response-filter-status')).toBeVisible();
  });

  test('the Headers tab lists what the server sent', async ({ window }) => {
    await send(window, '/users');
    await window.locator('[data-response-tab=Headers]').click();
    await expect(window.locator('[data-response-header="content-type"]')).toContainText(
      'application/json',
    );
  });

  test('the Cookies tab lists the cookies the response set', async ({ window }) => {
    await send(window, '/cookies/set');
    await window.locator('[data-response-tab=Cookies]').click();
    await expect(window.locator('[data-response-cookie]')).toHaveCount(3);
    const theme = window.locator('[data-response-cookie]', { hasText: 'theme' });
    await expect(theme).toContainText('dark');
    await expect(theme).toContainText('HttpOnly');
  });

  test('the Timeline shows the request that was sent', async ({ window }) => {
    await send(window, '/users?from=timeline');
    await window.locator('[data-response-tab=Timeline]').click();
    await expect(window.locator('#response-panel')).toContainText('/users?from=timeline');
  });

  test('a redirect is followed, ending at its target', async ({ window }) => {
    await send(window, '/redirect');
    await expect(body(window)).toContainText('Ada');
    expect(api.received.at(-1)?.url).toBe('/users');
  });

  test('a server that cannot be reached is explained', async ({ window, errors }) => {
    // Port 9 (discard) has nothing listening on the loopback address.
    await window.locator('#url').fill('http://127.0.0.1:9/nothing');
    await window.locator('[data-action=send]').click();
    await expect(window.locator('#response-panel')).toContainText('Request could not be completed');
    // A failed request is a result, not an error in the app.
    expect(errors).toEqual([]);
  });

  test('each request keeps its own response', async ({ window }) => {
    await send(window, '/users');
    await window.locator('.request-item', { hasText: 'Get all posts' }).click();
    await expect(window.locator('#response-panel')).toContainText('Ready when you are');
    await window.locator('.request-item', { hasText: 'Get all users' }).click();
    await expect(window.locator('.response-meta')).toContainText('200 OK');
    await expect(body(window)).toContainText('Ada');
  });
});
