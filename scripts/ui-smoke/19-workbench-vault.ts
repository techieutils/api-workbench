import { app, dialog, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { type SmokeContext, pause, temporary } from './harness';

/**
 * UI smoke checks, part 19: the API Workbench vault, used when the system has no credential
 * store. The keychain stand-in is turned off, so the app falls back to its own vault: set up,
 * the recovery key, saving a credential, locking, unlocking, recovery, and reset.
 */
export default async function workbenchVault(context: SmokeContext) {
  const { run, capture, answerConfirm } = context;
  const wait = async (code: string, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!(await run(code))) {
      if (Date.now() > deadline)
        throw new Error(
          `Vault check timed out: ${code}\n${await run("JSON.stringify({state:document.querySelector('[data-workbench-vault]')?.dataset.workbenchVaultState,error:document.querySelector('.workbench-vault-error')?.textContent.trim(),toasts:[...document.querySelectorAll('.toast')].map(toast=>toast.textContent.trim()).slice(-3)})")}`,
        );
      await pause(50);
    }
  };
  const type = (selector: string, value: string) =>
    run(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input'));})()`,
    );
  const click = (selector: string) =>
    run(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const state = (name: string) =>
    wait(
      `document.querySelector('[data-workbench-vault]')?.dataset.workbenchVaultState===${JSON.stringify(name)}`,
    );
  const keyFile = path.join(app.getPath('userData'), 'vault-key.json');
  const recoveryFile = path.join(temporary, 'recovery-key.txt');
  const original = {
    available: safeStorage.isAsyncEncryptionAvailable,
    save: dialog.showSaveDialog,
  };
  // Earlier parts leave this workspace's credentials encrypted by their stand-in keychain; they
  // are set aside so this part starts as a computer without a store would, and put back after.
  const workspaceId = (await run('workspaceUI.id')) as string;
  const credentialsFile =
    workspaceId === 'default'
      ? path.join(app.getPath('userData'), 'credentials.enc')
      : path.join(app.getPath('userData'), 'workspaces', workspaceId, 'credentials.enc');
  const setAside = `${credentialsFile}.before-vault`;
  if (fs.existsSync(credentialsFile)) fs.renameSync(credentialsFile, setAside);
  // No system credential store: the app must not fall back to plain text.
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  dialog.showSaveDialog = (async () => ({
    canceled: false,
    filePath: recoveryFile,
  })) as typeof dialog.showSaveDialog;
  try {
    await run('openCredentialsPage();void 0');
    await state('setup');
    assert.match(
      (await run("document.querySelector('.credentials-panel').textContent")) as string,
      /Not set up[\s\S]*API Workbench vault/,
      'the Credentials screen says the vault needs setting up',
    );

    // A weak password is explained, and Create stays off until it is strong and confirmed.
    await type('#workbench-vault-password', 'short1');
    await pause(50);
    assert.deepEqual(
      [
        await run("document.querySelector('.workbench-vault-hint').textContent.trim()"),
        await run("document.querySelector('[data-workbench-vault-create]').disabled"),
      ],
      ['Use at least 12 characters.', true],
    );
    await type('#workbench-vault-password', 'Correct-Horse-Battery-9');
    await type('#workbench-vault-confirm', 'Correct-Horse-Battery-9');
    await pause(50);
    assert.equal(
      await run(
        "document.querySelector('.workbench-vault-strength').textContent.includes('Strong')",
      ),
      true,
    );
    await capture('workbench-vault-setup.png');
    await click('[data-workbench-vault-create]');
    await state('recovery');
    assert.ok(fs.existsSync(keyFile), 'the key file is written');
    assert.ok(
      !fs.readFileSync(keyFile, 'utf8').includes('Correct-Horse-Battery-9'),
      'the password is not stored',
    );

    // The recovery key goes to a file from the main process; it never appears in the window.
    assert.equal(await run("document.querySelector('[data-workbench-vault-done]').disabled"), true);
    await click('[data-workbench-vault-save-recovery]');
    await wait("document.querySelector('[data-workbench-vault-acknowledge]')!==null");
    // Written by the main process; read once the key is in it, not as soon as the file exists.
    const keyIn = () =>
      fs.existsSync(recoveryFile) &&
      /[A-Z0-9]{4}(?:-[A-Z0-9]{4}){12}/.test(fs.readFileSync(recoveryFile, 'utf8'));
    for (let attempt = 0; attempt < 60 && !keyIn(); attempt++) await pause(50);
    const recoveryKey = /([A-Z0-9]{4}(?:-[A-Z0-9]{4}){12})/.exec(
      fs.readFileSync(recoveryFile, 'utf8'),
    )?.[1];
    assert.ok(recoveryKey, 'the recovery key is saved to the chosen file');
    assert.equal(
      await run(`document.body.innerHTML.includes(${JSON.stringify(recoveryKey)})`),
      false,
      'the recovery key is not in the page',
    );
    await capture('workbench-vault-recovery.png');
    await click('[data-workbench-vault-acknowledge]');
    await pause(50);
    await click('[data-workbench-vault-done]');
    await state('unlocked');

    // Credentials are saved through the vault: the file is encrypted, never plain text.
    await run(
      "window.workbench.credentials.save({name:'Vault token',kind:'bearer',allowedOrigin:'https://api.vault.test',secret:'TEST-VAULT-SECRET'}).then(()=>loadCredentials())",
    );
    await wait("document.body.textContent.includes('Vault token')");
    const files = fs
      .readdirSync(app.getPath('userData'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === 'credentials.enc')
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const saved = fs.readFileSync(files[0]);
    assert.equal(saved.subarray(0, 4).toString(), 'AWV1', 'saved by the API Workbench vault');
    assert.ok(!saved.includes(Buffer.from('TEST-VAULT-SECRET')), 'the secret is encrypted');
    await capture('workbench-vault-open.png');

    // Locked, the credentials are gone from the app until the password is given again.
    await click('[data-workbench-vault-lock]');
    await state('locked');
    assert.equal(await run('credentials.length'), 0, 'locking forgets the credentials');
    await type('#workbench-vault-unlock-password', 'wrong password 123');
    await click('[data-workbench-vault-unlock-button]');
    await wait(
      "document.querySelector('.workbench-vault-error')?.textContent.includes('not right')",
    );
    await type('#workbench-vault-unlock-password', 'Correct-Horse-Battery-9');
    await click('[data-workbench-vault-unlock-button]');
    await state('unlocked');
    await wait("document.body.textContent.includes('Vault token')");

    // A forgotten password: the recovery key sets a new one.
    await click('[data-workbench-vault-lock]');
    await state('locked');
    await capture('workbench-vault-locked.png');
    await click('[data-workbench-vault-forgot]');
    await wait("Boolean(document.querySelector('[data-workbench-vault-recover]'))");
    await type('#workbench-vault-recovery-key', recoveryKey.toLowerCase());
    await type('#workbench-vault-new-password', 'A-new-vault-password-2');
    await type(
      '[data-workbench-vault-recover] input[autocomplete=new-password]:not(#workbench-vault-new-password)',
      'A-new-vault-password-2',
    );
    await run("document.querySelector('[data-workbench-vault-recover]').requestSubmit()");
    await state('unlocked');
    await wait("document.body.textContent.includes('Vault token')");

    // Reset deletes the vault and what it encrypted, after asking.
    await click('[data-workbench-vault-reset]');
    await answerConfirm(true);
    await state('setup');
    assert.equal(fs.existsSync(keyFile), false, 'the key file is gone');
    assert.equal(fs.existsSync(files[0]), false, 'credentials it encrypted are deleted');
  } finally {
    safeStorage.isAsyncEncryptionAvailable = original.available;
    dialog.showSaveDialog = original.save;
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(recoveryFile, { force: true });
    if (fs.existsSync(setAside)) fs.renameSync(setAside, credentialsFile);
    await run("view='Collections';render()");
  }
}
