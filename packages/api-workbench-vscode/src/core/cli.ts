import { refusedHost } from './hosts';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Runs the api-workbench command line, which the extension ships as one JavaScript file. It needs
 * Node.js 22.19 or later: the `node` on PATH when it is new enough, otherwise the editor's own
 * runtime (run as plain Node with ELECTRON_RUN_AS_NODE) when that is. Everything the extension
 * shows comes from the command line's JSON output, so it works exactly as the app does.
 */

export const MIN_NODE = [22, 19] as const;

/** A JavaScript runtime that can run the command line. */
export interface Runtime {
  /** The executable. */
  command: string;
  /** Extra environment, such as ELECTRON_RUN_AS_NODE for the editor's own runtime. */
  env: Record<string, string>;
  version: string;
}

/** Whether a version such as `v22.19.0` or `22.21.1` is new enough. */
export function supportsCli(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function versionOf(command: string, env: Record<string, string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['-p', 'process.versions.node'],
      { env: { ...process.env, ...env }, timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}

/**
 * The runtime to use: `configured` (a path from the settings) when given, else `node` on PATH,
 * else `fallback` (the editor's runtime), whichever is the first new enough. Throws a message for
 * people when none is.
 */
export async function findRuntime(options: {
  configured?: string;
  fallback?: string;
}): Promise<Runtime> {
  const candidates: { command: string; env: Record<string, string> }[] = [];
  if (options.configured) candidates.push({ command: options.configured, env: {} });
  else {
    candidates.push({ command: 'node', env: {} });
    if (options.fallback)
      candidates.push({ command: options.fallback, env: { ELECTRON_RUN_AS_NODE: '1' } });
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    const version = await versionOf(candidate.command, candidate.env);
    if (!version) continue;
    if (supportsCli(version)) return { ...candidate, version };
    found.push(`${candidate.command === 'node' ? 'node' : candidate.command} ${version}`);
  }
  const need = `Node.js ${MIN_NODE.join('.')} or later`;
  throw new CliError(
    options.configured
      ? `The configured Node.js (${options.configured}) ${found.length ? `is ${found[0]}` : 'could not be run'}; API Workbench needs ${need}.`
      : `API Workbench needs ${need} to run its command line${found.length ? `; found ${found.join(', ')}` : ', and none was found on PATH'}. Install it, or set "apiWorkbench.nodePath".`,
    2,
  );
}

/** A failed command: its message (from the command line's standard error) and exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout = '',
  ) {
    super(message);
  }
  /** VS Code's Node.js is too old to load the command line, so it runs in a process of its own. */
  unsupportedRuntime = false;
  /** The run stopped to ask whether to run the requests' scripts. */
  get needsScriptChoice(): boolean {
    return this.code === 2 && /--allow-scripts/.test(this.message);
  }
  /** The send stopped because it goes to a host not yet allowed: that host. */
  get refusedHost(): string | undefined {
    return this.code === 2 ? refusedHost(this.message) : undefined;
  }
}

export interface CliResult {
  stdout: string;
  stderr: string;
  /** 0 when everything passed; 1 when a request or test failed (the output is still complete). */
  code: number;
}

/** Runs the command line with `args`; exit codes 0 and 1 are results, anything else an error. */
export function runCli(
  runtime: Runtime,
  cliPath: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    cwd?: string;
    timeoutMs?: number;
    /** More environment, such as the vault password the person typed. */
    env?: Record<string, string>;
    /** Standard input, such as a pasted cURL command, which may hold a token an argument would show. */
    input?: string;
  } = {},
): Promise<CliResult> {
  if (!existsSync(cliPath))
    return Promise.reject(new CliError(`The command line is missing: ${cliPath}`, 2));
  return new Promise((resolve, reject) => {
    const child = execFile(
      runtime.command,
      [cliPath, ...args],
      {
        cwd: options.cwd,
        // Plain output: the extension reads JSON, and messages show in the editor's own UI.
        env: { ...process.env, ...runtime.env, ...options.env, NO_COLOR: '1' },
        signal: options.signal,
        timeout: options.timeoutMs ?? 0,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        if (code === 0 || code === 1) return resolve({ stdout, stderr, code });
        if (options.signal?.aborted) return reject(new CliError('Cancelled.', 130, stdout));
        const message = stderr.replace(/^api-workbench: /gm, '').trim() || error?.message || '';
        reject(
          new CliError(message || `The command line stopped with exit code ${code}.`, code, stdout),
        );
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Parses the command line's JSON output, explaining what came back when it is not JSON. */
export function parseJson<T>(result: CliResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0];
    throw new CliError(
      `The command line did not answer with JSON${detail ? `: ${detail}` : '.'}`,
      result.code,
    );
  }
}

/** A command that keeps running, such as `mock start`, until it is stopped. */
export interface CliProcess {
  /** Stops it as Ctrl+C would, so it closes its servers. */
  stop(): void;
  /** Resolves with the exit code and the last of its standard error, once it has exited. */
  exited: Promise<{ code: number; message: string }>;
  /** Writes a line to its standard input, for one started with `input` (request connect). */
  write(line: string): void;
}

/** Starts the command line with `args`, giving each line of its output to `onLine`. */
export function startCli(
  runtime: Runtime,
  cliPath: string,
  args: string[],
  onLine: (line: string) => void,
  /** Keep standard input open, to write to it while it runs; more environment, such as a password. */
  options: { input?: boolean; env?: Record<string, string> } = {},
): CliProcess {
  if (!existsSync(cliPath)) {
    return {
      write: () => undefined,
      stop: () => undefined,
      exited: Promise.resolve({ code: 2, message: `The command line is missing: ${cliPath}` }),
    };
  }
  const child = spawn(runtime.command, [cliPath, ...args], {
    env: { ...process.env, ...runtime.env, ...options.env, NO_COLOR: '1' },
    stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Both are piped above, so they are there.
  let pending = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise<{ code: number; message: string }>((resolve) => {
    child.on('error', (error) => resolve({ code: -1, message: error.message }));
    child.on('close', (code) => {
      if (pending) onLine(pending);
      resolve({ code: code ?? 130, message: stderr.replace(/^api-workbench: /gm, '').trim() });
    });
  });
  return {
    write: (line) => {
      if (child.stdin?.writable) child.stdin.write(`${line.replace(/[\r\n]+/g, ' ')}\n`);
    },
    stop: () => {
      // SIGINT lets it stop its servers; Windows has no signals, so there it is ended.
      if (child.exitCode === null) child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    },
    exited,
  };
}

/**
 * How the extension runs the command line's commands: as its own Node.js process (`processEngine`,
 * the default), or loaded into VS Code's extension host and called directly (`builtInEngine`), with
 * no separate process or Node.js. Both give the same results, from the same bundled code.
 */
export interface Engine {
  /** What it runs, for the output channel. */
  readonly description: string;
  run(
    args: string[],
    options?: { signal?: AbortSignal; env?: Record<string, string>; input?: string },
  ): Promise<CliResult>;
  start(
    args: string[],
    onLine: (line: string) => void,
    options?: { input?: boolean; env?: Record<string, string> },
  ): CliProcess;
}

export function processEngine(runtime: Runtime, cliPath: string): Engine {
  return {
    description: `${cliPath} with Node.js ${runtime.version} (${runtime.command})`,
    run: (args, options = {}) => runCli(runtime, cliPath, args, options),
    start: (args, onLine, options = {}) => startCli(runtime, cliPath, args, onLine, options),
  };
}

/** The command line's entry point, as the bundle exports it. */
type Main = (
  argv: readonly string[],
  output: { out(line: string): void; err(line: string): void },
  env: Record<string, string | undefined>,
  terminal: boolean,
  interrupt?: AbortSignal,
  inputs?: {
    stdin?: () => Promise<string>;
    lines?: AsyncIterable<string>;
    password?: () => Promise<string>;
    writeRaw?: (data: Buffer) => void;
  },
) => Promise<number>;

/** Lines written to a running command, handed to it as it asks for them. */
function lineQueue() {
  const waiting: ((value: IteratorResult<string>) => void)[] = [];
  const queued: string[] = [];
  let closed = false;
  return {
    push(line: string) {
      if (closed) return;
      const next = waiting.shift();
      if (next) next({ value: line, done: false });
      else queued.push(line);
    },
    close() {
      closed = true;
      for (const next of waiting.splice(0)) next({ value: undefined, done: true });
    },
    lines: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<string>>((resolve) => {
            if (queued.length) resolve({ value: queued.shift()!, done: false });
            else if (closed) resolve({ value: undefined, done: true });
            else waiting.push(resolve);
          }),
        return: async () => {
          closed = true;
          return { value: undefined, done: true } as IteratorResult<string>;
        },
      }),
    } as AsyncIterable<string>,
  };
}

/**
 * The command line loaded into VS Code's extension host: commands run as calls, not processes,
 * so no Node.js is needed beyond VS Code's own (22.19 or later, as the command line needs). Request
 * scripts still run only in the command line's QuickJS sandbox, here inside the extension host.
 */
export function builtInEngine(
  cliPath: string,
  load: (path: string) => unknown,
  nodeVersion = process.versions.node,
): Engine {
  if (!supportsCli(nodeVersion)) {
    const error = new CliError(
      `Running inside VS Code needs its Node.js to be ${MIN_NODE.join('.')} or later, and this VS Code has ${nodeVersion}.`,
      2,
    );
    error.unsupportedRuntime = true;
    throw error;
  }
  if (!existsSync(cliPath)) throw new CliError(`The command line is missing: ${cliPath}`, 2);
  const { main } = load(cliPath) as { main?: Main };
  if (typeof main !== 'function')
    throw new CliError(`${cliPath} is not the API Workbench command line.`, 2);
  // What a process would see: this one's environment, plain output, and no terminal to prompt in.
  const environment = (env?: Record<string, string>) => ({ ...process.env, ...env, NO_COLOR: '1' });
  const message = (err: string[]) =>
    err
      .join('\n')
      .replace(/^api-workbench: /gm, '')
      .trim();
  const noLines = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ value: '', done: true }) }),
  };
  return {
    description: `the command line inside VS Code (${cliPath}, Node.js ${process.versions.node})`,
    async run(args, options = {}) {
      const out: string[] = [];
      const err: string[] = [];
      let code: number;
      try {
        code = await main(
          args,
          { out: (line) => out.push(line), err: (line) => err.push(line) },
          environment(options.env),
          false,
          options.signal,
          {
            stdin: async () => options.input ?? '',
            lines: noLines as AsyncIterable<string>,
            writeRaw: (data) => out.push(data.toString('utf8')),
          },
        );
      } catch (error) {
        throw new CliError((error as Error).message, -1);
      }
      const stdout = out.length ? `${out.join('\n')}\n` : '';
      if (code === 0 || code === 1) return { stdout, stderr: err.join('\n'), code };
      if (options.signal?.aborted) throw new CliError('Cancelled.', 130, stdout);
      throw new CliError(
        message(err) || `The command line stopped with exit code ${code}.`,
        code,
        stdout,
      );
    },
    start(args, onLine, options = {}) {
      const stop = new AbortController();
      const queue = lineQueue();
      const err: string[] = [];
      const exited = main(
        args,
        { out: onLine, err: (line) => err.push(line) },
        environment(options.env),
        false,
        stop.signal,
        { lines: options.input ? queue.lines : (noLines as AsyncIterable<string>) },
      )
        .then((code) => ({ code, message: message(err) }))
        .catch((error: Error) => ({ code: -1, message: error.message }))
        .finally(() => queue.close());
      return {
        write: (line) => queue.push(line.replace(/[\r\n]+/g, ' ')),
        stop: () => stop.abort(),
        exited,
      };
    },
  };
}
