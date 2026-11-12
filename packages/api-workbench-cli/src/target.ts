import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import { historyFile, putAuth, takeAuth } from '@techieutils/api-workbench-electron/team-files';
import { requestShape, syncRequestsToMocks } from '@techieutils/api-workbench-common/mock-sync';
import type {
  ApiRequest,
  WorkspaceState,
  WorkspaceSummary,
} from '@techieutils/api-workbench-common/types';
import { UsageError, suggest } from './args';
import { completeRequest } from './source';

/**
 * The workspace a command reads and changes: one of the app's own (in its data folder, as the app
 * lists them), or a team workspace folder such as one checked into a repository. Both are read and
 * written through the app's own WorkspaceStore, so files come out exactly as the app writes them,
 * and a running app picks the changes up as it does any change made outside it.
 */

/** Electron's userData folder: productName when packaged, the package name when run from source. */
export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  home = os.homedir(),
): string[] {
  if (env.API_WORKBENCH_DATA_DIR) return [env.API_WORKBENCH_DATA_DIR];
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['API Workbench', 'api-workbench'].map((name) => path.join(base, name));
}

export interface TargetOptions {
  /** The app's data folder; found as the app would when unset. */
  dataDir?: string;
  /** An app workspace by name or id; the active one when unset. */
  workspace?: string;
  /** A team workspace folder, instead of an app workspace. */
  dir?: string;
}
export interface Target {
  /** Where the workspace lives, for messages. */
  kind: 'app workspace' | 'team folder';
  name: string;
  id: string;
  state: WorkspaceState;
  /** The store it came from: app workspaces share it with workspace commands. */
  store: WorkspaceStore;
  dataDir: string;
  /** A team workspace's shared folder, which `team` commands sync with git. */
  folder?: string;
  /** The encrypted credentials file of an app workspace; team folders have none of their own. */
  vaultPath?: string;
  /**
   * Where the vault's key is, when not `dataDir`: the app's data folder, for a team folder that is
   * also open in the app on this device.
   */
  vaultDir?: string;
  /**
   * Opened as a teammate who joins (`--dir`): what it keeps for this device is thrown away, so
   * secret values are refused rather than lost.
   */
  joined?: boolean;
  /**
   * Keeps which saved credential a request or collection uses on this device, for a team folder
   * open in the app: with the app's own secrets for it, never in the shared folder.
   */
  /**
   * Keeps a request's literal auth secrets (a token, password, or secret setting) on this device,
   * for a team folder open in the app: with the app's own secrets for it, never in the folder.
   */
  keepAuthSecrets?(request: ApiRequest): Promise<void>;
  keepCredential?(
    scope: { request: string } | { collection: string },
    credentialId: string | undefined,
  ): Promise<void>;
  save(): Promise<void>;
  close(): Promise<void>;
}

/** What `request` commands need from a target: an app workspace, team folder, or collection file. */
export type RequestTarget = Pick<
  Target,
  'name' | 'state' | 'vaultPath' | 'vaultDir' | 'keepCredential' | 'save'
> & {
  kind: Target['kind'] | 'collection file';
  /** A `.http` file's `< ./path` files, by request id (`Source['fileUploads']`). */
  fileUploads?: import('./source').Source['fileUploads'];
};

export const emptyState = (): WorkspaceState => ({
  requests: [],
  tabs: [],
  environments: [],
  environment: 0,
  history: [],
});

