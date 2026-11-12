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

const panel = (window: Page) => window.locator('#request-panel');
const openTab = (window: Page, name: string) =>
  window.locator(`[data-request-tab="${name}"]`).click();
/**
 * Chooses `value` in one of the app's dropdowns, found by the id or data attribute of the native
 * select it keeps for forms and assistive tools.
 */
async function choose(window: Page, select: string, value: string) {
  await window
    .locator('.ui-select', { has: window.locator(select) })
    .getByRole('combobox')
    .click();
  await window.locator(`[role=option][data-value="${value}"]`).click();
}

/**
 * Types into a Params or Headers cell. Those cells show their text as a button until edited, as a
 * spreadsheet does: a double-click opens the field.
 */
async function editCell(window: Page, row: number, field: 'key' | 'value', text: string) {
  await panel(window)
    .getByRole('button', { name: `Edit row ${row} ${field}`, exact: true })
    .dblclick();
  const input = panel(window).getByLabel(`Row ${row} ${field}`, { exact: true });
  await input.fill(text);
  await input.press('Enter');
}
/** Sends the open request and waits for its status. */
async function send(window: Page, status = '200') {
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText(status);
  return api.received.at(-1)!;
}
/** Opens a request of the new workspace's sample collection from the explorer. */
const openRequest = (window: Page, name: string) =>
  window.locator('.request-item', { hasText: name }).first().click();
/** Replaces the text of the request body editor, as typing over a selection would. */
async function setBody(window: Page, text: string) {
  await window.locator('#request-source-editor .cm-content').click();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(text);
}

test.describe('editing a request', () => {
  test('a parameter typed in the table is added to the URL and sent', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Params');
    await editCell(window, 1, 'key', 'search');
    await editCell(window, 1, 'value', 'a & b');
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users?search=a+%26+b`);
    const received = await send(window);
    expect(received.url).toBe('/users?search=a+%26+b');
  });

  test('unticking a parameter leaves it out of the URL and the request', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Params');
    await editCell(window, 1, 'key', 'page');
    await editCell(window, 1, 'value', '2');
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users?page=2`);
    await panel(window).getByLabel('Enable row 1', { exact: true }).uncheck();
    await expect(window.locator('#url')).toHaveValue(`${api.url}/users`);
    expect((await send(window)).url).toBe('/users');
  });

  test('a header added in the Headers tab is sent', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Headers');
    await editCell(window, 1, 'key', 'X-Trace');
    await editCell(window, 1, 'value', 'e2e-42');
    const received = await send(window);
    expect(received.headers['x-trace']).toBe('e2e-42');
  });

  test('bulk edit replaces the headers with the lines typed', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Headers');
    await window.locator('[data-action=bulk-open]').click();
    await window.locator('#bulk-rows').fill('X-One: 1\n// X-Off: no\nX-Two: 2');
    await window.locator('[data-action=bulk-apply]').click();
    const received = await send(window);
    expect(received.headers).toMatchObject({ 'x-one': '1', 'x-two': '2' });
    expect(received.headers['x-off']).toBeUndefined();
  });

  test('the method chosen is the one sent', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/items/1`);
    await choose(window, '#request-protocol', 'http:DELETE');
    expect((await send(window)).method).toBe('DELETE');
  });

  test('a JSON body is sent with its content type', async ({ window }) => {
    // The sample's Create a user is a POST with a JSON body.
    await openRequest(window, 'Create a user');
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Body');
    await expect(window.locator('[data-body-type=raw]')).toHaveAttribute('aria-pressed', 'true');
    await setBody(window, '{"name":"Grace"}');
    const received = await send(window);
    expect(received.method).toBe('POST');
    expect(received.headers['content-type']).toContain('application/json');
    expect(JSON.parse(received.body)).toEqual({ name: 'Grace' });
  });

  test('form fields are sent URL encoded', async ({ window }) => {
    await openRequest(window, 'Create a user');
    await window.locator('#url').fill(`${api.url}/form`);
    await openTab(window, 'Body');
    await window.locator('[data-body-type=x-www-form-urlencoded]').click();
    await panel(window).getByLabel('Row 1 key', { exact: true }).fill('name');
    await panel(window).getByLabel('Row 1 value', { exact: true }).fill('Ada Lovelace');
    await panel(window).getByLabel('Row 2 key', { exact: true }).fill('lang');
    await panel(window).getByLabel('Row 2 value', { exact: true }).fill('en&fr');
    const received = await send(window);
    expect(received.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(received.body).toBe('name=Ada+Lovelace&lang=en%26fr');
  });

  test('a Bearer token is sent in the Authorization header', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Auth');
    await choose(window, '#auth', 'Bearer token');
    await panel(window).locator('[data-auth=token]').fill('e2e-token');
    expect((await send(window)).headers.authorization).toBe('Bearer e2e-token');
  });

  test('an API key can be sent as a query parameter', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Auth');
    await choose(window, '#auth', 'API key');
    await panel(window).locator('[data-auth=username]').fill('api_key');
    await panel(window).locator('[data-auth=token]').fill('k-123');
    await choose(window, '[data-auth-option=apiKeyIn]', 'query');
    const received = await send(window);
    expect(received.url).toBe('/users?api_key=k-123');
    expect(received.headers.api_key).toBeUndefined();
  });

  test('an unknown variable is named before sending', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users/{{user_id}}`);
    await expect(window.locator('#composer-variables')).toContainText('1 unresolved');
    await expect(window.locator('#composer-variables')).toContainText('{{user_id}}');
    await window.locator('#url').fill(`${api.url}/users`);
    await expect(window.locator('#composer-variables')).toContainText('All variables resolved');
  });

  test('Cancel stops a request that is still waiting', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/slow`);
    const button = window.locator('[data-action=send]');
    await button.click();
    await expect(button).toHaveText(/Cancel/);
    await button.click();
    await expect(button).toHaveText(/Send/);
    await expect(window.locator('#response-panel')).not.toContainText('slow');
  });

  test('the request name is edited in place and shown in the explorer', async ({ window }) => {
    // The name is saved when the field loses focus.
    const name = window.locator('#request-name');
    await name.fill('List every user');
    await name.blur();
    await expect(window.locator('.request-item.active')).toContainText('List every user');
  });
});

test.describe('generated code', () => {
  test('shows the request as curl, and follows the chosen language', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users?page=2`);
    await window.locator('[data-action=code]').click();
    const code = window.locator('#codegen-preview');
    await expect(code).toContainText('curl');
    await expect(code).toContainText(`${api.url}/users?page=2`);
    await window
      .locator('.ui-select', { has: window.locator('#code-language') })
      .getByRole('combobox')
      .click();
    await window
      .getByRole('option', { name: /Python/ })
      .first()
      .click();
    await expect(code).toContainText('import');
    await expect(code).not.toContainText('curl');
    await expect(code).toContainText('/users?page=2');
    await window.locator('[data-code-close]').click();
    await expect(code).toBeHidden();
  });

  test('leaves a Bearer token out while redacting', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await openTab(window, 'Auth');
    await choose(window, '#auth', 'Bearer token');
    await panel(window).locator('[data-auth=token]').fill('very-secret-token');
    await window.locator('[data-action=code]').click();
    const code = window.locator('#codegen-preview');
    await expect(code).toContainText('Authorization');
    await expect(window.locator('#code-redact')).toBeChecked();
    await expect(code).not.toContainText('very-secret-token');
  });
});
