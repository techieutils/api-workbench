import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  UpdateInfo,
  UpdateMode,
  UpdatePreferences,
  UpdateStatus,
} from '@techieutils/api-workbench-common/types';

/** The parts of electron-updater's AppUpdater this service uses, so tests can stand in for it. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each event has its own arguments
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = { mode: 'notify', prerelease: false };
const MODES: UpdateMode[] = ['auto', 'notify', 'off'];
/** The first check waits for the window to settle; later ones run every few hours. */
const FIRST_CHECK_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Saved preferences, or the defaults for anything missing or invalid. */
export function updatePreferences(value: unknown): UpdatePreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<UpdatePreferences>;
  return {
    mode: MODES.includes(input.mode as UpdateMode)
      ? (input.mode as UpdateMode)
      : DEFAULT_UPDATE_PREFERENCES.mode,
    prerelease: input.prerelease === true,
  };
}

/** A short message for a failed check or download, without stack traces or file paths. */
export function updateErrorMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();
  if (/net::|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(text))
    return 'Could not reach GitHub to check for updates. Check your connection, then try again.';
  if (/latest(-mac|-linux)?\.yml|404/i.test(text))
    return 'No update information was found for this platform in the latest release.';
  if (/code signature|not signed|signature/i.test(text))
    return 'The update could not be verified: its signature did not match this installation.';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || 'The update failed.';
}

/** Text without markup; stray angle brackets left by nested tags such as `<<b>i>` go too. */
const stripTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .trim();
/** Release notes as plain text: electron-updater gives a string, or a list per version. */
function notesText(notes: unknown): string | undefined {
  if (typeof notes === 'string') return stripTags(notes) || undefined;
  if (Array.isArray(notes))
    return (
      stripTags(
        notes.map((item) => (typeof item?.note === 'string' ? item.note : '')).join('\n\n'),
      ) || undefined
    );
  return undefined;
}

/**
 * Keeps the app up to date from GitHub releases, as the person chose: downloading and installing
 * on quit (auto), asking first (notify), or only when they check (off). Status changes are
 * reported through `publish`.
 */
export class UpdateService {
  private preferences: UpdatePreferences = { ...DEFAULT_UPDATE_PREFERENCES };
  private status: UpdateStatus = { state: 'idle' };
  private lastChecked?: string;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly options: {
      updater: Updater;
      /** Where preferences are saved: a JSON file in the app's data folder. */
      file: string;
      currentVersion: string;
      /** Why this installation cannot update itself, if it cannot. */
      unsupported?: string;
      publish: (info: UpdateInfo) => void;
      now?: () => Date;
    },
  ) {
    const { updater } = options;
    updater.on('checking-for-update', () => this.set({ state: 'checking' }));
    updater.on('update-not-available', () => {
      this.lastChecked = this.now().toISOString();
      this.set({ state: 'current' });
    });
    updater.on(
      'update-available',
      (info: { version: string; releaseDate?: string; releaseNotes?: unknown }) => {
        this.lastChecked = this.now().toISOString();
        this.set({
          state: 'available',
          version: info.version,
          ...(info.releaseDate ? { releaseDate: info.releaseDate } : {}),
          ...(notesText(info.releaseNotes) ? { notes: notesText(info.releaseNotes) } : {}),
        });
      },
    );
    updater.on('download-progress', (progress: { percent: number }) => {
      const version = 'version' in this.status ? this.status.version : '';
      this.set({ state: 'downloading', version, percent: Math.round(progress.percent) });
    });
    updater.on('update-downloaded', (info: { version: string }) =>
      this.set({ state: 'downloaded', version: info.version }),
    );
    updater.on('error', (error: unknown) =>
      this.set({ state: 'error', message: updateErrorMessage(error) }),
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  info(): UpdateInfo {
    return {
      currentVersion: this.options.currentVersion,
      preferences: { ...this.preferences },
      status: this.options.unsupported
        ? { state: 'unsupported', reason: this.options.unsupported }
        : this.status,
      ...(this.lastChecked ? { lastChecked: this.lastChecked } : {}),
    };
  }
  private set(status: UpdateStatus): void {
    this.status = status;
    this.options.publish(this.info());
  }
  /** Applies the preferences to the updater and to the check schedule. */
  private apply(): void {
    const { updater } = this.options;
    updater.autoDownload = this.preferences.mode === 'auto';
    // A downloaded update installs when the app quits, whichever way it was downloaded.
    updater.autoInstallOnAppQuit = this.preferences.mode !== 'off';
    updater.allowPrerelease = this.preferences.prerelease;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.options.unsupported || this.preferences.mode === 'off') return;
    const first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    const repeat = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    first.unref?.();
    repeat.unref?.();
    this.timers.push(first, repeat);
  }
  /** Loads the saved preferences and starts checking on schedule. */
  async start(): Promise<void> {
    try {
      this.preferences = updatePreferences(JSON.parse(await readFile(this.options.file, 'utf8')));
    } catch {
      this.preferences = { ...DEFAULT_UPDATE_PREFERENCES };
    }
    this.apply();
  }
  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
  /** Saves run one at a time, so quick changes never race on the temporary file. */
  private saving: Promise<unknown> = Promise.resolve();
  async setPreferences(value: unknown): Promise<UpdateInfo> {
    const preferences = updatePreferences(value);
    this.preferences = preferences;
    this.apply();
    const save = this.saving.then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      await writeFile(`${this.options.file}.tmp`, JSON.stringify(preferences, null, 2));
      await rename(`${this.options.file}.tmp`, this.options.file);
    });
    // A failed save does not block the next one.
    this.saving = save.catch(() => undefined);
    await save;
    this.options.publish(this.info());
    return this.info();
  }
  /** Checks now. A check already running, or a downloaded update waiting, is left alone. */
  async check(): Promise<UpdateInfo> {
    if (this.options.unsupported) return this.info();
    if (['checking', 'downloading', 'downloaded'].includes(this.status.state)) return this.info();
    this.set({ state: 'checking' });
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.set({ state: 'error', message: updateErrorMessage(error) });
    }
    return this.info();
  }
  /** Downloads the available update; it installs on quit, or now with `install`. */
  async download(): Promise<UpdateInfo> {
    if (this.status.state !== 'available') return this.info();
    this.set({ state: 'downloading', version: this.status.version, percent: 0 });
    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.set({ state: 'error', message: updateErrorMessage(error) });
    }
    return this.info();
  }
  install(): void {
    if (this.status.state === 'downloaded') this.options.updater.quitAndInstall(false, true);
  }
}
