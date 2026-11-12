/**
 * Unsaved changes when the window closes. The app reports them as they happen (`report`). On
 * close, a pending save is finished first; with auto save off, the person chooses to save,
 * discard, or stay. Electron's window, dialog, and quit are passed in, so this is tested alone.
 */
export interface CloseGuardHost {
  /** Asks Save, Don't save, or Cancel; answers 0, 1, or 2. */
  ask(): number;
  /** Tells the app to save now; it answers with `ready`. */
  requestSave(): void;
  /** Closes the window for real. */
  close(): void;
  /** Carries on quitting the app. */
  quit(): void;
}
/** How long the app has to save before the window closes anyway, so a stuck window cannot block it. */
export const SAVE_BEFORE_CLOSE_MS = 10_000;

export class CloseGuard {
  private changes = false;
  private askFirst = false;
  private closing = false;
  private quitting = false;
  /** Waiting for the app's answer to a save asked for on close. */
  private waiting = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly host: CloseGuardHost) {}
  /** What the app says: whether changes are waiting, and whether to ask before saving them. */
  report(changes: unknown, ask: unknown): void {
    this.changes = changes === true;
    this.askFirst = ask === true;
  }
  /** Quitting the app; a close held up by a save carries the quit on afterwards. */
  quitRequested(): void {
    this.quitting = true;
  }
  /** On the window’s close event: true when the close must wait (call preventDefault). */
  onClose(): boolean {
    if (!this.changes || this.closing) return false;
    if (this.askFirst) {
      const choice = this.host.ask();
      if (choice === 2) {
        this.quitting = false;
        return true;
      }
      // Don't save: this close goes ahead as it is.
      if (choice === 1) {
        this.changes = false;
        return false;
      }
    }
    this.closing = true;
    this.waiting = true;
    this.host.requestSave();
    this.timer = setTimeout(() => this.closeNow(), SAVE_BEFORE_CLOSE_MS);
    return true;
  }
  /** The app's answer: saved, so close; or not, so the window stays open and nothing is lost. */
  ready(saved: unknown): void {
    if (!this.waiting) return;
    this.waiting = false;
    if (saved !== true) {
      clearTimeout(this.timer);
      this.closing = false;
      this.quitting = false;
      return;
    }
    this.closeNow();
  }
  /** A window opened again (macOS) starts with nothing unsaved. */
  reset(): void {
    clearTimeout(this.timer);
    Object.assign(this, { changes: false, askFirst: false, closing: false, waiting: false });
  }
  private closeNow(): void {
    clearTimeout(this.timer);
    this.waiting = false;
    this.changes = false;
    this.closing = true;
    this.host.close();
    // Quitting was held up by the save; it carries on now (macOS keeps the app open otherwise).
    if (this.quitting) this.host.quit();
  }
}
