import { expect, test } from './fixtures';

test.describe('the app shell', () => {
  test('opens on the request editor, titled', async ({ window }) => {
    await expect(window).toHaveTitle(/API Workbench/);
    await expect(window.locator('#url')).toBeVisible();
    await expect(window.locator('[data-action=send]')).toBeVisible();
  });

  // Mocks with no mock servers once threw while it looked for a gRPC schema to inspect.
  test('every screen opens from the rail, in a new workspace', async ({ window }) => {
    for (const view of [
      'Environments',
      'History',
      'Runner',
      'Cookies',
      'Mocks',
      'Settings',
      'Collections',
    ]) {
      await window.locator(`.rail [data-view="${view}"]`).click();
      await expect(window.locator(`.rail [data-view="${view}"]`)).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    await expect(window.locator('#url')).toBeVisible();
  });

  test('the command palette opens with its shortcut and runs a command', async ({ window }) => {
    await window.keyboard.press('ControlOrMeta+Shift+P');
    const input = window.locator('#command-palette-input');
    await expect(input).toBeFocused();
    await input.fill('open settings');
    await window.keyboard.press('Enter');
    await expect(window.locator('.rail [data-view="Settings"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(input).toBeHidden();
  });

  test('workspace search opens with its shortcut and finds a request', async ({ window }) => {
    await window.keyboard.press('ControlOrMeta+K');
    const search = window.locator('#global-workspace-search');
    await expect(search).toBeFocused();
    await search.fill('get a user');
    await window.keyboard.press('Enter');
    await expect(window.locator('#request-name')).toHaveText('Get a user');
  });

  test('a new request opens in a tab of its own', async ({ window }) => {
    const tabs = window.locator('[role=tab][data-request-id], .request-tab');
    const before = await tabs.count();
    await window.keyboard.press('ControlOrMeta+N');
    await expect(tabs).toHaveCount(before + 1);
    // A new request starts with the scheme typed for you.
    await expect(window.locator('#url')).toHaveValue('https://');
    await expect(window.locator('#url')).toBeFocused();
  });
});
