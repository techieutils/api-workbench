import { execFile } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { dataFolder, expect, launchApp, mainWindow, test } from './fixtures';
import { startServer, type TestServer } from './server';

/**
 * The test app has no system credential store (see scripts/e2e-main.ts), so credentials go to
 * the API Workbench vault, set up here with a made-up password. The values below are test
 * values only.
 */
const PASSWORD = 'Correct-Horse-Battery-9';
const SECRET = 'e2e-made-up-bearer-value';

let api: TestServer;
test.beforeAll(async () => {
  api = await startServer();
});
test.afterAll(async () => {
  await api.close();
});

const vaultState = (window: Page) => window.locator('[data-workbench-vault]');
/** Picks `option` in the UiSelect whose native select has `id`. */
async function pick(window: Page, id: string, option: string) {
  await window.locator(`.ui-select:has(select#${id}) .ui-select-trigger`).click();
  // An option's name includes its description line, so match how it starts.
  const start = new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  await window.getByRole('option', { name: start }).click();
}
const openCredentials = (window: Page) => window.locator('.rail [data-view="Credentials"]').click();
const openCollections = (window: Page) => window.locator('.rail [data-view="Collections"]').click();

/**
 * Sets up the vault through its form. The recovery key is saved to `recoveryFile`: the save
 * dialog is answered in the main process, as a person choosing that file would.
 */
async function setUpVault(app: ElectronApplication, window: Page, recoveryFile: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never;
  }, recoveryFile);
  await openCredentials(window);
  await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'setup');
  await window.locator('#workbench-vault-password').fill(PASSWORD);
  await window.locator('#workbench-vault-confirm').fill(PASSWORD);
  await window.locator('[data-workbench-vault-create]').click();
  await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'recovery');
  await window.locator('[data-workbench-vault-save-recovery]').click();
  await expect(window.getByText('Recovery key saved')).toBeVisible();
  await window.locator('[data-workbench-vault-acknowledge]').check();
  await window.locator('[data-workbench-vault-done]').click();
  await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'unlocked');
}
/** Adds a credential with the Add credential dialog. */
async function addCredential(
  window: Page,
  fields: { name: string; kind?: string; origin: string; secret: string; username?: string },
) {
  await window.locator('[data-action=new-credential]').first().click();
  const form = window.locator('#credential-form');
  if (fields.kind) await pick(window, 'credential-kind', fields.kind);
  await form.locator('[name=name]').fill(fields.name);
  await form.locator('[name=allowedOrigin]').fill(fields.origin);
  if (fields.username) await form.locator('[name=username]').fill(fields.username);
  await form.locator('[name=secret]').fill(fields.secret);
  await window.locator('#save-credential').click();
  await expect(form).toHaveCount(0);
  await expect(window.locator('[data-credential-row]', { hasText: fields.name })).toBeVisible();
}
/** Points the open request's Auth tab at the saved credential `name`. */
async function useCredential(window: Page, name: string) {
  await window.locator('[data-request-tab=Auth]').click();
  await pick(window, 'auth', 'Saved credential');
  await pick(window, 'request-credential', name);
}
async function send(window: Page, pathname: string) {
  const before = api.received.length;
  await window.locator('#url').fill(`${api.url}${pathname}`);
  await window.locator('[data-action=send]').click();
  await expect(window.locator('.response-meta')).not.toContainText('Awaiting');
  return api.received.slice(before);
}

