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

/** Sends the open request to `path` on the test API and returns the Cookie header it carried. */
async function send(window: Page, path: string): Promise<string | undefined> {
  const before = api.received.length;
  await window.locator('#url').fill(`${api.url}${path}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText(/\d{3}/);
  await expect.poll(() => api.received.length).toBeGreaterThan(before);
  return api.received.at(-1)?.headers.cookie;
}
const openCookies = (window: Page) => window.locator('.rail [data-view="Cookies"]').click();
const openCollections = (window: Page) => window.locator('.rail [data-view="Collections"]').click();
const jarFor = (window: Page, domain: string) =>
  window.getByRole('region', { name: `Cookies for ${domain}` });
const host = () => new URL(api.url).hostname;
/** Adds a cookie with the Cookies screen's form. */
async function addCookie(window: Page, domain: string, name: string, value: string) {
  await window.locator('[data-cookie-add]').click();
  const form = window.locator('#cookie-add-form');
  await form.locator('[name=domain]').fill(domain);
  await form.locator('[name=name]').fill(name);
  await form.locator('[name=value]').fill(value);
  await form.getByRole('button', { name: 'Add cookie' }).click();
  await expect(form).toHaveCount(0);
}

test.describe('cookies', () => {
  test('a new workspace starts with an empty jar that is on', async ({ window }) => {
    await openCookies(window);
    await expect(window.getByText('The cookie jar is empty')).toBeVisible();
    await expect(window.locator('#cookie-jar-enabled')).toBeChecked();
    await expect(window.locator('[data-cookie-clear-all]')).toBeDisabled();
  });

  test('cookies a response sets are stored, then sent to matching paths', async ({ window }) => {
    expect(await send(window, '/cookies/set')).toBeUndefined();
    await window.locator('[data-response-tab=Cookies]').click();
    await expect(window.locator('[data-response-cookie]')).toHaveCount(3);
    await expect(window.locator('[data-response-cookie]').nth(1)).toContainText('theme');
    await expect(window.locator('[data-response-cookie]').nth(1)).toContainText('HttpOnly');

    // `scoped` has Path=/cookies, so only requests under that path carry it.
    expect(await send(window, '/users')).toBe('session=e2e; theme=dark');
    const underPath = await send(window, '/cookies/check');
    expect(underPath?.split('; ').sort()).toEqual(['scoped=yes', 'session=e2e', 'theme=dark']);

    await openCookies(window);
    const jar = jarFor(window, host());
    await expect(jar.locator('[data-cookie-row]')).toHaveCount(3);
    const theme = jar.locator('[data-cookie-row]', { hasText: 'theme' });
    await expect(theme).toContainText('HttpOnly');
    await expect(theme.locator('.cookie-expiry')).not.toContainText('Session');
    await expect(jar.locator('[data-cookie-row]', { hasText: 'scoped' })).toContainText(
      'SameSite=Lax',
    );
  });

  test('with the jar off, cookies are neither stored nor sent', async ({ window }) => {
    await send(window, '/users');
    await openCookies(window);
    await window.locator('#cookie-jar-enabled').setChecked(false);
    await expect(window.locator('#cookie-jar-description')).toContainText(
      'neither stored nor sent',
    );
    // The saved cookie stays, but requests leave it out.
    await expect(jarFor(window, host()).locator('[data-cookie-row]')).toHaveCount(1);
    await openCollections(window);
    expect(await send(window, '/cookies/set')).toBeUndefined();
    await openCookies(window);
    await expect(jarFor(window, host()).locator('[data-cookie-row]')).toHaveCount(1);

    await window.locator('#cookie-jar-enabled').setChecked(true);
    await openCollections(window);
    expect(await send(window, '/users')).toBe('session=e2e');
  });

  test('a cookie added by hand, then edited, is sent with its value', async ({ window }) => {
    await openCookies(window);
    await addCookie(window, host(), 'manual', 'first');
    const row = jarFor(window, host()).locator('[data-cookie-row]', { hasText: 'manual' });
    await expect(row.getByLabel('Value of manual')).toHaveValue('first');
    await expect(row.locator('.cookie-expiry')).toContainText('Session');
    await openCollections(window);
    expect(await send(window, '/echo')).toBe('manual=first');

    await openCookies(window);
    await row.getByLabel('Value of manual').fill('second');
    await row.getByLabel('Value of manual').press('Enter');
    await openCollections(window);
    expect(await send(window, '/echo')).toContain('manual=second');
  });

  test('the add form needs a domain and name, and Cancel closes it', async ({ window }) => {
    await openCookies(window);
    await window.locator('[data-cookie-add]').click();
    await expect(window.locator('[data-cookie-add]')).toBeDisabled();
    const form = window.locator('#cookie-add-form');
    await form.getByRole('button', { name: 'Add cookie' }).click();
    // The browser's required check keeps the form open and the jar empty.
    await expect(form).toBeVisible();
    await expect(window.getByText('The cookie jar is empty')).toBeVisible();
    await window.locator('[data-cookie-add-cancel]').click();
    await expect(form).toHaveCount(0);
    await expect(window.locator('[data-cookie-add]')).toBeEnabled();
  });

  test('the filter and domain buttons narrow the jar', async ({ window }) => {
    await openCookies(window);
    await addCookie(window, 'api.example.com', 'alpha', '1');
    await addCookie(window, 'api.example.com', 'beta', '2');
    await addCookie(window, 'shop.example.org', 'cart', '3');
    await expect(window.locator('[data-cookie-domain-filter=""] .history-count')).toHaveText('3');
    await expect(
      window.locator('[data-cookie-domain-filter="api.example.com"] .history-count'),
    ).toHaveText('2');

    await window.locator('[data-cookie-domain-filter="shop.example.org"]').click();
    await expect(window.locator('[data-cookie-row]')).toHaveCount(1);
    await expect(jarFor(window, 'api.example.com')).toHaveCount(0);
    await window.locator('[data-cookie-domain-filter=""]').click();

    await window.getByRole('searchbox', { name: 'Filter cookies' }).fill('beta');
    await expect(window.locator('[data-cookie-row]')).toHaveCount(1);
    await expect(window.locator('[data-cookie-row]')).toContainText('beta');
    await window.getByRole('searchbox', { name: 'Filter cookies' }).fill('nothing-like-this');
    await expect(window.getByText('No cookies match this filter')).toBeVisible();
  });

  test('deleting a cookie, a domain, or the whole jar', async ({ window }) => {
    await openCookies(window);
    await addCookie(window, 'api.example.com', 'alpha', '1');
    await addCookie(window, 'api.example.com', 'beta', '2');
    await addCookie(window, 'shop.example.org', 'cart', '3');
    await addCookie(window, 'shop.example.org', 'wishlist', '4');
    const dialog = window.locator('[data-confirm-dialog]');

    await window.getByRole('button', { name: 'Delete cookie alpha' }).click();
    await expect(window.locator('[data-cookie-row]')).toHaveCount(3);

    await window.locator('[data-cookie-clear-domain="shop.example.org"]').click();
    await expect(dialog).toContainText('Delete 2 cookies for shop.example.org?');
    await dialog.locator('[data-confirm-cancel]').click();
    await expect(window.locator('[data-cookie-row]')).toHaveCount(3);
    await window.locator('[data-cookie-clear-domain="shop.example.org"]').click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(jarFor(window, 'shop.example.org')).toHaveCount(0);
    await expect(window.locator('[data-cookie-row]')).toHaveCount(1);

    // The value is a text field with its own menu, so open the row's menu from its name.
    await window.locator('[data-cookie-row] th').click({ button: 'right' });
    await window.locator('[data-cookie-menu] [data-menu-item=delete]').click();
    await expect(window.getByText('The cookie jar is empty')).toBeVisible();

    await addCookie(window, 'api.example.com', 'gamma', '5');
    await window.locator('[data-cookie-clear-all]').click();
    await expect(dialog).toContainText('Delete all 1 cookie?');
    await dialog.locator('[data-confirm-accept]').click();
    await expect(window.getByText('The cookie jar is empty')).toBeVisible();
  });

  test('the jar is kept when the app is closed and opened again', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await send(window, '/cookies/set');
      await openCookies(window);
      await expect(jarFor(window, host()).locator('[data-cookie-row]')).toHaveCount(3);
      await window.keyboard.press('ControlOrMeta+S');
      await expect(window.locator('#save-status')).toHaveText(/Saved/);
      await first.close();

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await openCookies(reopened);
      await expect(jarFor(reopened, host()).locator('[data-cookie-row]')).toHaveCount(3);
      await openCollections(reopened);
      expect(await send(reopened, '/users')).toContain('theme=dark');
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
