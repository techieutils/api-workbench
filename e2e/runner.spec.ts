import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { dataFolder, downloadTo, expect, test } from './fixtures';
import { startServer, type TestServer } from './server';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

/**
 * Points the new workspace's environment at the test API, so its "Getting started" collection
 * (five requests, each testing for status 200 and a quick response) calls it.
 */
async function useTestApi(window: Page): Promise<void> {
  await window.locator('.rail [data-view="Environments"]').click();
  const value = window.locator('.environment-editor').getByLabel('Row 1 value');
  await value.fill(api.url);
  await value.press('Tab');
}
const openRunner = (window: Page) => window.locator('.rail [data-view="Runner"]').click();
const verdict = (window: Page) => window.locator('[data-runner-verdict]');
const metric = (window: Page, key: string) => window.locator(`[data-runner-metric=${key}] strong`);
const sent = (since: number) =>
  api.received.slice(since).map((item) => `${item.method} ${item.url}`);

test.describe('the Runner', () => {
  test('runs a collection in order and reports it passed', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    const before = api.received.length;
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual([
      'GET /users',
      'GET /users/1',
      'POST /users',
      'PATCH /users/1',
      'DELETE /users/1',
    ]);
    await expect(metric(window, 'completed')).toHaveText('5');
    await expect(metric(window, 'assertions')).toHaveText('10/10');
    await window.locator('[data-runner-result-tab=Requests]').click();
    await expect(window.locator('[data-runner-endpoint]')).toHaveCount(5);
  });

  test('a request that fails its tests fails the run, and shows in Errors', async ({ window }) => {
    await useTestApi(window);
    // The open request is the collection's first; send it somewhere that answers 404.
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('#url').fill('{{base_url}}/missing');
    await openRunner(window);
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run failed');
    await expect(metric(window, 'assertions')).toHaveText('9/10');
    await window.locator('[data-runner-result-tab=Errors]').click();
    await expect(window.locator('[data-runner-error-row]').first()).toContainText('404');
  });

  test('runs only the chosen requests, as many times as asked', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    const requests = window.locator('[data-runner-request]');
    await expect(requests).toHaveCount(5);
    for (const index of [1, 2, 3]) await requests.nth(index).uncheck();
    const iterations = window.locator('[data-runner-field=iterations]');
    await iterations.fill('3');
    await iterations.press('Tab');
    const before = api.received.length;
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run passed');
    const calls = sent(before);
    expect(calls).toHaveLength(6);
    expect(new Set(calls)).toEqual(new Set(['GET /users', 'DELETE /users/1']));
  });

  test('a data file runs once per row, with each row’s values', async ({ window }) => {
    await useTestApi(window);
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('#url').fill('{{base_url}}/users/{{user_id}}?name={{name}}');
    await openRunner(window);
    const requests = window.locator('[data-runner-request]');
    for (const index of [1, 2, 3, 4]) await requests.nth(index).uncheck();
    await window.locator('[data-runner-data-input]').setInputFiles({
      name: 'users.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('user_id,name\n7,Ada\n8,Grace\n'),
    });
    await expect(window.locator('[data-runner-data-file]')).toContainText('users.csv');
    const before = api.received.length;
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual(['GET /users/7?name=Ada', 'GET /users/8?name=Grace']);
  });

  test('an API benchmark measures each request, after warming up', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await window.locator('[data-runner-mode="API benchmark"]').click();
    const requests = window.locator('[data-runner-request]');
    for (const index of [1, 2, 3, 4]) await requests.nth(index).uncheck();
    const iterations = window.locator('[data-runner-field=iterations]');
    await iterations.fill('10');
    await iterations.press('Tab');
    const before = api.received.length;
    await window.getByRole('button', { name: 'Start benchmark' }).click();
    await expect(verdict(window)).toContainText('Run passed', { timeout: 30_000 });
    // Ten measured requests, after two warm-ups that are not counted.
    await expect(metric(window, 'completed')).toHaveText('10');
    expect(sent(before)).toHaveLength(12);
    await expect(metric(window, 'p95')).toHaveText(/\d+(\.\d+)? ms/);
  });

  test('runs only the requests with a tag', async ({ window }) => {
    await useTestApi(window);
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('[data-action=add-tag]').first().click();
    await window.locator('[data-tag-input]').fill('smoke');
    await window.locator('[data-tag-input]').press('Enter');
    await openRunner(window);
    await window.locator('[data-runner-tags] [data-runner-tag=smoke]').click();
    await expect(window.locator('[data-runner-plan]')).toContainText('1 of 5');
    const before = api.received.length;
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual(['GET /users']);
  });

  test('stops at the first failure when asked', async ({ window }) => {
    await useTestApi(window);
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('#url').fill('{{base_url}}/missing');
    await openRunner(window);
    await window.locator('#runner-stop-on-failure').check();
    const before = api.received.length;
    await window.getByRole('button', { name: 'Run collection' }).click();
    await expect(verdict(window)).toContainText('Run failed');
    expect(sent(before)).toEqual(['GET /missing']);
  });
});

