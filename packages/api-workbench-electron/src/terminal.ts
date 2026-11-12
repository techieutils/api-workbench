import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type {
  TerminalEvent,
  TerminalSession,
  TerminalShell,
} from '@techieutils/api-workbench-common/types';

type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | undefined;
/** node-pty is native; it loads on the first terminal so a missing build never stops the app. */
function loadPty(): PtyModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (ptyModule ??= require('node-pty') as PtyModule);
}

/** The person's login shell, or the platform's usual one. */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

/** A shell the terminal can run: what menus show, and how it is started. */
export interface ShellChoice extends TerminalShell {
  args: string[];
}
/** Whether an executable exists at `file`, or (for a bare name) in one of PATH's folders. */
function findExecutable(
  file: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | undefined {
  if (file.includes('/') || file.includes('\\')) return exists(file) ? file : undefined;
  const separator = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const folder of pathValue.split(separator).filter(Boolean)) {
    const candidate = join(folder, file);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
const isFile = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
/**
 * The shells installed here, the default first among them marked: on macOS and Linux the login
 * shell, zsh, bash, sh, and fish where present; on Windows PowerShell, PowerShell 7, and Command
 * Prompt. Only these can be started, never a path the renderer sends.
 */
export function availableShells(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = isFile,
): ShellChoice[] {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    const shells: ShellChoice[] = [
      {
        id: 'powershell',
        label: 'Windows PowerShell',
        path: 'powershell.exe',
        args: ['-NoLogo'],
        default: true,
      },
    ];
    const pwsh = findExecutable('pwsh.exe', platform, env, exists);
    if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] });
    shells.push({
      id: 'cmd',
      label: 'Command Prompt',
      path: env.ComSpec || path.win32.join(systemRoot, 'System32', 'cmd.exe'),
      args: [],
    });
    const gitBash = ['ProgramFiles', 'ProgramW6432']
      .map((key) => env[key])
      .filter((folder): folder is string => Boolean(folder))
      .map((folder) => path.win32.join(folder, 'Git', 'bin', 'bash.exe'))
      .find(exists);
    if (gitBash)
      shells.push({ id: 'git-bash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'] });
    const wsl = findExecutable('wsl.exe', platform, env, exists);
    if (wsl) shells.push({ id: 'wsl', label: 'WSL', path: wsl, args: [] });
    return shells;
  }
  const login = env.SHELL && exists(env.SHELL) ? env.SHELL : undefined;
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const candidates = ['zsh', 'bash', 'sh', 'fish'];
  const shells: ShellChoice[] = [];
  const seen = new Set<string>();
  const add = (file: string, isDefault: boolean) => {
    const name = path.posix.basename(file);
    if (seen.has(name)) return;
    seen.add(name);
    shells.push({
      id: name,
      label: name,
      path: file,
      args: ['-l'],
      ...(isDefault ? { default: true } : {}),
    });
  };
  if (login) add(login, true);
  for (const name of candidates) {
    const found =
      [
        `/bin/${name}`,
        `/usr/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
      ].find(exists) ?? findExecutable(name, platform, env, exists);
    if (found) add(found, !login && found === fallback);
  }
  if (shells.length && !shells.some((shell) => shell.default)) shells[0].default = true;
  return shells;
}
/** The shell's environment: the app's, without Electron's own switches, as a colour terminal. */
export function terminalEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !key.startsWith('ELECTRON_')) result[key] = value;
  return {
    ...result,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'API Workbench',
  };
}

const dimension = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000
    ? value
    : fallback;

/** Pseudo-terminal sessions, each owned by the renderer that started it. */
export class TerminalSessions {
  private readonly sessions = new Map<
    string,
    { owner: number; pty: IPty; stopping: boolean; ended: Promise<void> }
  >();

  constructor(private readonly emit: (owner: number, event: TerminalEvent) => void) {}

  /** The shells found here, cached: they do not change while the app runs. */
  private shellList?: ShellChoice[];
  shells(): TerminalShell[] {
    this.shellList ??= availableShells();
    return this.shellList.map(({ args: _args, ...shell }) => shell);
  }
  start(
    owner: number,
    size: { cols?: unknown; rows?: unknown },
    shellId?: unknown,
  ): TerminalSession {
    this.shellList ??= availableShells();
    if (shellId !== undefined && typeof shellId !== 'string') throw new Error('Invalid shell.');
    const chosen = shellId
      ? this.shellList.find((shell) => shell.id === shellId)
      : this.shellList.find((shell) => shell.default);
    if (shellId && !chosen) throw new Error('That shell is not available on this computer.');
    const shell = chosen ? { file: chosen.path, args: chosen.args } : defaultShell();
    const cwd = os.homedir();
    const pty = loadPty().spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: dimension(size?.cols, 80),
      rows: dimension(size?.rows, 24),
      cwd,
      env: terminalEnvironment(),
    });
    const id = randomUUID();
    let ended!: () => void;
    this.sessions.set(id, {
      owner,
      pty,
      stopping: false,
      ended: new Promise((resolve) => (ended = resolve)),
    });
    pty.onData((data) => this.emit(owner, { id, type: 'data', data }));
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      ended();
      this.emit(owner, { id, type: 'exit', exitCode });
    });
    return { id, shell: path.basename(shell.file), cwd };
  }
  private owned(owner: number, id: unknown): IPty {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session || session.stopping || session.owner !== owner)
      throw new Error('That terminal has ended.');
    return session.pty;
  }
  write(owner: number, id: unknown, data: unknown): void {
    if (typeof data !== 'string' || data.length > 1_000_000) throw new Error('Invalid input.');
    this.owned(owner, id).write(data);
  }
  resize(owner: number, id: unknown, cols: unknown, rows: unknown): void {
    const pty = this.owned(owner, id);
    pty.resize(dimension(cols, pty.cols), dimension(rows, pty.rows));
  }
  stop(owner: number, id: unknown): void {
    if (typeof id === 'string' && this.sessions.has(id)) this.owned(owner, id).kill();
  }
  /** Whether any shell is still running or has yet to report its exit. */
  get size(): number {
    return this.sessions.size;
  }
  /**
   * Ends every session, such as when the window reloads or closes, and resolves once each shell
   * has exited (or after `timeoutMs`). node-pty aborts the process if a shell's exit arrives
   * while the app is shutting down, so quitting waits for this.
   */
  stopAll(timeoutMs = 2000): Promise<void> {
    const ended = [...this.sessions.values()].map((session) => {
      if (!session.stopping) {
        session.stopping = true;
        session.pty.kill();
      }
      return session.ended;
    });
    if (!ended.length) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.all(ended).then(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]).finally(() => clearTimeout(timer));
  }
}
