import { dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { type SmokeContext, pause } from './harness';

/**
 * UI smoke checks, part 18: auto save (off, after a pause) and where workspaces are saved, set in
 * Settings → Saving and checked on disk.
 */
export default async function savingAndStorage(context: SmokeContext) {
  const { run, capture } = context;
  const wait = async (code: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!(await run(code))) {
      if (Date.now() > deadline)
        throw new Error(
          `Saving check timed out: ${code}\n${await run("JSON.stringify({save:document.querySelector('#save-status')?.textContent.trim(),toasts:[...document.querySelectorAll('.toast')].map(toast=>toast.textContent.trim()).slice(-3)})")}`,
        );
      await pause(50);
    }
  };
  const choose = (selector: string, value: string) =>
    run(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('change'));field.dispatchEvent(new Event('input'));})()`,
    );
  /** Whether any file of the open workspace on disk holds `text`. */
  const onDisk = async (text: string) => {
    const folder = ((await run('window.workbench.workspaces.storage()')) as { current: string })
      .current;
    const files = fs
      .readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && /\.(json|ya?ml)$/.test(entry.name) && !entry.name.endsWith('.tmp'),
      )
      .map((entry) => path.join(entry.parentPath, entry.name));
    return files.some((file) => fs.readFileSync(file, 'utf8').includes(text));
  };
  const openSaving = async () => {
    await run("view='Settings';render()");
    await wait("Boolean(document.querySelector('[data-settings-section=Saving]'))");
    await run("document.querySelector('[data-settings-section=Saving]').click()");
  };
  const setAutoSave = async (mode: string, seconds?: number) => {
    await openSaving();
    await wait("Boolean(document.querySelector('#setting-autoSave'))");
    await choose('#setting-autoSave', mode);
    if (seconds !== undefined) {
      await wait("Boolean(document.querySelector('#setting-autoSaveDelaySeconds'))");
      await choose('#setting-autoSaveDelaySeconds', String(seconds));
    }
    await run("document.querySelector('#settings-form').requestSubmit()");
    await wait(`state.settings.autoSave===${JSON.stringify(mode)}&&!workspaceUnsaved()`);
  };
  const original = (await run('state.requests[0].name')) as string;
  const rename = (name: string) =>
    run(`state.requests[0].name=${JSON.stringify(name)};persist();render()`);

  // Off: changes wait for Save, the status bar says so and saves on click.
  await setAutoSave('off');
  await rename('Saved only on request');
  await wait("document.querySelector('[data-save-now]')?.textContent.includes('Unsaved changes')");
  await pause(800);
  assert.equal(await onDisk('Saved only on request'), false, 'nothing is written while it is off');
  await capture('saving-unsaved.png');
  await run("document.querySelector('[data-save-now]').click()");
  await wait(
    "!document.querySelector('[data-save-now]')&&document.querySelector('#save-status').textContent.includes('Saved')",
  );
  assert.equal(await onDisk('Saved only on request'), true, 'Save writes it');

  // Switching workspaces with changes not saved asks first; staying keeps them.
  await rename('Waiting to switch');
  await run('openWorkspaceManager()');
  await wait("Boolean(document.querySelector('[data-workspace-new]'))");
  const other = (await run(
    'window.workbench.workspaces.create("Saving check",structuredClone(state),"app-data").then(item=>item.id)',
  )) as string;
  await run(`selectWorkspace(${JSON.stringify(other)});void 0`);
  await wait("Boolean(document.querySelector('[data-confirm-dialog] [data-confirm-cancel]'))");
  assert.match(
    (await run("document.querySelector('[data-confirm-dialog]').textContent")) as string,
    /Auto save is off/,
  );
  await run("document.querySelector('[data-confirm-cancel]').click()");
  await pause(200);
  assert.deepEqual(
    [await run('workspaceUI.id!==' + JSON.stringify(other)), await run('workspaceUnsaved()')],
    [true, true],
    'staying keeps the workspace open with its changes',
  );
  await run('closeWorkspaceManager()');
  await run(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',metaKey:true,ctrlKey:true,bubbles:true}))",
  );
  await wait('!workspaceUnsaved()');
  assert.equal(await onDisk('Waiting to switch'), true, '⌘ S saves');
  await run(`window.workbench.workspaces.delete(${JSON.stringify(other)})`);

  // After a pause: one save once editing stops.
  await setAutoSave('delay', 1);
  await rename('Saved after a pause');
  await wait("document.querySelector('#save-status').textContent.includes('Saving shortly')");
  await wait("document.querySelector('#save-status').textContent.includes('Saved')", 5000);
  assert.equal(await onDisk('Saved after a pause'), true, 'the pause ends in a save');
  await setAutoSave('change');
  await rename(original);
  await wait('!workspaceUnsaved()');

  // Where workspaces are saved: a folder chosen here takes new workspaces, each in its own folder.
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-storage-ui-'));
  const originalOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: [storage],
  })) as typeof dialog.showOpenDialog;
  let created: string | undefined;
  try {
    await openSaving();
    await wait("document.querySelector('[data-storage-default]')?.textContent.trim().length>1");
    assert.match(
      (await run("document.querySelector('[data-settings-storage]').textContent")) as string,
      /App data · default/,
      'without a folder, workspaces go in app data',
    );
    await run("document.querySelector('[data-storage-choose]').click()");
    await wait(
      `document.querySelector('[data-storage-default]').textContent.trim()===${JSON.stringify(storage)}`,
    );
    await capture('saving-settings.png');
    // The new-workspace form offers the default folder, app data, or a folder chosen then.
    await run('openWorkspaceManager();void 0');
    await wait(
      "Boolean(document.querySelector('[data-workspace-new]'))&&!workspaceUI.busy&&!workspaceUI.loading&&!document.querySelector('[data-workspace-new]').disabled",
    );
    await run("document.querySelector('[data-workspace-new]').click()");
    await wait("Boolean(document.querySelector('[data-workspace-location-choice]'))");
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-workspace-location-option]')].map(input=>input.value)",
      ),
      ['default', 'app-data', 'choose'],
    );
    await capture('saving-new-workspace.png');
    await run(
      "(()=>{const field=document.querySelector('#workspace-create-name');field.value='Stored elsewhere';field.dispatchEvent(new Event('input'));field.form.requestSubmit();})()",
    );
    await wait(
      "workspaceUI.index.workspaces.some(item=>item.name==='Stored elsewhere')&&!workspaceUI.busy",
      15000,
    );
    const entry = (await run(
      "JSON.stringify(workspaceUI.index.workspaces.find(item=>item.name==='Stored elsewhere'))",
    )) as string;
    const workspace = JSON.parse(entry) as { id: string; location?: string };
    created = workspace.id;
    assert.equal(workspace.location, path.join(storage, 'Stored elsewhere'));
    assert.ok(fs.existsSync(path.join(storage, 'Stored elsewhere', 'workspace.json')));
    assert.ok(
      !fs.existsSync(path.join(storage, 'Stored elsewhere', 'credentials.enc')),
      'the vault stays in app data',
    );
  } finally {
    dialog.showOpenDialog = originalOpenDialog;
    await run('closeWorkspaceManager?.()');
  }
  // Back to the first workspace; the stored one is removed from the list, its files kept.
  await run(
    `selectWorkspace(${JSON.stringify(await run('workspaceUI.index.workspaces.find(item=>item.id!==' + JSON.stringify(created) + ').id'))});void 0`,
  );
  await wait(`workspaceUI.id!==${JSON.stringify(created)}&&!workspaceUI.busy`, 15000);
  await run(`window.workbench.workspaces.delete(${JSON.stringify(created)})`);
  assert.ok(
    fs.existsSync(path.join(storage, 'Stored elsewhere', 'workspace.json')),
    'removing a workspace keeps the files in its folder',
  );
  await run('window.workbench.workspaces.resetStorageFolder()');
  await run('closeWorkspaceManager?.()');
  await run("view='Collections';render()");
  fs.rmSync(storage, { recursive: true, force: true });
}
