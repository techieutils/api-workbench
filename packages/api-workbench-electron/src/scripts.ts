import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PAUSED_MESSAGE,
  SCRIPT_LIMITS,
  scriptInputProblem,
  type ScriptInput,
  type ScriptOutput,
} from '@techieutils/api-workbench-common/scripts';

/**
 * Which scripts may run on this computer. A script runs only when its exact text was written in
 * the app or allowed by the person, so a script that arrives in an import, a teammate's change, or
 * an edit to the workspace's files waits until its collection is allowed. The list holds SHA-256
 * fingerprints, not scripts, and lives in the app's data folder: outside every workspace, so a
 * shared folder cannot mark its own scripts as allowed.
 */
export class ScriptTrust {
  private fingerprints = new Set<string>();
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  /** Enough for every script in many workspaces; the oldest are forgotten first. */
  static readonly LIMIT = 20_000;

  constructor(private readonly file: string) {}

  static fingerprint(source: string): string {
    return createHash('sha256').update(source, 'utf8').digest('hex');
  }

  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8')) as { fingerprints?: unknown };
        if (Array.isArray(data.fingerprints))
          for (const item of data.fingerprints)
            if (typeof item === 'string' && /^[0-9a-f]{64}$/.test(item))
              this.fingerprints.add(item);
      } catch {
        // No list yet, or an unreadable one: nothing is allowed until the person allows it.
      }
    })());
  }

  private save(): Promise<void> {
    const list = [...this.fingerprints].slice(-ScriptTrust.LIMIT);
    this.fingerprints = new Set(list);
    this.saving = this.saving.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, fingerprints: list }));
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.saving;
  }

  /** A blank script has nothing to run, so it never needs allowing. */
  async trusted(source: string): Promise<boolean> {
    if (!source.trim()) return true;
    await this.load();
    return this.fingerprints.has(ScriptTrust.fingerprint(source));
  }

  async trustedList(sources: string[]): Promise<boolean[]> {
    return Promise.all(sources.map((source) => this.trusted(source)));
  }

  /** Allows these scripts, after the person reviewed them. */
  async allow(sources: string[]): Promise<void> {
    await this.load();
    for (const source of sources)
      if (source.trim()) {
        const fingerprint = ScriptTrust.fingerprint(source);
        // Moved to the end, so recently used scripts are the last to be forgotten.
        this.fingerprints.delete(fingerprint);
        this.fingerprints.add(fingerprint);
      }
    await this.save();
  }

  /**
   * A script edited in the app: the new text is allowed when the old one was, so typing into
   * your own script keeps it running, while editing a paused script leaves it paused.
   */
  async edited(previous: string, next: string): Promise<boolean> {
    if (!(await this.trusted(previous))) return this.trusted(next);
    if (next.trim()) await this.allow([next]);
    return true;
  }
}

const stopped = (error: string, durationMs: number): ScriptOutput => ({
  ok: false,
  error,
  variables: {},
  tests: [],
  logs: [],
  durationMs,
});

/** Something that runs scripts in another process and can be stopped: a utility process. */
export interface ScriptProcess {
  postMessage(message: { id: number; input: ScriptInput }): void;
  onMessage(listener: (message: { id: number; output: ScriptOutput }) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

/**
 * Runs scripts in a separate process, one at a time, so a script never blocks the main process.
 * The engine stops a script at its own time limit; a process that does not answer soon after is
 * killed, and the next script starts a fresh one.
 */
export class ScriptHost {
  private child?: ScriptProcess;
  private next = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly spawn: () => ScriptProcess,
    private readonly trust: ScriptTrust,
    /** How long past the engine's own limit to wait before killing the process. */
    private readonly graceMs = 3000,
  ) {}

  /** Runs a script that was checked and allowed; others come back paused or failed. */
  run(input: unknown): Promise<ScriptOutput> {
    const failed = (error: string, paused = false): ScriptOutput => ({
      ok: false,
      error,
      ...(paused ? { paused: true } : {}),
      variables: {},
      tests: [],
      logs: [],
      durationMs: 0,
    });
    const problem = scriptInputProblem(input);
    if (problem) return Promise.resolve(failed(problem));
    const checked = input as ScriptInput;
    const result = this.queue.then(async () => {
      if (!(await this.trust.trusted(checked.source))) return failed(PAUSED_MESSAGE, true);
      // Library modules go in only once allowed; the others are named, so requiring one pauses
      // the script with a reason instead of saying the module does not exist.
      const libraries = await Promise.all(
        (checked.libraries ?? []).map(async (entry) =>
          entry.source !== undefined && (await this.trust.trusted(entry.source))
            ? { name: entry.name, source: entry.source }
            : { name: entry.name, paused: true as const },
        ),
      );
      return this.execute({ ...checked, libraries });
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** The script waiting for the process's answer, by id: one at a time, as runs are queued. */
  private pending = new Map<number, (output: ScriptOutput) => void>();

  private process(): ScriptProcess {
    if (this.child) return this.child;
    const child = this.spawn();
    child.onMessage((message) => this.pending.get(message.id)?.(message.output));
    child.onExit(() => {
      if (this.child === child) this.child = undefined;
      for (const finish of [...this.pending.values()])
        finish(stopped('The script process stopped unexpectedly.', 0));
    });
    return (this.child = child);
  }

  private execute(input: ScriptInput): Promise<ScriptOutput> {
    const id = this.next++;
    const child = this.process();
    return new Promise((resolve) => {
      const finish = (output: ScriptOutput) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(output);
      };
      this.pending.set(id, finish);
      const timer = setTimeout(() => {
        // Stuck past the engine's own limit: the process is replaced.
        finish(
          stopped(
            `The script ran longer than ${SCRIPT_LIMITS.timeoutMs / 1000} seconds and was stopped.`,
            SCRIPT_LIMITS.timeoutMs + this.graceMs,
          ),
        );
        if (this.child === child) this.child = undefined;
        child.kill();
      }, SCRIPT_LIMITS.timeoutMs + this.graceMs);
      child.postMessage({ id, input });
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
