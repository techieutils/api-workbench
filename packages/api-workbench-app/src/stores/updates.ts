import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type {
  UpdateInfo,
  UpdatePreferences,
  UpdateStatus,
} from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { openSettings } from '../navigation';

/**
 * App updates from the main process: the person's preferences, the current status, and toasts
 * when a new version is found or ready. Without the desktop bridge (the browser build), there is
 * nothing to update and `info` stays undefined.
 */
export const useUpdatesStore = defineStore('updates', () => {
  const info = shallowRef<UpdateInfo>();
  const bridge = () => window.workbench?.updates;
  let started = false;
  /**
   * The person's latest choice. Each change merges into it straight away, so a second change made
   * before the first is saved does not undo the first.
   */
  let chosen: UpdatePreferences | undefined;

  /** The notice for a found or downloaded update; the same text each time, so it never stacks. */
  function updateToast(status: UpdateStatus): boolean {
    if (status.state === 'available') {
      toast(`API Workbench ${status.version} is available.`, {
        tone: 'info',
        title: 'Update available',
        action: { label: 'Download', run: () => void download() },
        duration: 12_000,
      });
      return true;
    }
    if (status.state === 'downloaded') {
      toast(`Version ${status.version} installs when you quit, or restart now.`, {
        tone: 'success',
        title: 'Update ready',
        action: { label: 'Restart now', run: () => void install() },
        duration: 15_000,
      });
      return true;
    }
    return false;
  }
  /** Toasts once per version and state, so a scheduled check does not repeat them. */
  let announced = '';
  function announce(status: UpdateStatus, preferences: UpdatePreferences): void {
    const key = 'version' in status ? `${status.state}:${status.version}` : status.state;
    if (key === announced) return;
    if (status.state === 'available' && preferences.mode === 'auto') return;
    if (updateToast(status)) announced = key;
  }
  function apply(next: UpdateInfo): void {
    info.value = next;
    // Once the main process has the latest choice, follow what it reports again.
    if (chosen?.mode === next.preferences.mode && chosen.prerelease === next.preferences.prerelease)
      chosen = undefined;
    announce(next.status, next.preferences);
    render();
  }

  /** Loads the current state and follows changes; safe to call more than once. */
  async function start(): Promise<void> {
    if (started || !bridge()) return;
    started = true;
    bridge()!.onChange(apply);
    apply(await bridge()!.info());
  }
  async function run(task: () => Promise<UpdateInfo | void> | undefined): Promise<void> {
    try {
      const next = await task();
      if (next) apply(next);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }
  function setPreferences(change: Partial<UpdatePreferences>): Promise<void> {
    const current = chosen ?? info.value?.preferences;
    if (!current) return Promise.resolve();
    chosen = { ...current, ...change };
    const preferences = chosen;
    return run(() => bridge()?.setPreferences(preferences));
  }
  const check = () => run(() => bridge()?.check());
  const download = () => run(() => bridge()?.download());
  const install = () => run(() => bridge()?.install());
  const settingsAction = { label: 'Settings', run: () => open() };
  /** Whether a check started from the status bar is running. */
  const checking = ref(false);
  /**
   * Answers "is there an update?": shows a pending update, or checks now and says what it found.
   */
  async function report(): Promise<void> {
    if (!bridge()) {
      toast('The desktop app updates itself; download new versions from GitHub releases.', 'info');
      return;
    }
    if (checking.value) return;
    if (!info.value) await start();
    let status = info.value?.status;
    if (status && ['idle', 'current', 'error'].includes(status.state)) {
      checking.value = true;
      render();
      try {
        await check();
      } finally {
        checking.value = false;
        render();
      }
      status = info.value?.status;
    }
    if (!status || updateToast(status)) return;
    const version = info.value?.currentVersion ?? '';
    if (status.state === 'unsupported')
      toast(status.reason, { tone: 'info', title: 'Updates', action: settingsAction });
    else if (status.state === 'current')
      toast(`API Workbench ${version} is the latest version.`, {
        tone: 'success',
        title: 'You’re up to date',
        action: settingsAction,
      });
    else if (status.state === 'downloading')
      toast(`Downloading version ${status.version} (${status.percent}%).`, {
        tone: 'info',
        title: 'Update downloading',
        action: settingsAction,
      });
    else if (status.state === 'checking')
      toast('Still looking for a new version.', { tone: 'info', title: 'Checking for updates' });
    else if (status.state === 'error')
      toast(status.message, {
        tone: 'error',
        title: 'Could not check for updates',
        action: { label: 'Try again', run: () => void report() },
      });
  }
  /** Opens Settings → Updates. */
  function open(): void {
    openSettings('Updates');
  }
  return { info, checking, start, setPreferences, check, download, install, open, report };
});
