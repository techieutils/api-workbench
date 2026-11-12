import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UpdateInfo } from '@techieutils/api-workbench-common/types';
import {
  DEFAULT_UPDATE_PREFERENCES,
  UpdateService,
  updateErrorMessage,
  updatePreferences,
  type Updater,
} from './updates';

/** A stand-in for electron-updater: it records calls, and tests emit its events. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = false;
  calls: string[] = [];
  failCheck?: Error;
  async checkForUpdates() {
    this.calls.push('check');
    if (this.failCheck) throw this.failCheck;
  }
  async downloadUpdate() {
    this.calls.push('download');
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.calls.push(`install:${isSilent}:${isForceRunAfter}`);
  }
}

async function service(t: { after(callback: () => Promise<void>): void }, unsupported?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-updates-'));
  const updater = new FakeUpdater();
  const published: UpdateInfo[] = [];
  const updates = new UpdateService({
    updater,
    file: path.join(directory, 'updates.json'),
    currentVersion: '1.0.0',
    unsupported,
    publish: (info) => published.push(info),
    now: () => new Date('2026-11-04T10:00:00.000Z'),
  });
  t.after(async () => {
    updates.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { updates, updater, published, file: path.join(directory, 'updates.json') };
}

test('update preferences default to asking first, and invalid values fall back', () => {
  assert.deepEqual(DEFAULT_UPDATE_PREFERENCES, { mode: 'notify', prerelease: false });
  assert.deepEqual(updatePreferences(undefined), DEFAULT_UPDATE_PREFERENCES);
  assert.deepEqual(updatePreferences({ mode: 'sometimes', prerelease: 'yes' }), {
    mode: 'notify',
    prerelease: false,
  });
  assert.deepEqual(updatePreferences({ mode: 'auto', prerelease: true }), {
    mode: 'auto',
    prerelease: true,
  });
});

test('each mode sets how the updater downloads and installs, and preferences are saved', async (t) => {
  const { updates, updater, file } = await service(t);
  await updates.start();
  // Notify: checks, downloads only when asked, and installs a downloaded update on quit.
  assert.deepEqual(
    [updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease],
    [false, true, false],
  );
  await updates.setPreferences({ mode: 'auto', prerelease: true });
  assert.deepEqual(
    [updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease],
    [true, true, true],
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mode: 'auto', prerelease: true });
  await updates.setPreferences({ mode: 'off', prerelease: false });
  assert.deepEqual([updater.autoDownload, updater.autoInstallOnAppQuit], [false, false]);
  // Saved preferences are read back on the next start.
  await writeFile(file, JSON.stringify({ mode: 'auto', prerelease: false }));
  await updates.start();
  assert.equal(updates.info().preferences.mode, 'auto');
});

test('quick changes are saved in order, and the last one wins', async (t) => {
  const { updates, file, published } = await service(t);
  await updates.start();
  const saves = [
    updates.setPreferences({ mode: 'auto', prerelease: false }),
    updates.setPreferences({ mode: 'auto', prerelease: true }),
    updates.setPreferences({ mode: 'off', prerelease: true }),
  ];
  await Promise.all(saves);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mode: 'off', prerelease: true });
  assert.deepEqual(updates.info().preferences, { mode: 'off', prerelease: true });
  assert.deepEqual(published.at(-1)?.preferences, { mode: 'off', prerelease: true });
});

test('a check reports what it finds, and a download and install follow the person', async (t) => {
  const { updates, updater, published } = await service(t);
  await updates.start();
  const checked = updates.check();
  assert.equal(updates.info().status.state, 'checking');
  await checked;
  updater.emit('update-not-available', { version: '1.0.0' });
  assert.deepEqual(updates.info().status, { state: 'current' });
  assert.equal(updates.info().lastChecked, '2026-11-04T10:00:00.000Z');

  await updates.check();
  updater.emit('update-available', {
    version: '1.1.0',
    releaseDate: '2026-11-03',
    releaseNotes: '<p>Faster <b>captures</b></p>',
  });
  assert.deepEqual(updates.info().status, {
    state: 'available',
    version: '1.1.0',
    releaseDate: '2026-11-03',
    notes: 'Faster captures',
  });
  // Installing waits for a download.
  updates.install();
  assert.equal(updater.calls.includes('install:false:true'), false);

  await updates.download();
  assert.deepEqual(updates.info().status, { state: 'downloading', version: '1.1.0', percent: 0 });
  updater.emit('download-progress', { percent: 42.6 });
  assert.deepEqual(updates.info().status, { state: 'downloading', version: '1.1.0', percent: 43 });
  updater.emit('update-downloaded', { version: '1.1.0' });
  assert.deepEqual(updates.info().status, { state: 'downloaded', version: '1.1.0' });
  // A downloaded update is not checked over; installing restarts into it.
  await updates.check();
  assert.equal(updater.calls.filter((call) => call === 'check').length, 2);
  updates.install();
  assert.ok(updater.calls.includes('install:false:true'));
  assert.ok(published.length >= 6, 'every change is published to the window');
});

test('failures are short and readable, and unsupported installations do not check', async (t) => {
  const { updates, updater } = await service(t);
  updater.failCheck = new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack');
  await updates.check();
  assert.deepEqual(updates.info().status, {
    state: 'error',
    message: 'Could not reach GitHub to check for updates. Check your connection, then try again.',
  });
  assert.match(
    updateErrorMessage(new Error('Cannot find latest-mac.yml in the latest release')),
    /No update information/,
  );
  assert.match(
    updateErrorMessage(new Error('Code signature at URL did not pass validation')),
    /could not be verified/,
  );
  assert.equal(updateErrorMessage(new Error('x'.repeat(300))).length, 201);

  const source = await service(t, 'Run from source.');
  await source.updates.start();
  await source.updates.check();
  assert.deepEqual(source.updates.info().status, {
    state: 'unsupported',
    reason: 'Run from source.',
  });
  assert.deepEqual(source.updater.calls, []);
});