test.describe('credentials', () => {
  let folder: string;
  test.beforeEach(async () => {
    folder = await dataFolder();
  });
  test.afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test('the vault asks for a strong, confirmed password', async ({ window }) => {
    await openCredentials(window);
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'setup');
    const create = window.locator('[data-workbench-vault-create]');
    await window.locator('#workbench-vault-password').fill('short1');
    await expect(window.locator('.workbench-vault-hint')).toHaveText('Use at least 12 characters.');
    await expect(create).toBeDisabled();
    await window.locator('#workbench-vault-password').fill(PASSWORD);
    await window.locator('#workbench-vault-confirm').fill(`${PASSWORD}x`);
    await expect(window.locator('.workbench-vault-hint')).toContainText('do not match');
    await expect(create).toBeDisabled();
    await window.locator('#workbench-vault-confirm').fill(PASSWORD);
    await expect(window.locator('.workbench-vault-strength')).toContainText('Strong');
    await expect(create).toBeEnabled();
  });

  test('the recovery key goes to a file, never into the window', async ({ app, window }) => {
    const recoveryFile = path.join(folder, 'recovery.txt');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never;
    }, recoveryFile);
    await openCredentials(window);
    await window.locator('#workbench-vault-password').fill(PASSWORD);
    await window.locator('#workbench-vault-confirm').fill(PASSWORD);
    await window.locator('[data-workbench-vault-create]').click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'recovery');
    const done = window.locator('[data-workbench-vault-done]');
    await expect(done).toBeDisabled();
    await window.locator('[data-workbench-vault-acknowledge]').check();
    // Ticking the box is not enough: the key must be saved or copied first.
    await expect(done).toBeDisabled();
    await window.locator('[data-workbench-vault-save-recovery]').click();
    await expect(done).toBeEnabled();

    await expect
      .poll(async () => (await readFile(recoveryFile, 'utf8').catch(() => '')).length)
      .toBeGreaterThan(0);
    const key = /[A-Z0-9]{4}(?:-[A-Z0-9]{4}){12}/.exec(await readFile(recoveryFile, 'utf8'))?.[0];
    expect(key).toBeTruthy();
    expect(await window.content()).not.toContain(key);
    await done.click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'unlocked');
  });

  test('a saved Bearer credential is sent, but its secret stays out of the window', async ({
    app,
    window,
  }) => {
    await setUpVault(app, window, path.join(folder, 'recovery.txt'));
    await addCredential(window, { name: 'Local API', origin: api.url, secret: SECRET });
    const row = window.locator('[data-credential-row]', { hasText: 'Local API' });
    await expect(row).toContainText('Bearer token');
    await expect(row).toContainText(api.url);

    await openCollections(window);
    await useCredential(window, 'Local API');
    const [received] = await send(window, '/users');
    expect(received.headers.authorization).toBe(`Bearer ${SECRET}`);
    await expect(window.locator('.response-meta')).toContainText('200');
    // The secret is added in the main process: the page, its state, and History never see it.
    expect(await window.content()).not.toContain(SECRET);
    await window.locator('.rail [data-view="History"]').click();
    await window.locator('[data-history-entry]').first().click();
    expect(await window.content()).not.toContain(SECRET);
  });

  test('a credential is sent only to its allowed origin', async ({ app, window }) => {
    await setUpVault(app, window, path.join(folder, 'recovery.txt'));
    await addCredential(window, {
      name: 'Other API',
      origin: 'https://api.other.test',
      secret: SECRET,
    });
    await openCollections(window);
    await useCredential(window, 'Other API');
    const before = api.received.length;
    await window.locator('#url').fill(`${api.url}/users`);
    await window.locator('[data-action=send]').click();
    // Refused before anything is sent: the API never hears from this request.
    await expect(window.locator('#response-panel')).toContainText(
      'Credential is restricted to https://api.other.test',
    );
    expect(api.received.length).toBe(before);
  });

  test('Basic auth sends the username and password', async ({ app, window }) => {
    await setUpVault(app, window, path.join(folder, 'recovery.txt'));
    await addCredential(window, {
      name: 'Basic login',
      kind: 'Basic auth',
      origin: api.url,
      username: 'ada',
      secret: SECRET,
    });
    await openCollections(window);
    await useCredential(window, 'Basic login');
    const [received] = await send(window, '/users');
    expect(received.headers.authorization).toBe(
      `Basic ${Buffer.from(`ada:${SECRET}`).toString('base64')}`,
    );
  });

  test('credentials can be searched, filtered by type, edited, and deleted', async ({
    app,
    window,
  }) => {
    await setUpVault(app, window, path.join(folder, 'recovery.txt'));
    await addCredential(window, { name: 'Payments token', origin: api.url, secret: SECRET });
    await addCredential(window, {
      name: 'Admin login',
      kind: 'Basic auth',
      origin: api.url,
      username: 'admin',
      secret: SECRET,
    });
    const rows = window.locator('[data-credential-row]');
    await expect(rows).toHaveCount(2);

    await window.locator('[data-credential-kind=basic]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Admin login');
    await window.locator('[data-credential-kind=all]').click();
    await window.getByRole('textbox', { name: 'Search credentials' }).fill('payments');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Payments token');
    await window.getByRole('textbox', { name: 'Search credentials' }).fill('');

    // Editing keeps the saved secret when its field is left blank.
    await rows.filter({ hasText: 'Payments token' }).locator('[data-edit-credential]').click();
    const form = window.locator('#credential-form');
    await expect(form.locator('[name=secret]')).toHaveValue('');
    await form.locator('[name=name]').fill('Billing token');
    await window.locator('#save-credential').click();
    await expect(rows.filter({ hasText: 'Billing token' })).toHaveCount(1);
    await openCollections(window);
    await useCredential(window, 'Billing token');
    const [received] = await send(window, '/users');
    expect(received.headers.authorization).toBe(`Bearer ${SECRET}`);

    await openCredentials(window);
    const dialog = window.locator('[data-confirm-dialog]');
    await rows.filter({ hasText: 'Admin login' }).locator('[data-delete-credential]').click();
    await expect(dialog).toContainText('Delete “Admin login”?');
    await dialog.locator('[data-confirm-cancel]').click();
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: 'Admin login' }).locator('[data-delete-credential]').click();
    await dialog.locator('[data-confirm-accept]').click();
    await expect(rows).toHaveCount(1);
  });

  test('locking forgets credentials until the right password is given', async ({
    app,
    window,
    errors,
  }) => {
    await setUpVault(app, window, path.join(folder, 'recovery.txt'));
    await addCredential(window, { name: 'Local API', origin: api.url, secret: SECRET });
    await window.locator('[data-workbench-vault-lock]').click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'locked');
    await expect(window.locator('[data-credential-row]')).toHaveCount(0);

    await window.locator('#workbench-vault-unlock-password').fill('wrong password 123');
    await window.locator('[data-workbench-vault-unlock-button]').click();
    await expect(window.locator('.workbench-vault-error')).toContainText('not right');
    // Electron logs the rejected unlock; that one error is what this test expects.
    const expected = errors.findIndex((error) => error.includes("'vault:unlock'"));
    expect(expected).toBeGreaterThanOrEqual(0);
    errors.splice(expected, 1);
    await window.locator('#workbench-vault-unlock-password').fill(PASSWORD);
    await window.locator('[data-workbench-vault-unlock-button]').click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'unlocked');
    await expect(window.locator('[data-credential-row]', { hasText: 'Local API' })).toBeVisible();
  });

  test('the recovery key sets a new password, and Reset starts over', async ({ app, window }) => {
    const recoveryFile = path.join(folder, 'recovery.txt');
    await setUpVault(app, window, recoveryFile);
    await addCredential(window, { name: 'Local API', origin: api.url, secret: SECRET });
    const key = /[A-Z0-9]{4}(?:-[A-Z0-9]{4}){12}/.exec(await readFile(recoveryFile, 'utf8'))![0];

    await window.locator('[data-workbench-vault-lock]').click();
    await window.locator('[data-workbench-vault-forgot]').click();
    const recover = window.locator('[data-workbench-vault-recover]');
    await recover.locator('#workbench-vault-recovery-key').fill(key);
    const passwords = recover.locator('input[type=password]');
    await passwords.nth(0).fill('A-new-vault-password-2');
    await passwords.nth(1).fill('A-new-vault-password-2');
    await recover.getByRole('button', { name: 'Set password and unlock' }).click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'unlocked');
    await expect(window.locator('[data-credential-row]', { hasText: 'Local API' })).toBeVisible();

    // The new password now unlocks it.
    await window.locator('[data-workbench-vault-lock]').click();
    await window.locator('#workbench-vault-unlock-password').fill('A-new-vault-password-2');
    await window.locator('[data-workbench-vault-unlock-button]').click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'unlocked');

    const dialog = window.locator('[data-confirm-dialog]');
    await window.locator('[data-workbench-vault-reset]').click();
    await expect(dialog).toContainText('Reset the API Workbench vault?');
    await dialog.locator('[data-confirm-accept]').click();
    await expect(vaultState(window)).toHaveAttribute('data-workbench-vault-state', 'setup');
    await expect(window.locator('[data-credential-row]')).toHaveCount(0);
  });

  test('after a restart the vault is locked, and unlocks with its password', async () => {
    const data = await dataFolder();
    const errors: string[] = [];
    try {
      const first = await launchApp(data, errors);
      const window = await mainWindow(first, errors);
      await setUpVault(first, window, path.join(folder, 'recovery.txt'));
      await addCredential(window, { name: 'Local API', origin: api.url, secret: SECRET });
      await first.close();
      // What is on disk is encrypted: the secret is nowhere in the data folder's files.
      for (const entry of await readdir(data, { recursive: true, withFileTypes: true }))
        if (entry.isFile()) {
          const content = await readFile(path.join(entry.parentPath, entry.name));
          expect(content.includes(SECRET), entry.name).toBe(false);
          expect(content.includes(PASSWORD), entry.name).toBe(false);
        }

      const second = await launchApp(data, errors);
      const reopened = await mainWindow(second, errors);
      await openCredentials(reopened);
      await expect(vaultState(reopened)).toHaveAttribute('data-workbench-vault-state', 'locked');
      await reopened.locator('#workbench-vault-unlock-password').fill(PASSWORD);
      await reopened.locator('[data-workbench-vault-unlock-button]').click();
      await expect(
        reopened.locator('[data-credential-row]', { hasText: 'Local API' }),
      ).toBeVisible();
      await second.close();
      expect(errors).toEqual([]);
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});

test('credentials move to the API Workbench vault for the command line, and back', async () => {
  const data = await dataFolder();
  const errors: string[] = [];
  // The app gets a stand-in system store (scripts/e2e-main.ts), as on macOS or Windows.
  process.env.API_WORKBENCH_E2E_OS_STORE = '1';
  const app = await launchApp(data, errors);
  delete process.env.API_WORKBENCH_E2E_OS_STORE;
  const file = path.join(data, 'credentials.enc');
  const inSystemStore = async () => (await readFile(file)).toString().startsWith('e2e-os:');
  try {
    const window = await mainWindow(app, errors);
    await openCredentials(window);
    await expect(window.locator('[data-vault-elsewhere]')).toBeVisible();
    await addCredential(window, { name: 'Payments', origin: api.url, secret: SECRET });
    expect(await inSystemStore()).toBe(true);

    // Choosing the vault asks first, then sets it up; the credential moves into it.
    await window.locator('[data-vault-use-workbench]').click();
    await window.locator('[data-confirm-dialog] [data-confirm-accept]').click();
    await setUpVault(app, window, path.join(data, 'recovery.txt'));
    await expect(window.locator('[data-credential-row]', { hasText: 'Payments' })).toBeVisible();
    expect(await inSystemStore()).toBe(false);
    expect((await readFile(file)).includes(Buffer.from(SECRET))).toBe(false);

    // The command line now reads it with the vault's password.
    const listed = await new Promise<string>((resolve, reject) =>
      execFile(
        path.join(process.cwd(), 'node_modules/.bin/electron'),
        [
          path.join(process.cwd(), 'packages/api-workbench-cli/dist/api-workbench.cjs'),
          'secret',
          'list',
          '--json',
        ],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            API_WORKBENCH_DATA_DIR: data,
            API_WORKBENCH_VAULT_PASSWORD: PASSWORD,
          },
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr || error.message)) : resolve(stdout),
      ),
    );
    expect(JSON.parse(listed).map((item: { name: string }) => item.name)).toEqual(['Payments']);

    // Going back moves it to the system store again, and the app still has it.
    await window.locator('[data-workbench-vault-go-back]').click();
    await window.locator('[data-confirm-dialog] [data-confirm-accept]').click();
    await expect(window.locator('[data-vault-elsewhere]')).toBeVisible();
    await expect(window.locator('[data-credential-row]', { hasText: 'Payments' })).toBeVisible();
    expect(await inSystemStore()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
