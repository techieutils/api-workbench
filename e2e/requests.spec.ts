import { expect, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

test.describe('sending requests', () => {
  test('Send calls the API and shows the response', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await window.locator('[data-action=send]').click();
    const meta = window.locator('.response-meta');
    await expect(meta).toContainText('200 OK');
    await expect(window.locator('#response-panel')).toContainText('Ada');
    expect(api.received.at(-1)).toMatchObject({ method: 'GET', url: '/users' });
  });

  test('the shortcut sends too, and an error status is shown as one', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/missing`);
    await window.keyboard.press('ControlOrMeta+Enter');
    await expect(window.locator('.response-meta')).toContainText('404 Not Found');
  });

  test('the request’s tests run on each response', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/users`);
    await window.locator('[data-action=send]').click();
    await expect(window.locator('.response-meta')).toContainText('200 OK');
    await window.locator('[data-response-tab=Tests]').click();
    // A new workspace's requests check for status 200 and a quick response.
    await expect(window.locator('.assertion-result.passed')).toHaveCount(2);
    await expect(window.locator('.assertion-result.failed')).toHaveCount(0);
  });

  test('tests written in the Tests tab decide the result', async ({ window }) => {
    await window.locator('#url').fill(`${api.url}/missing`);
    await window.locator('[data-request-tab=Tests]').click();
    await window.locator('[data-test-mode=Text]').click();
    await window
      .locator('#tests')
      .fill(
        'status 404\njson $.error equals "Not found"\ncookie-exists session\nheader content-type is-empty',
      );
    await window.locator('[data-action=send]').click();
    await window.locator('[data-response-tab=Tests]').click();
    await expect(window.locator('.assertion-result.passed')).toHaveCount(3);
    await expect(window.locator('.assertion-result.failed')).toHaveCount(1);
    await expect(window.locator('.assertion-result.failed')).toContainText(
      'header content-type is-empty',
    );
  });
});
