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

/** Opens the Scripts tab at a phase and types `source` as the request's script for it. */
async function writeScript(window: Page, phase: 'pre' | 'post', source: string) {
  await window.locator('[data-request-tab=Scripts]').click();
  await window.locator(`[data-script-phase=${phase}]`).click();
  await replaceText(window, source);
}
/**
 * Replaces the open script editor's text, as select-all, Delete, and typing would. Deleting first
 * matters: inserting over a selection of several lines at once lets Chrome add an inline style to
 * the merged line, which the app's policy blocks and logs.
 */
async function replaceText(window: Page, source: string) {
  await window.locator('.scripts-editor .cm-content').click();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.press('Backspace');
  await window.keyboard.insertText(source);
}
async function send(window: Page, path: string) {
  await window.locator('#url').fill(`${api.url}${path}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).toContainText('200');
  return api.received.at(-1)!;
}

test.describe('request scripts', () => {
  test('a request has a pre-request and a post-response script', async ({ window }) => {
    await window.locator('[data-request-tab=Scripts]').click();
    await expect(window.locator('[data-script-phase]')).toHaveCount(2);
  });

  test('a pre-request script sets a variable and a header before sending', async ({ window }) => {
    await writeScript(
      window,
      'pre',
      "aw.vars.set('user_id', '7');\naw.request.headers.set('X-Signed', 'yes');",
    );
    const received = await send(window, '/users/{{user_id}}');
    expect(received.url).toBe('/users/7');
    expect(received.headers['x-signed']).toBe('yes');
    await window.locator('[data-request-tab=Scripts]').click();
    await window.locator('[data-script-phase=pre]').click();
    await expect(window.locator('[data-scripts-run]')).toContainText('Set user_id');
  });

  test('tests in a post-response script show with the request’s tests', async ({ window }) => {
    await writeScript(
      window,
      'post',
      "aw.test('first user is Ada', () => aw.expect(aw.response.json().users[0].name).toBe('Ada'));\naw.test('has two users', () => aw.expect(aw.response.json().users.length).toBe(2));",
    );
    await send(window, '/users');
    await window.locator('[data-response-tab=Tests]').click();
    await expect(
      window.locator('.assertion-result.passed', { hasText: 'first user is Ada' }),
    ).toBeVisible();
    await expect(
      window.locator('.assertion-result.failed', { hasText: 'has two users' }),
    ).toBeVisible();
  });

  test('a post-response script saves a value for the next request', async ({ window }) => {
    await writeScript(
      window,
      'post',
      "aw.vars.set('first_name', aw.response.json().users[0].name);",
    );
    await send(window, '/users');
    await window.locator('.request-item', { hasText: 'Get a user' }).click();
    const received = await send(window, '/echo?name={{first_name}}');
    expect(received.url).toBe('/echo?name=Ada');
  });

  test('a script that throws is reported, and the request is not sent', async ({ window }) => {
    await writeScript(window, 'pre', "throw new Error('stop here');");
    const before = api.received.length;
    await window.locator('#url').fill(`${api.url}/users`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('#response-panel')).toContainText('stop here');
    expect(api.received.length).toBe(before);
  });

  test('a script cannot reach the network or files', async ({ window }) => {
    await writeScript(
      window,
      'pre',
      "aw.vars.set('kinds', [typeof fetch, typeof require, typeof process].join(','));",
    );
    const received = await send(window, '/echo?kinds={{kinds}}');
    expect(decodeURIComponent(received.url)).toBe('/echo?kinds=undefined,undefined,undefined');
  });
});

test.describe('suggestions in the script editor', () => {
  const list = (window: Page) => window.locator('.scripts-editor .cm-tooltip-autocomplete');
  const option = (window: Page, label: string) =>
    list(window).locator('li', { has: window.locator('.cm-completionLabel', { hasText: label }) });
  const editor = (window: Page) => window.locator('.scripts-editor .cm-content');
  /**
   * Presses a key in the open list. CodeMirror ignores keys for 75 ms after the list opens, so a
   * key pressed while it appears is not taken as a choice; a person is never that quick.
   */
  async function inList(window: Page, key: string) {
    await expect(list(window)).toBeVisible();
    await window.waitForTimeout(150);
    await window.keyboard.press(key);
  }
  /** Opens a phase's script, empty, ready for typing. */
  async function startScript(window: Page, phase: 'pre' | 'post') {
    await writeScript(window, phase, '');
    await editor(window).click();
  }

  test('the aw API is suggested while typing, with what each member does', async ({ window }) => {
    await startScript(window, 'pre');
    await window.keyboard.type('aw.req');
    await expect(option(window, 'request')).toBeVisible();
    await inList(window, 'Enter');
    await window.keyboard.type('.');
    await expect(option(window, 'headers')).toBeVisible();
    await expect(option(window, 'method')).toContainText('string');
    await window.keyboard.type('hea');
    await inList(window, 'Enter');
    await window.keyboard.type('.s');
    await expect(option(window, 'set')).toBeVisible();
    await expect(window.locator('.cm-completionInfo')).toContainText('Adds or replaces a header');
    // A function is inserted with its parentheses, ready for its arguments.
    await inList(window, 'Enter');
    await expect(editor(window)).toHaveText('aw.request.headers.set()');
    await window.keyboard.press('Escape');
  });

  test('a variable’s name is suggested in aw.vars.get', async ({ window }) => {
    await startScript(window, 'pre');
    await window.keyboard.type("aw.vars.get('ba");
    await expect(option(window, 'base_url')).toBeVisible();
    // Tab chooses, as Enter does.
    await inList(window, 'Tab');
    await expect(editor(window)).toHaveText("aw.vars.get('base_url')");
  });

  test('the keys of the last JSON response are suggested', async ({ window }) => {
    await send(window, '/users');
    await startScript(window, 'post');
    await window.keyboard.type('const body = aw.response.json();\nbody.');
    await expect(option(window, 'users')).toBeVisible();
    await inList(window, 'Enter');
    await window.keyboard.type('[0].');
    await expect(option(window, 'name')).toContainText('string');
    await expect(option(window, 'id')).toContainText('number');
  });

  test('a pre-request script ranks the response last, and says why', async ({ window }) => {
    await startScript(window, 'pre');
    await window.keyboard.type('aw.');
    await expect(list(window).locator('li').last()).toContainText('response');
    await window.keyboard.type('resp');
    await expect(window.locator('.cm-completionInfo')).toContainText(
      'Only in post-response scripts',
    );
  });

  test('nothing is suggested in a comment', async ({ window }) => {
    await startScript(window, 'pre');
    await window.keyboard.type('// aw.re');
    await expect(list(window)).toHaveCount(0);
  });
});

test.describe('syntax errors in the script editor', () => {
  const status = (window: Page) => window.locator('[data-scripts-syntax]');
  const underline = (window: Page) => window.locator('.scripts-editor .cm-lintRange-error');

  test('a syntax error is underlined and named, and goes once fixed', async ({ window }) => {
    await writeScript(window, 'pre', "aw.log('ready');\naw.vars.set('a', 1;");
    await expect(status(window)).toHaveText(/Syntax error on line 2: Unexpected token/);
    await expect(underline(window)).toHaveCount(1);
    await expect(window.locator('.scripts-editor .cm-lint-marker-error')).toHaveCount(1);
    // Hovering the underline says what is wrong.
    await underline(window).hover();
    await expect(window.locator('.cm-tooltip-lint')).toContainText('line 2, column 19');

    await replaceText(window, "aw.vars.set('a', 1);");
    await expect(status(window)).toBeEmpty();
    await expect(underline(window)).toHaveCount(0);
  });

  test('Go to line puts the cursor on the line with the error', async ({ window }) => {
    await writeScript(window, 'pre', 'const a = 1;\n\n\nconst a = 2;');
    await expect(status(window)).toContainText("line 4: Identifier 'a' has already been declared");
    // F8 selects the error from anywhere in the editor.
    await window.locator('.scripts-editor .cm-line').first().click();
    await window.keyboard.press('F8');
    await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe('a');
    await window.keyboard.press('Home');
    await window.locator('[data-action=go-to-syntax-error]').click();
    await expect(window.locator('.scripts-editor .cm-content')).toBeFocused();
    await window.keyboard.type('// ');
    await expect(window.locator('.scripts-editor .cm-line').nth(3)).toHaveText('// const a = 2;');
    await expect(status(window)).toBeEmpty();
  });

  test('the error belongs to the script shown, not the other phase', async ({ window }) => {
    await writeScript(window, 'pre', 'if (true) {');
    await expect(status(window)).toContainText('Unexpected token');
    await window.locator('[data-script-phase=post]').click();
    await expect(status(window)).toBeEmpty();
    await window.locator('[data-script-phase=pre]').click();
    await expect(status(window)).toContainText('Unexpected token');
  });

  test('a library module may return, as its own function', async ({ window }) => {
    await window.locator('[data-request-tab=Scripts]').click();
    await window.locator('[data-script-level=library]').click();
    await window.locator('[data-new-module]').fill('helpers');
    await window.locator('[data-new-module]').press('Enter');
    await replaceText(window, 'if (!aw) return;\nexports.double = (n) => n * 2;');
    // Give the check its time to run, then expect no error.
    await window.waitForTimeout(800);
    await expect(status(window)).toBeEmpty();
    await window.keyboard.insertText('\nexports.broken = (;');
    await expect(status(window)).toContainText('Syntax error on line 3');
  });
});
