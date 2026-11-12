import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';
import { freePort } from './server';

/** Opens Mocks and creates a mock server on a free port, as a person would. */
async function newMock(window: Page): Promise<string> {
  await window.locator('.rail [data-view="Mocks"]').click();
  await window.locator('[data-mock-new]').first().click();
  const port = await freePort();
  const field = window.locator('#mock-port');
  await field.fill(String(port));
  await field.press('Tab');
  return `http://127.0.0.1:${port}`;
}
/** Starts the open mock and waits until it answers. */
async function start(window: Page, base: string): Promise<void> {
  await window.locator('[data-mock-start]').click();
  await expect(window.locator('[data-mock-stop]')).toBeVisible();
  await expect
    .poll(() =>
      fetch(`${base}/health`).then(
        (r) => r.status,
        () => 0,
      ),
    )
    .not.toBe(0);
}
/** Replaces the response body in its editor. */
async function setBody(window: Page, text: string): Promise<void> {
  // CodeMirror labels its editable area itself.
  const editor = window.getByRole('textbox', { name: 'Response body' });
  await editor.click();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(text);
}

test.describe('mock servers', () => {
  test('a new mock answers its starter route, and stops answering when stopped', async ({
    window,
  }) => {
    const base = await newMock(window);
    await expect(window.locator('#mock-route-path')).toHaveValue('/health');
    await start(window, base);
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    // A path with no route is a 404.
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
    await window.locator('[data-mock-stop]').click();
    await expect(window.locator('[data-mock-start]')).toBeVisible();
    await expect
      .poll(() =>
        fetch(`${base}/health`).then(
          () => 'answered',
          () => 'refused',
        ),
      )
      .toBe('refused');
  });

  test('a route’s path, status, and templated body are what it serves', async ({ window }) => {
    const base = await newMock(window);
    const path = window.locator('#mock-route-path');
    await path.fill('/users/:id');
    await path.press('Tab');
    const status = window.locator('#mock-route-status');
    await status.fill('201');
    await status.press('Tab');
    await setBody(window, '{"id": "{{params.id}}", "page": "{{query.page}}"}');
    await start(window, base);
    const response = await fetch(`${base}/users/42?page=3`);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: '42', page: '3' });
  });

  test('request rules decide which requests a route answers', async ({ window }) => {
    const base = await newMock(window);
    await window.getByLabel('Rule 1 name').fill('plan');
    await window.getByLabel('Rule 1 value').fill('pro');
    await window.getByLabel('Rule 1 value').press('Tab');
    await start(window, base);
    expect((await fetch(`${base}/health?plan=pro`)).status).toBe(200);
    expect((await fetch(`${base}/health?plan=free`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(404);
  });

  test('the Log lists each request it received', async ({ window }) => {
    const base = await newMock(window);
    await start(window, base);
    await fetch(`${base}/health?from=e2e`);
    await fetch(`${base}/missing`);
    await window.locator('[data-mock-tab=Log]').click();
    const rows = window.locator('[data-mock-log-row]');
    await expect(rows.filter({ hasText: '/health' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: '/missing' }).first()).toContainText('404');
  });

  test('a request in the app can call the mock', async ({ window }) => {
    const base = await newMock(window);
    await setBody(window, '{"status": "up"}');
    await start(window, base);
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('#url').fill(`${base}/health`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200 OK');
    await expect(window.locator('#response-panel')).toContainText('up');
  });

  test('a mock made from a collection has a route for each request', async ({ window }) => {
    await window.locator('.rail [data-view="Mocks"]').click();
    await window
      .getByRole('combobox', { name: 'Create a mock server from a collection' })
      .first()
      .click();
    await window.getByRole('option', { name: 'Getting started' }).click();
    // The collection's five requests: list, get, create, update, and delete a user.
    await expect(window.locator('[data-mock-route]')).toHaveCount(5);
    const port = await freePort();
    const field = window.locator('#mock-port');
    await field.fill(String(port));
    await field.press('Tab');
    const base = `http://127.0.0.1:${port}`;
    await window.locator('[data-mock-start]').click();
    await expect
      .poll(() =>
        fetch(`${base}/users`).then(
          (r) => r.status,
          () => 0,
        ),
      )
      .toBe(200);
    expect((await fetch(`${base}/users/1`, { method: 'DELETE' })).status).toBeLessThan(400);
    expect((await fetch(`${base}/users`, { method: 'PUT' })).status).toBe(404);
  });
});

test('a mock server and its routes are kept when the app is opened again', async () => {
  const data = await dataFolder();
  const errors: string[] = [];
  try {
    const first = await launchApp(data, errors);
    const window = await mainWindow(first, errors);
    await newMock(window);
    const name = window.locator('#mock-name');
    await name.fill('Billing API');
    await name.press('Tab');
    const path = window.locator('#mock-route-path');
    await path.fill('/invoices');
    await path.press('Tab');
    await window.keyboard.press('ControlOrMeta+S');
    await expect(window.locator('#save-status')).toHaveText(/Saved/);
    await first.close();

    const second = await launchApp(data, errors);
    const reopened = await mainWindow(second, errors);
    await reopened.locator('.rail [data-view="Mocks"]').click();
    await expect(reopened.locator('[data-mock-select]')).toContainText('Billing API');
    await expect(reopened.locator('#mock-route-path')).toHaveValue('/invoices');
    await second.close();
    expect(errors).toEqual([]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test.describe('mock routes and settings', () => {
  /** Sets the open route's method. */
  async function setMethod(window: Page, method: string) {
    await window.getByRole('combobox', { name: 'Route method or protocol' }).click();
    await window.getByRole('option', { name: new RegExp(`^${method}\\b`) }).click();
  }
  async function setField(window: Page, selector: string, value: string) {
    const field = window.locator(selector);
    await field.fill(value);
    await field.press('Tab');
  }
  const routes = (window: Page) => window.locator('[data-mock-route]');

  test('routes are told apart by method, and the most specific path wins', async ({ window }) => {
    const base = await newMock(window);
    await setField(window, '#mock-route-path', '/users/:id');
    await setBody(window, '{"route": "any user"}');
    await window.locator('[data-mock-add-route]').click();
    await expect(routes(window)).toHaveCount(2);
    await setField(window, '#mock-route-path', '/users/me');
    await setBody(window, '{"route": "me"}');
    await window.locator('[data-mock-add-route]').click();
    await setMethod(window, 'DELETE');
    await setField(window, '#mock-route-path', '/users/:id');
    await setField(window, '#mock-route-status', '204');
    await start(window, `${base}`);

    expect(await (await fetch(`${base}/users/7`)).json()).toEqual({ route: 'any user' });
    // Fixed segments beat parameters, whatever the order of the routes.
    expect(await (await fetch(`${base}/users/me`)).json()).toEqual({ route: 'me' });
    expect((await fetch(`${base}/users/7`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/users/7`, { method: 'PUT' })).status).toBe(404);
  });

  test('a route sends its headers, after its delay', async ({ window }) => {
    const base = await newMock(window);
    // Header cells are labels until edited: double-click one to type in it.
    const respond = window.locator('[data-mock-section=respond]');
    await respond.getByRole('button', { name: 'Edit row 1 key' }).first().dblclick();
    await respond.getByRole('combobox', { name: 'Row 1 key' }).first().fill('X-Request-Id');
    await window.keyboard.press('Escape');
    await respond.getByRole('button', { name: 'Edit row 1 value' }).first().dblclick();
    await respond.getByRole('combobox', { name: 'Row 1 value' }).first().fill('mock-123');
    await window.keyboard.press('Escape');
    await setField(window, '#mock-route-delay', '400');
    await start(window, base);
    const started = Date.now();
    const response = await fetch(`${base}/health`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    expect(response.headers.get('x-request-id')).toBe('mock-123');
  });

  test('another response answers the requests its rules match', async ({ window }) => {
    const base = await newMock(window);
    await setBody(window, '{"plan": "default"}');
    await window.locator('[data-mock-add-response]').click();
    await expect(window.locator('#mock-response-name')).toBeFocused();
    await window.locator('#mock-response-name').fill('Over quota');
    await window.locator('#mock-response-name').press('Tab');
    const respond = window.locator('[data-mock-section=respond]');
    await respond.getByLabel('Rule 1 name').fill('quota');
    await respond.getByLabel('Rule 1 value').fill('over');
    await respond.getByLabel('Rule 1 value').press('Tab');
    await setField(window, '#mock-route-status', '429');
    await setBody(window, '{"error": "Too many requests"}');
    await expect(window.locator('[data-mock-response="0"]')).toContainText('Over quota');
    await start(window, base);

    const limited = await fetch(`${base}/health?quota=over`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
    const normal = await fetch(`${base}/health`);
    expect(normal.status).toBe(200);
    expect(await normal.json()).toEqual({ plan: 'default' });
  });

  test('CORS is on for a new mock, and off answers no browser preflight', async ({ window }) => {
    const base = await newMock(window);
    await start(window, base);
    const preflight = () =>
      fetch(`${base}/health`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://app.example.test',
          'access-control-request-method': 'GET',
        },
      });
    const answered = await preflight();
    expect(answered.status).toBeLessThan(300);
    expect(answered.headers.get('access-control-allow-origin')).toBe('*');

    await window.locator('[data-mock-setting=cors]').click();
    await expect(window.locator('[data-mock-cors]')).toBeChecked();
    await window.locator('[data-mock-cors]').uncheck();
    await expect
      .poll(async () => (await preflight()).headers.get('access-control-allow-origin'))
      .toBeNull();
    const plain = await fetch(`${base}/health`, { headers: { origin: 'http://app.example.test' } });
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('routes can be switched off, duplicated, filtered, and deleted', async ({ window }) => {
    const base = await newMock(window);
    await start(window, base);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await window.locator('#mock-route-enabled').uncheck();
    await expect.poll(async () => (await fetch(`${base}/health`)).status).toBe(404);
    await window.locator('#mock-route-enabled').check();

    await window.locator('[data-mock-route-duplicate]').click();
    await expect(routes(window)).toHaveCount(2);
    await setField(window, '#mock-route-path', '/status');
    await expect.poll(async () => (await fetch(`${base}/status`)).status).toBe(200);

    await window.locator('[data-mock-route-search]').fill('status');
    await expect(routes(window)).toHaveCount(1);
    await window.locator('[data-mock-route-search]').fill('nothing-like-this');
    await expect(window.getByText('No routes match “nothing-like-this”.')).toBeVisible();
    await window.locator('[data-mock-route-search]').fill('');

    await window.locator('[data-mock-route-delete]').click();
    await expect(routes(window)).toHaveCount(1);
    await expect.poll(async () => (await fetch(`${base}/status`)).status).toBe(404);
  });

  test('a logged request shows what was received, and as curl', async ({ window }) => {
    const base = await newMock(window);
    await start(window, base);
    await fetch(`${base}/health?from=log`, { headers: { 'x-trace': 'log-detail' } });
    await window.locator('[data-mock-tab=Log]').click();
    await window.locator('[data-mock-log-row]').filter({ hasText: '/health' }).first().click();
    const detail = window.locator('[data-mock-log-detail]');
    await expect(detail).toContainText('x-trace');
    await expect(detail).toContainText('log-detail');
    await expect(detail.locator('[data-mock-log-curl]')).toBeVisible();

    await fetch(`${base}/missing`);
    await window.locator('[data-mock-log-filter="No match"]').click();
    await expect(window.locator('[data-mock-log-row]').first()).toContainText('/missing');
  });

  test('the API docs describe the routes as OpenAPI', async ({ window }) => {
    await newMock(window);
    await setField(window, '#mock-route-path', '/orders/:id');
    await window.locator('[data-mock-tab="API docs"]').click();
    await expect(window.locator('[data-mock-docs-operation]').first()).toContainText(
      '/orders/{id}',
    );
    await window.locator('[data-mock-docs-format]').filter({ hasText: /YAML/ }).first().click();
    await expect(window.locator('#mock-docs-source')).toContainText('openapi');
    await expect(window.locator('#mock-docs-source')).toContainText('/orders/{id}');
  });

  test('deleting a mock server asks first, and stops it', async ({ window }) => {
    const base = await newMock(window);
    await start(window, base);
    await window.locator('[data-mock-more]').click();
    await window.getByRole('menuitem', { name: /^Delete/ }).click();
    const dialog = window.locator('[data-confirm-dialog]');
    await dialog.locator('[data-confirm-cancel]').click();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await window.locator('[data-mock-more]').click();
    await window.getByRole('menuitem', { name: /^Delete/ }).click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(window.locator('[data-mock-select]')).toHaveCount(0);
    await expect
      .poll(() =>
        fetch(`${base}/health`).then(
          () => 'answered',
          () => 'refused',
        ),
      )
      .toBe('refused');
  });
});
