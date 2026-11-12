import { defineStore } from 'pinia';
import { nextTick, shallowReactive } from 'vue';
import type {
  GitConflictChoice,
  TeamGitBridge,
  TeamGitResult,
  TeamGitStatus,
} from '@techieutils/api-workbench-common/types';
import { gitRemoteProblem } from '@techieutils/api-workbench-common/share-links';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { useWorkspacesStore } from './workspaces';

type Operation = 'connect' | 'commit' | 'pull' | 'push' | 'sync';

/**
 * Git sync for the open team workspace, shown in the workspace manager: the folder's repository
 * status, connecting it to a remote, and commit, pull, push, and sync. Git itself runs in the main
 * process; this store only holds what the panel shows.
 */
export const useTeamGitStore = defineStore('team-git', () => {
  const git = shallowReactive({
    status: null as TeamGitStatus | null,
    loading: false,
    busy: '' as '' | Operation,
    error: '',
    /** Files changed both here and on the remote, from the last pull, until resolved. */
    conflicts: [] as string[],
    /** What was being done when the conflict came up, to repeat it with a side chosen. */
    conflictDuring: '' as '' | 'pull' | 'sync',
    remoteURL: '',
    remoteError: '',
    message: '',
  });
  const bridge = (): TeamGitBridge | undefined => window.workbench?.workspaces.git;
  const available = () => Boolean(bridge());

  /**
   * Each status request's number: only the latest one's answer is shown, so a request started for
   * the previous workspace, or before an operation, never overwrites a newer status.
   */
  let sequence = 0;
  async function refresh(): Promise<void> {
    const api = bridge();
    if (!api) return;
    const current = ++sequence;
    git.loading = true;
    render();
    try {
      const status = await api.status();
      if (current !== sequence) return;
      git.status = status;
      git.error = '';
    } catch (error) {
      if (current === sequence) git.error = errorMessage(error);
    } finally {
      if (current === sequence) {
        git.loading = false;
        render();
      }
    }
  }
  /** Forgets the last workspace's repository when another workspace opens. */
  function reset(): void {
    sequence++;
    Object.assign(git, {
      status: null,
      loading: false,
      error: '',
      conflicts: [],
      conflictDuring: '',
      remoteURL: '',
      remoteError: '',
      message: '',
    });
  }

  async function run(
    kind: Operation,
    operation: (api: TeamGitBridge) => Promise<TeamGitResult>,
  ): Promise<void> {
    const api = bridge();
    if (!api || git.busy) return;
    git.busy = kind;
    git.error = '';
    render();
    try {
      // Unsaved edits go to the folder first, so they are part of the commit.
      await useWorkspacesStore().flush();
      const result = await operation(api);
      sequence++;
      git.loading = false;
      git.status = result.status;
      git.conflicts = result.conflicts ?? [];
      git.conflictDuring = result.conflicts?.length ? (kind === 'sync' ? 'sync' : 'pull') : '';
      if (!result.conflicts?.length && (kind === 'commit' || kind === 'sync' || kind === 'connect'))
        git.message = '';
      if (kind === 'connect' && !result.conflicts?.length) git.remoteURL = '';
      toast(result.message, result.conflicts?.length ? 'warning' : 'success');
      // The choice is in the panel, which may be scrolled out of view.
      if (result.conflicts?.length)
        void nextTick(() =>
          document
            .querySelector('[data-team-git-conflicts]')
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
        );
    } catch (error) {
      git.error = errorMessage(error);
      // What git did before failing (a commit before a failed push) shows in the status.
      void refresh();
    } finally {
      git.busy = '';
      render();
    }
  }

  function connect(): void {
    git.remoteError = gitRemoteProblem(git.remoteURL);
    if (git.remoteError) {
      render();
      document.querySelector<HTMLInputElement>('#team-git-remote')?.focus();
      return;
    }
    void run('connect', (api) => api.connect(git.remoteURL.trim()));
  }
  const commit = () => void run('commit', (api) => api.commit(git.message));
  const pull = (choice?: GitConflictChoice) => void run('pull', (api) => api.pull(choice));
  const push = () => void run('push', (api) => api.push());
  const sync = (choice?: GitConflictChoice) =>
    void run('sync', (api) => api.sync(git.message, choice));
  /** Repeats the pull or sync that conflicted, with files changed on both sides taking `choice`. */
  function resolve(choice: GitConflictChoice): void {
    if (git.conflictDuring === 'sync') sync(choice);
    else pull(choice);
  }
  function dismissConflicts(): void {
    git.conflicts = [];
    git.conflictDuring = '';
    render();
  }

  return {
    git,
    available,
    refresh,
    reset,
    connect,
    commit,
    pull,
    push,
    sync,
    resolve,
    dismissConflicts,
  };
});
