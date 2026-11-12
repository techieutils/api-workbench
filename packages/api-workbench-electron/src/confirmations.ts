/**
 * Questions only the person can answer. The Interceptor can read their HTTPS traffic: if
 * anything ever ran script in the app's window, it could ask for that through IPC. A native
 * dialog shown by the main process is outside the page's reach, so these ask there before the
 * first use in each run of the app (or every time, for trusting a certificate), however the
 * request arrived.
 */

export interface Question {
  title: string;
  message: string;
  detail: string;
  /** The button that goes ahead; the other cancels, and is the default. */
  confirm: string;
}

/** Shows a question and says whether the person went ahead (a native dialog in the app). */
export type Ask = (question: Question) => Promise<boolean>;

export class Confirmations {
  private granted = new Set<string>();
  constructor(private ask: Ask) {}

  /**
   * Whether `kind` may go ahead: asked the first time in this run of the app, then remembered
   * until it quits; with `every`, asked each time.
   */
  async allow(kind: string, question: Question, every = false): Promise<boolean> {
    if (!every && this.granted.has(kind)) return true;
    const yes = await this.ask(question);
    if (yes && !every) this.granted.add(kind);
    return yes;
  }
}