/** A new workspace as the app starts one: a collection with one request, and an environment. */
export function newWorkspaceState(name: string): WorkspaceState {
  const request = completeRequest({
    name: 'Untitled request',
    method: 'GET',
    url: '{{base_url}}',
    folder: 'My collection',
  });
  return {
    requests: [request],
    active: request.id,
    tabs: [request.id],
    environments: [
      {
        name: 'Development',
        variables: [{ key: 'base_url', value: 'https://example.com', enabled: true }],
      },
    ],
    environment: 0,
    history: [],
    // The app fills in its default settings for the rest.
    settings: { workspaceName: name } as WorkspaceState['settings'],
  };
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/** The app's data folder, which must hold the app's workspace index. */
export async function openStore(options: Pick<TargetOptions, 'dataDir'>, env = process.env) {
  const candidates = options.dataDir ? [options.dataDir] : defaultDataDir(env);
  for (const dataDir of candidates)
    if (await exists(path.join(dataDir, 'workspaces.json'))) {
      const store = new WorkspaceStore(path.resolve(dataDir));
      await store.list();
      return { store, dataDir: path.resolve(dataDir) };
    }
  throw new UsageError(
    `No API Workbench data in ${candidates.join(' or ')}. Open the app once, pass --data-dir, or use --dir <team folder>.`,
  );
}

/** A workspace in the app's index by id or name (case does not matter). */
export function findWorkspace(workspaces: WorkspaceSummary[], wanted: string): WorkspaceSummary {
  const found =
    workspaces.find((item) => item.id === wanted) ??
    workspaces.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
  if (!found)
    throw new UsageError(
      `No workspace “${wanted}”.${suggest(
        wanted,
        workspaces.map((item) => item.name),
      )} Workspaces: ${workspaces.map((item) => item.name).join(', ')}.`,
    );
  return found;
}

export async function openTarget(options: TargetOptions, env = process.env): Promise<Target> {
  if (options.dir && options.workspace) throw new UsageError('Use --workspace or --dir, not both.');
  if (options.dir) return openTeamFolder(path.resolve(options.dir), options, env);
  const { store, dataDir } = await openStore(options, env);
  try {
    const index = await store.list();
    const entry = options.workspace
      ? findWorkspace(index.workspaces, options.workspace)
      : findWorkspace(index.workspaces, index.activeId);
    const state = (await store.load(entry.id)) ?? emptyState();
    return {
      kind: entry.folder ? 'team folder' : 'app workspace',
      name: entry.name,
      folder: entry.folder,
      id: entry.id,
      state,
      store,
      dataDir,
      vaultPath: store.vaultPath(entry.id),
      save: mockSyncingSave(state, () => store.save(state, entry.id)),
      close: async () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * A team folder, opened through a store of its own in a temporary folder, as a teammate who joins
 * it would. What a teammate keeps on their own device (their history, secret values) stays in that
 * temporary folder and is removed with it, so the shared folder only ever gets shared files.
 */
async function openTeamFolder(
  folder: string,
  options: TargetOptions = {},
  env = process.env,
): Promise<Target> {
  if (!(await exists(path.join(folder, 'workspace.json'))))
    throw new UsageError(`${folder} has no workspace.json. Give a team workspace folder.`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-'));
  const store = new WorkspaceStore(root);
  let close = async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    await store.list();
    const entry = await store
      .openFolder(folder, emptyState(), 'API Workbench CLI', 'open')
      .catch((error: Error) => {
        throw new UsageError(error.message);
      });
    const member = await store.member();
    const ownHistory = path.join(folder, historyFile(member));
    const state = (await store.load(entry.id)) ?? emptyState();
    // Open in the app on this device too: its credential choices and vault, read from there.
    const linked = await appWorkspaceFor(folder, options, env);
    if (linked) {
      const own = (await linked.store.load(linked.id).catch(() => undefined)) ?? undefined;
      if (own) withCredentialChoices(state, own);
      const previous = close;
      close = async () => {
        linked.store.close();
        await previous();
      };
    }
    return {
      kind: 'team folder',
      name: entry.name,
      id: entry.id,
      folder,
      state,
      store,
      dataDir: root,
      joined: true,
      ...(linked
        ? {
            vaultPath: linked.store.vaultPath(linked.id),
            vaultDir: linked.dataDir,
            keepCredential: (scope, credentialId) =>
              linked.store.setTeamCredential(linked.id, scope, credentialId),
            keepAuthSecrets: async (request: ApiRequest) => {
              const [, secrets] = takeAuth(request);
              await linked.store.setTeamAuthSecrets(linked.id, request.id, {
                token: secrets.token,
                password: secrets.password,
                authOptions: secrets.authOptions,
              });
            },
          }
        : {}),
      save: mockSyncingSave(state, async () => {
        await store.save(state, entry.id);
        // The command line is not a teammate: it leaves no history file of its own behind.
        await fs.rm(ownHistory, { force: true });
      }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The app's workspace for a team folder, when the app on this device has it open: its store (to
 * read and keep this device's credential choices) and the data folder its vault's key is in.
 */
async function appWorkspaceFor(
  folder: string,
  options: TargetOptions,
  env: Record<string, string | undefined>,
): Promise<{ store: WorkspaceStore; dataDir: string; id: string } | undefined> {
  let opened: Awaited<ReturnType<typeof openStore>>;
  try {
    opened = await openStore(options, env);
  } catch {
    return undefined;
  }
  const real = (where: string) => fs.realpath(where).catch(() => path.resolve(where));
  const wanted = await real(folder);
  const index = await opened.store.list();
  for (const entry of index.workspaces)
    if (entry.folder && (await real(entry.folder)) === wanted)
      return { store: opened.store, dataDir: opened.dataDir, id: entry.id };
  opened.store.close();
  return undefined;
}

/** The saved credentials each request and collection uses on this device, from the app's copy. */
function withCredentialChoices(state: WorkspaceState, own: WorkspaceState): void {
  const mine = new Map(own.requests.map((request) => [request.id, request]));
  for (const [at, request] of state.requests.entries()) {
    const theirs = mine.get(request.id);
    if (!theirs) continue;
    // This device's secrets for it, as the app keeps them: a token, a password, a credential.
    const [, secrets] = takeAuth(theirs);
    state.requests[at] = putAuth(request, secrets);
  }
  for (const [name, auth] of Object.entries(state.collectionAuth ?? {})) {
    const theirs =
      own.collectionAuth && Object.hasOwn(own.collectionAuth, name)
        ? own.collectionAuth[name]
        : undefined;
    if (theirs?.credentialId && auth.auth === 'Saved credential')
      auth.credentialId = theirs.credentialId;
  }
}

/**
 * A save that first brings mock servers made from collections in step with the requests added
 * or changed since the workspace was opened — by any command: create, update, import, a
 * specification — as the app does on each save.
 */
function mockSyncingSave(state: WorkspaceState, save: () => Promise<void>): () => Promise<void> {
  let seen = new Map(state.requests.map((request) => [request.id, requestShape(request)]));
  return async () => {
    syncRequestsToMocks(state.mocks ?? [], state.requests, seen);
    seen = new Map(state.requests.map((request) => [request.id, requestShape(request)]));
    await save();
  };
}