test.describe('Runner settings and reports', () => {
  /** Picks `option` in the UiSelect whose native select has `id`. */
  async function pick(window: Page, id: string, option: string) {
    await window.locator(`.ui-select:has(select#${id}) .ui-select-trigger`).click();
    await window.getByRole('option', { name: new RegExp(`^${option}`) }).click();
  }
  async function setField(window: Page, key: string, value: string) {
    const field = window.locator(`[data-runner-field=${key}]`);
    await field.fill(value);
    await field.press('Tab');
  }
  /** Leaves only the first of the five requests ticked. */
  async function onlyFirst(window: Page) {
    const requests = window.locator('[data-runner-request]');
    for (const index of [1, 2, 3, 4]) await requests.nth(index).uncheck();
  }
  const run = (window: Page) => window.getByRole('button', { name: 'Run collection' }).click();

  test('the run uses the environment chosen for it', async ({ window }) => {
    await useTestApi(window);
    // Production points somewhere else; choosing it in the Runner sends the run there.
    await window.locator('[data-env-select="1"]').click();
    const value = window.locator('.environment-editor').getByLabel('Row 1 value');
    await value.fill(`${api.url}/production`);
    await value.press('Tab');
    await window.locator('[data-env-select="0"]').click();
    await openRunner(window);
    await onlyFirst(window);
    await pick(window, 'runner-environment', 'Production');
    await expect(window.locator('[data-runner-plan-fact=environment]')).toContainText('Production');
    const before = api.received.length;
    await run(window);
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual(['GET /production/users']);
  });

  test('another collection can be run', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await pick(window, 'runner-folder', 'Posts');
    await expect(window.locator('[data-runner-request]')).toHaveCount(1);
    const before = api.received.length;
    await run(window);
    await expect(verdict(window)).toContainText(/Run (passed|failed)/);
    expect(sent(before)).toEqual(['GET /posts']);
  });

  test('a delay spaces the requests out', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await onlyFirst(window);
    await setField(window, 'iterations', '3');
    await setField(window, 'delayMs', '300');
    const started = Date.now();
    await run(window);
    await expect(verdict(window)).toContainText('Run passed');
    // Three requests with a pause between them take at least two pauses.
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  test('Stop run cancels what is left', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await setField(window, 'iterations', '20');
    await setField(window, 'delayMs', '500');
    const before = api.received.length;
    await run(window);
    await expect(window.locator('[data-runner-progress]')).toBeVisible();
    await window.locator('[data-runner-stop]').click();
    await expect(verdict(window)).toContainText('Run cancelled');
    await expect(window.getByRole('button', { name: 'Run collection' })).toBeEnabled();
    const count = api.received.length - before;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
    // Nothing more is sent once it has stopped.
    await window.waitForTimeout(800);
    expect(api.received.length - before).toBe(count);
  });

  test('the report exports as JSON and CSV', async ({ app, window }) => {
    const folder = await dataFolder();
    try {
      await useTestApi(window);
      await openRunner(window);
      await run(window);
      await expect(verdict(window)).toContainText('Run passed');
      const json = JSON.parse(
        await downloadTo(app, path.join(folder, 'report.json'), () =>
          window.locator('[data-runner-export=json]').click(),
        ),
      );
      expect(json.mode).toBe('collection');
      expect(json.outcome).toBe('passed');
      expect(json.metrics.completed).toBe(5);
      const csv = await downloadTo(app, path.join(folder, 'report.csv'), () =>
        window.locator('[data-runner-export=csv]').click(),
      );
      const lines = csv.trim().split('\n');
      // A header, then one line per request sent, named as in the collection.
      expect(lines).toHaveLength(6);
      expect(lines[0]).toContain('"request"');
      expect(csv).toContain('Get all users');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test('a benchmark fails when its pass criteria are missed', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await window.locator('[data-runner-mode="API benchmark"]').click();
    await onlyFirst(window);
    await setField(window, 'iterations', '3');
    await window.locator('summary', { hasText: 'Success criteria and thresholds' }).click();
    // 200 is the answer, so a range starting at 201 counts every response as an error.
    await setField(window, 'successMin', '201');
    await window.getByRole('button', { name: 'Start benchmark' }).click();
    await expect(verdict(window)).toContainText('Run failed', { timeout: 30_000 });
    await expect(verdict(window).getByRole('list', { name: 'Criteria missed' })).toBeVisible();
    await expect(metric(window, 'errors')).toHaveText('100%');
  });

  test('a performance test runs for its duration with several workers', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    await window.locator('[data-runner-mode="Performance test"]').click();
    await onlyFirst(window);
    await setField(window, 'durationSeconds', '2');
    await setField(window, 'concurrency', '2');
    await setField(window, 'warmupIterations', '0');
    const started = Date.now();
    await window.getByRole('button', { name: /^Start/ }).click();
    await expect(verdict(window)).toContainText(/Run (passed|failed)/, { timeout: 30_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    await expect(metric(window, 'throughput')).toHaveText(/\d+(\.\d+)? req\/s/);
    expect(
      Number((await metric(window, 'completed').innerText()).replace(/,/g, '')),
    ).toBeGreaterThan(2);
  });

  test('a request’s menu runs it alone', async ({ window }) => {
    await useTestApi(window);
    await openRunner(window);
    const requests = window.locator('[data-runner-request]');
    await requests.nth(2).click({ button: 'right' });
    await window.locator('[data-runner-request-menu] [data-menu-item=only]').click();
    await expect(window.locator('[data-runner-plan]')).toContainText('1 of 5');
    const before = api.received.length;
    await run(window);
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual(['POST /users']);
  });

  test('a JSON data file runs its rows; an unreadable one is explained', async ({ window }) => {
    await useTestApi(window);
    await window.locator('.rail [data-view="Collections"]').click();
    await window.locator('#url').fill('{{base_url}}/users/{{id}}');
    await openRunner(window);
    await onlyFirst(window);
    const input = window.locator('[data-runner-data-input]');
    await input.setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not json'),
    });
    await expect(window.locator('[data-runner-data-error]')).toBeVisible();

    await input.setInputFiles({
      name: 'ids.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{ id: 11 }, { id: 12 }, { id: 13 }])),
    });
    await expect(window.locator('[data-runner-data-error]')).toHaveCount(0);
    await expect(window.locator('[data-runner-data-column=id]')).toBeVisible();
    const before = api.received.length;
    await run(window);
    await expect(verdict(window)).toContainText('Run passed');
    expect(sent(before)).toEqual(['GET /users/11', 'GET /users/12', 'GET /users/13']);
    await window.locator('[data-runner-result-tab="Data rows"]').click();
    await expect(window.locator('[data-runner-iteration]')).toHaveCount(3);

    await window.locator('[data-runner-data-remove]').click();
    await expect(window.locator('[data-runner-data-file]')).toHaveCount(0);
    await expect(window.locator('[data-runner-field=iterations]')).toBeEnabled();
  });
});
