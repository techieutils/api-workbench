import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  GitChange,
  GitChangeKind,
  GitConflictChoice,
  TeamGitResult,
  TeamGitStatus,
  TeamMember,
} from '@techieutils/api-workbench-common/types';
import {
  gitRemoteProblem,
  withoutCredentials,
} from '@techieutils/api-workbench-common/share-links';
import { PRESENCE_DIRECTORY, TEAM_FORMAT } from './team-files';

/**
 * Git sync for team folders: status, commit, pull, push, connecting a folder to a remote, and
 * cloning. It runs the installed `git` with fixed arguments (never a shell, never a command from
 * the app), so it signs in the way git already does on this computer: SSH keys or the credential
 * manager. The app never sees or stores a token.
 *
 * Commits cover only the team folder, so a team folder inside a code repository leaves the rest of
 * the repository's changes alone. Pulls merge; when the same files changed on both sides the merge
 * is undone and the files are reported, and the person chooses whose changes win. Repository
 * hooks do not run.
 */

const LOCAL_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 180_000;
const MAX_CHANGES = 200;
const DEFAULT_MESSAGE = 'Update API collections';
/** What the team folder's .gitignore must hold: presence files change every few seconds. */
const IGNORED = `${PRESENCE_DIRECTORY.split('/')[0]}/`;

export class GitError extends Error {}

/** `['committed', 'pulled', 'pushed']` → `Committed, pulled, and pushed.` */
function sentence(steps: string[]): string {
  const text =
    steps.length < 3
      ? steps.join(' and ')
      : `${steps.slice(0, -1).join(', ')}, and ${steps.at(-1)}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Settings that make git safe to run on a folder the person may not fully control. */
const SAFETY = [
  // A repository's config could name a program to run on every status.
  '-c',
  'core.fsmonitor=false',
  // Transports that run commands from the URL itself.
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.fd.allow=never',
  // Hooks are programs in the repository; in a synced folder anyone could have put them there.
  '-c',
  `core.hooksPath=${path.join(__dirname, 'no-git-hooks')}`,
];

/** The environment git runs in: no prompts in a terminal that is not there, and stable messages. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANGUAGE: 'C',
  };
  // Apps opened from the Finder get a short PATH; Homebrew's git lives outside it.
  if (process.platform === 'darwin')
    env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
  return env;
}

/** git's error, without credentials, shortened, and explained for the usual causes. */
function explain(stderr: string, fallback: string): string {
  const text = withoutCredentials(stderr).trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled|403/i.test(text))
    return 'Git could not sign in to the remote. Sign in once in a terminal (for example, run git fetch in the folder) or set up your credential manager or SSH key, then try again.';
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(text))
    return 'The remote refused your SSH key. Check that your key is added to your Git host and to ssh-agent, then try again.';
  if (
    /Repository not found|does not appear to be a git repository|repository '[^']*' not found/i.test(
      text,
    )
  )
    return 'The repository was not found, or you do not have access to it.';
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(text))
    return 'The remote has changes you do not have yet. Pull first.';
  if (/Could not resolve host|unable to access|Connection refused|timed out/i.test(text))
    return `Could not reach the remote. ${text.split('\n').at(-1)}`;
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^(fatal|error): /, ''))
    .filter((line) => line && !line.startsWith('hint:'));
  return (lines.slice(-3).join(' ') || fallback).slice(0, 600);
}

/** Paths in porcelain output are relative to the repository; the panel shows them in the team folder. */
function changeKind(code: string): GitChangeKind {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

export interface TeamGitOptions {
  /** The git program; `git` from PATH by default. */
  program?: string;
}

export class TeamGit {
  private queue: Promise<unknown> = Promise.resolve();
  private versionText?: string | null;
  constructor(private readonly options: TeamGitOptions = {}) {}

  /** Runs git in `cwd`; rejects with git's explained error. */
  private run(
    cwd: string,
    args: string[],
    { timeout = LOCAL_TIMEOUT, identity }: { timeout?: number; identity?: string[] } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.options.program ?? 'git',
        [...SAFETY, ...(identity ?? []), ...args],
        {
          cwd,
          env: gitEnvironment(),
          timeout,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return reject(
              new GitError(
                'Git is not installed or not found. Install Git from git-scm.com, then try again.',
              ),
            );
          if (error.killed)
            return reject(new GitError('Git took too long and was stopped. Try again.'));
          reject(new GitError(explain(stderr || error.message, 'Git failed.')));
        },
      );
    });
  }
  /** Runs one operation at a time, so two clicks never run git on the same folder at once. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.catch(() => {});
    return task;
  }

  /** git's version, or null when it is not installed. */
  private async version(): Promise<string | null> {
    if (this.versionText !== undefined) return this.versionText;
    try {
      const text = await this.run(process.cwd(), ['--version']);
      this.versionText = /(\d+\.\d+(\.\d+)?)/.exec(text)?.[1] ?? text.trim();
    } catch {
      // Checked again next time: the person may install git while the app is open.
      return null;
    }
    return this.versionText;
  }

  private async requireGit(): Promise<void> {
    if (!(await this.version()))
      throw new GitError(
        'Git is not installed or not found. Install Git from git-scm.com, then try again.',
      );
  }
  private async inRepository(folder: string): Promise<boolean> {
    try {
      return (await this.run(folder, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch {
      return false;
    }
  }
  private async remoteURL(folder: string): Promise<string | undefined> {
    try {
      const remote = (await this.run(folder, ['remote'])).split('\n').filter(Boolean);
      const name = remote.includes('origin') ? 'origin' : remote[0];
      return name ? (await this.run(folder, ['remote', 'get-url', name])).trim() : undefined;
    } catch {
      return undefined;
    }
  }
  private async remoteName(folder: string): Promise<string | undefined> {
    const remote = (await this.run(folder, ['remote'])).split('\n').filter(Boolean);
    return remote.includes('origin') ? 'origin' : remote[0];
  }

  private async readStatus(folder: string): Promise<TeamGitStatus> {
    const version = await this.version();
    const empty = { ahead: 0, behind: 0, changes: [], changeCount: 0 };
    if (!version) return { available: false, repository: false, ...empty };
    if (!(await this.inRepository(folder)))
      return { available: true, version, repository: false, ...empty };
    // Written now rather than at the first commit, so the list shows what a commit will hold.
    await this.ignorePresence(folder);
    const prefix = (await this.run(folder, ['rev-parse', '--show-prefix'])).trim();
    const output = await this.run(folder, [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v1',
      '--branch',
      '--untracked-files=all',
      '-z',
      '--',
      '.',
    ]);
    const records = output.split('\0');
    let branch: string | undefined;
    let upstream: string | undefined;
    let ahead = 0,
      behind = 0;
    const changes: GitChange[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      if (record.startsWith('## ')) {
        const header = record.slice(3);
        const match =
          /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(
            header,
          );
        branch = match?.[1]?.startsWith('HEAD (no branch)') ? undefined : match?.[1];
        upstream = match?.[2];
        ahead = Number(/ahead (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
        behind = Number(/behind (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
        continue;
      }
      const code = record.slice(0, 2);
      // A rename's record is followed by its old path.
      if (code.includes('R') || code.includes('C')) index++;
      const file = record.slice(3);
      changes.push({
        path: file.startsWith(prefix) ? file.slice(prefix.length) : file,
        kind: changeKind(code),
      });
    }
    const remote = await this.remoteURL(folder);
    return {
      available: true,
      version,
      repository: true,
      branch,
      remote: remote ? withoutCredentials(remote) : undefined,
      upstream,
      ahead,
      behind,
      changes: changes.slice(0, MAX_CHANGES),
      changeCount: changes.length,
    };
  }
  status(folder: string): Promise<TeamGitStatus> {
    return this.serial(() => this.readStatus(folder));
  }

  /**
   * Your name on commits: git's own setting when there is one, otherwise your team name, so a
   * first commit works on a computer where git was never set up.
   */
  private async identity(folder: string, member: TeamMember): Promise<string[]> {
    const read = (key: string) =>
      this.run(folder, ['config', '--get', key]).then(
        (value) => value.trim(),
        () => '',
      );
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return [
      ...(name ? [] : ['-c', `user.name=${member.name.replace(/[<>\n]/g, '') || 'API Workbench'}`]),
      ...(email ? [] : ['-c', `user.email=${member.id}@users.noreply.api-workbench.invalid`]),
    ];
  }
  /** Keeps presence files out of commits; they change every few seconds. */
  private async ignorePresence(folder: string): Promise<void> {
    const file = path.join(folder, '.gitignore');
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (
      text.split(/\r?\n/).some((line) => line.trim() === IGNORED || line.trim() === `/${IGNORED}`)
    )
      return;
    await fs.writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${IGNORED}\n`);
  }
  /** Commits the team folder's changes; false when there were none. */
  private async commitChanges(
    folder: string,
    message: string,
    member: TeamMember,
  ): Promise<boolean> {
    await this.ignorePresence(folder);
    await this.run(folder, ['add', '--all', '--', '.']);
    const staged = await this.run(folder, ['diff', '--cached', '--name-only', '--', '.']);
    if (!staged.trim()) return false;
    await this.run(folder, ['commit', '-m', message, '--', '.'], {
      identity: await this.identity(folder, member),
    });
    return true;
  }
  private async conflicts(folder: string): Promise<string[]> {
    const prefix = (await this.run(folder, ['rev-parse', '--show-prefix'])).trim();
    return (await this.run(folder, ['diff', '--name-only', '--diff-filter=U']))
      .split('\n')
      .filter(Boolean)
      .map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file));
  }
  /**
   * Pulls the current branch; with `choice`, files changed on both sides take that side. A merge
   * that stops on conflicts is undone and its files returned. Nothing to pull from (an empty
   * remote, or a branch not pushed yet) is not an error.
   */
  private async pullChanges(
    folder: string,
    member: TeamMember,
    choice?: GitConflictChoice,
  ): Promise<{ pulled: boolean; conflicts?: string[] }> {
    await this.requireGit();
    const status = await this.readStatus(folder);
    if (!status.branch) throw new GitError('Check out a branch in the team folder first.');
    const remote = await this.remoteName(folder);
    if (!remote) throw new GitError('Connect the team folder to a remote first.');
    let target: string[] = [];
    // The remote branch may not exist yet: an empty remote, or a clone of an empty repository,
    // which names an upstream that nobody has pushed.
    const upstreamRemote = status.upstream?.split('/')[0];
    const pullRemote =
      upstreamRemote && upstreamRemote !== status.upstream ? upstreamRemote : remote;
    const remoteBranch = status.upstream
      ? status.upstream.slice(pullRemote.length + 1)
      : status.branch;
    const heads = await this.run(folder, ['ls-remote', '--heads', pullRemote, remoteBranch], {
      timeout: NETWORK_TIMEOUT,
    });
    if (!heads.trim()) return { pulled: false };
    if (!status.upstream) target = [remote, status.branch];
    const strategy = choice ? ['-X', choice === 'mine' ? 'ours' : 'theirs'] : [];
    try {
      await this.run(
        folder,
        [
          'pull',
          '--no-rebase',
          '--autostash',
          '--no-edit',
          '--allow-unrelated-histories',
          ...strategy,
          ...target,
        ],
        { timeout: NETWORK_TIMEOUT, identity: await this.identity(folder, member) },
      );
    } catch (error) {
      const files = await this.conflicts(folder).catch(() => []);
      if (!files.length) throw error;
      await this.run(folder, ['merge', '--abort']).catch(() => {});
      return { pulled: false, conflicts: files };
    }
    return { pulled: true };
  }
  private async pushChanges(folder: string): Promise<void> {
    await this.requireGit();
    const status = await this.readStatus(folder);
    if (!status.branch) throw new GitError('Check out a branch in the team folder first.');
    const remote = await this.remoteName(folder);
    if (!remote) throw new GitError('Connect the team folder to a remote first.');
    await this.run(
      folder,
      status.upstream ? ['push'] : ['push', '--set-upstream', remote, status.branch],
      { timeout: NETWORK_TIMEOUT },
    );
  }

  private async result(
    folder: string,
    message: string,
    conflicts?: string[],
  ): Promise<TeamGitResult> {
    return {
      status: await this.readStatus(folder),
      message,
      ...(conflicts?.length ? { conflicts } : {}),
    };
  }
  private checkMessage(message: unknown): string {
    if (message !== undefined && typeof message !== 'string')
      throw new GitError('Enter a commit message.');
    const text = (message ?? '').trim().replace(/\r\n?/g, '\n');
    if (text.length > 2000)
      throw new GitError('Use a commit message of 2,000 characters or fewer.');
    return text || DEFAULT_MESSAGE;
  }
  private checkChoice(choice: unknown): GitConflictChoice | undefined {
    if (choice === undefined || choice === null) return undefined;
    if (choice !== 'mine' && choice !== 'theirs') throw new GitError('Choose mine or theirs.');
    return choice;
  }

  commit(folder: string, message: unknown, member: TeamMember): Promise<TeamGitResult> {
    return this.serial(async () => {
      const text = this.checkMessage(message);
      await this.requireGit();
      if (!(await this.inRepository(folder)))
        throw new GitError('The team folder is not a Git repository yet. Connect it first.');
      const committed = await this.commitChanges(folder, text, member);
      return this.result(folder, committed ? 'Committed your changes.' : 'Nothing to commit.');
    });
  }
  pull(folder: string, member: TeamMember, choice?: unknown): Promise<TeamGitResult> {
    return this.serial(async () => {
      const outcome = await this.pullChanges(folder, member, this.checkChoice(choice));
      return this.result(
        folder,
        outcome.conflicts
          ? 'Some files changed both here and on the remote. Choose whose changes to keep.'
          : outcome.pulled
            ? 'Pulled the latest changes.'
            : 'Nothing to pull yet.',
        outcome.conflicts,
      );
    });
  }
  push(folder: string): Promise<TeamGitResult> {
    return this.serial(async () => {
      await this.pushChanges(folder);
      return this.result(folder, 'Pushed your commits.');
    });
  }
  /** Commit, pull, and push: what a person means by “sync”. */
  sync(
    folder: string,
    message: unknown,
    member: TeamMember,
    choice?: unknown,
  ): Promise<TeamGitResult> {
    return this.serial(async () => {
      const text = this.checkMessage(message);
      const side = this.checkChoice(choice);
      await this.requireGit();
      if (!(await this.inRepository(folder)))
        throw new GitError('The team folder is not a Git repository yet. Connect it first.');
      const committed = await this.commitChanges(folder, text, member);
      const outcome = await this.pullChanges(folder, member, side);
      if (outcome.conflicts)
        return this.result(
          folder,
          `${committed ? 'Committed your changes, but some' : 'Some'} files changed both here and on the remote. Choose whose changes to keep.`,
          outcome.conflicts,
        );
      await this.pushChanges(folder);
      return this.result(
        folder,
        sentence([
          ...(committed ? ['committed your changes'] : []),
          ...(outcome.pulled ? ['pulled'] : []),
          'pushed',
        ]),
      );
    });
  }

  /**
   * Connects the team folder to a remote: makes it a repository when it is not inside one, adds
   * the remote, commits the folder, takes what the remote already has, and pushes.
   */
  connect(folder: string, url: unknown, member: TeamMember): Promise<TeamGitResult> {
    return this.serial(async () => {
      const remoteURL = typeof url === 'string' ? url.trim() : '';
      const problem = gitRemoteProblem(remoteURL);
      if (problem) throw new GitError(problem);
      await this.requireGit();
      if (!(await this.inRepository(folder)))
        await this.run(folder, ['-c', 'init.defaultBranch=main', 'init']);
      const existing = await this.remoteName(folder);
      if (existing && existing !== 'origin')
        throw new GitError(`The repository already has a remote, “${existing}”.`);
      await this.run(
        folder,
        existing
          ? ['remote', 'set-url', 'origin', remoteURL]
          : ['remote', 'add', 'origin', remoteURL],
      );
      // An empty remote has no HEAD; one with commits names its default branch.
      const head = await this.run(folder, ['ls-remote', '--symref', 'origin', 'HEAD'], {
        timeout: NETWORK_TIMEOUT,
      });
      const remoteBranch = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(head)?.[1];
      const hasCommits = await this.run(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
        () => true,
        () => false,
      );
      // A new repository takes the remote's branch name, so the histories meet on one branch.
      if (!hasCommits && remoteBranch)
        await this.run(folder, ['symbolic-ref', 'HEAD', `refs/heads/${remoteBranch}`]);
      await this.commitChanges(folder, 'Share API collections', member);
      const outcome = await this.pullChanges(folder, member);
      if (outcome.conflicts)
        return this.result(
          folder,
          'The remote already has some of these files. Choose whose changes to keep.',
          outcome.conflicts,
        );
      await this.pushChanges(folder);
      return this.result(folder, 'Connected and pushed the team folder.');
    });
  }

  /**
   * Clones `url` into a new folder named `name` inside `parent`, and returns its path. The folder
   * must not exist yet, or be empty.
   */
  clone(url: unknown, parent: string, name: string): Promise<string> {
    return this.serial(async () => {
      const remoteURL = typeof url === 'string' ? url.trim() : '';
      const problem = gitRemoteProblem(remoteURL);
      if (problem) throw new GitError(problem);
      await this.requireGit();
      const target = path.join(parent, name);
      const entries = await fs.readdir(target).catch(() => undefined);
      if (entries?.length)
        throw new GitError(
          `${target} already exists and is not empty. Choose another location, or open that folder with Open team folder.`,
        );
      await this.run(parent, ['clone', '--', remoteURL, name], { timeout: NETWORK_TIMEOUT });
      return target;
    });
  }
}

/**
 * Team workspaces in a clone, nearest first: its own folder, then folders up to three levels down
 * (skipping hidden ones and node_modules), so a repository with its API folder at `./api` works.
 */
export async function findTeamFolders(root: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  for (let current = 0; current <= depth && level.length && found.length < 20; current++) {
    const next: string[] = [];
    for (const folder of level) {
      const text = await fs.readFile(path.join(folder, 'workspace.json'), 'utf8').catch(() => '');
      try {
        if (text && (JSON.parse(text) as { storage?: string }).storage === TEAM_FORMAT) {
          found.push(folder);
          // A team folder's own subfolders are its collections, not more workspaces.
          continue;
        }
      } catch {
        /* Not a team workspace. */
      }
      const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries)
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
          next.push(path.join(folder, entry.name));
    }
    level = next.slice(0, 500);
  }
  return found;
}
