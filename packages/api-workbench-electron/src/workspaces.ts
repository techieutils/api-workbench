import { normalizedSnippets } from '@techieutils/api-workbench-common/script-snippets';
import { normalizedScripts } from '@techieutils/api-workbench-common/scripts';
import fs from 'node:fs/promises';
import { constants as fsConstants, existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  TeamMember,
  WorkspaceChange,
  WorkspaceIndexChange,
  WorkspaceIndex,
  WorkspaceState,
  WorkspaceStorageInfo,
  WorkspaceSummary,
} from '@techieutils/api-workbench-common/types';
import {
  COLLECTIONS_DIRECTORY,
  collectionFiles,
  readCollectionFiles,
  syncCollectionFiles,
  writeAtomically,
  writeCollectionFile,
  type CollectionFiles,
} from './collection-files';
import {
  ENVIRONMENTS_DIRECTORY,
  HISTORY_DIRECTORY,
  TEAM_FORMAT,
  environmentFiles,
  historyFile,
  historyText,
  joinTeamState,
  readTeamFiles,
  splitTeamState,
  type AuthSecrets,
  type TeamLocalFile,
  type TeamWorkspaceFile,
} from './team-files';
import {
  MOCKS_DIRECTORY,
  SCRIPTS_DIRECTORY,
  SPECS_DIRECTORY,
  apiFiles,
  readApiFiles,
  type SpecEntry,
} from './api-files';

/** The workspace file, once collections live in their own files beside it. */
interface WorkspaceFile extends Omit<WorkspaceState, 'requests' | 'specs' | 'mocks'> {
  storage: 'collections';
  /** Each specification's id, name, and linked collection; the text is in its own file. */
  specFiles?: SpecEntry[];
  specs?: never;
  mocks?: never;
  /** Collection directory names, in explorer order. */
  collectionOrder: string[];
  /** Saved responses by request id, kept here so request files hold only definitions. */
  responses?: Record<string, WorkspaceState['requests'][number]['response']>;
  requests?: never;
}
function validId(id: unknown): asserts id is string {
  if (
    typeof id !== 'string' ||
    !/^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(id)
  )
    throw new Error('Invalid workspace ID.');
}
function workspaceName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60)
    throw new Error('Enter a workspace name of 1–60 characters.');
  return value.trim();
}
function validateState(state: WorkspaceState): void {
  if (
    !state ||
    !Array.isArray(state.requests) ||
    !state.requests.length ||
    !Array.isArray(state.environments) ||
    !state.environments.length ||
    !Array.isArray(state.tabs)
  )
    throw new Error('Invalid workspace data. Existing files were preserved.');
  if (
    state.requests.some(
      (request) =>
        !request ||
        typeof request.id !== 'string' ||
        typeof request.name !== 'string' ||
        typeof request.url !== 'string' ||
        typeof request.folder !== 'string' ||
        !Array.isArray(request.headers) ||
        !Array.isArray(request.params),
    )
  )
    throw new Error('Invalid workspace requests. Existing files were preserved.');
  if (
    state.environments.some(
      (environment) =>
        !environment ||
        typeof environment.name !== 'string' ||
        !Array.isArray(environment.variables),
    )
  )
    throw new Error('Invalid workspace environments. Existing files were preserved.');
}
/** `{ [key]: value }` when the map has entries, so empty maps are left out as before. */
/** How often an open team folder is checked for teammates' changes. */
const TEAM_POLL_MS = 5000;
const withEntries = <K extends string, V>(key: K, value: Record<string, V>) =>
  (Object.keys(value).length ? { [key]: value } : {}) as Partial<Record<K, Record<string, V>>>;
/** Files about to be written or removed whose content on disk is no longer what the app last saw. */
async function externallyChanged(
  directory: string,
  previous: CollectionFiles,
  next: CollectionFiles,
): Promise<Set<string>> {
  const changed = new Set<string>();
  for (const [file, seen] of previous) {
    if (next.get(file) === seen) continue;
    const now = await fs.readFile(path.join(directory, file), 'utf8').catch(() => undefined);
    // A file removed outside the app is written again; one edited there is kept.
    if (now !== undefined && now !== seen) changed.add(file);
  }
  return changed;
}

/** Checks a workspace index read from disk; the message says what is wrong. */
function validateIndex(index: WorkspaceIndex): void {
  if (!index || index.version !== 1 || !Array.isArray(index.workspaces) || !index.workspaces.length)
    throw new Error('Invalid workspace index. Existing files were preserved.');
  const ids = new Set<string>();
  for (const item of index.workspaces) {
    validId(item.id);
    workspaceName(item.name);
    if (ids.has(item.id)) throw new Error('Duplicate workspace IDs.');
    if (
      item.folder !== undefined &&
      (typeof item.folder !== 'string' || !path.isAbsolute(item.folder))
    )
      throw new Error('A team workspace folder must be an absolute path.');
    if (item.folder !== undefined && item.id === 'default')
      throw new Error('The default workspace cannot be a team workspace.');
    if (
      item.location !== undefined &&
      (typeof item.location !== 'string' ||
        !path.isAbsolute(item.location) ||
        item.folder !== undefined ||
        item.id === 'default')
    )
      throw new Error('A workspace location must be an absolute path, for a workspace of its own.');
    ids.add(item.id);
  }
  if (
    index.member !== undefined &&
    (!/^[0-9a-f-]{36}$/.test(String(index.member?.id)) || typeof index.member?.name !== 'string')
  )
    throw new Error('Invalid team member in the workspace index.');
  if (!ids.has(index.activeId)) throw new Error('Active workspace is missing from the index.');
  if (
    index.storageFolder !== undefined &&
    (typeof index.storageFolder !== 'string' || !path.isAbsolute(index.storageFolder))
  )
    throw new Error('The storage folder must be an absolute path.');
}

export class WorkspaceStore {
  private index: WorkspaceIndex | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Each workspace's collection files as last read or written, so saves only touch changes. */
  private files = new Map<string, CollectionFiles>();
  /** Each workspace's folder paths and the directories they are saved in. */
  private directories = new Map<string, Map<string, string>>();
  /** Each workspace's collection order, as last read or written. */
  private orders = new Map<string, string[]>();
  /** Each workspace's specification entries, as last read or written. */
  private specEntries = new Map<string, SpecEntry[] | undefined>();
  /** Each team workspace's environment file order, as last read or written. */
  private environmentOrders = new Map<string, string[]>();
  /** Checks a team folder on a timer, since network drives and synced folders miss file events. */
  private pollTimer?: ReturnType<typeof setInterval>;
  /** workspaces.json as last read or written, and the text of an unreadable outside edit. */
  private indexText?: string;
  private brokenIndexText?: string;
  private indexListener?: (change: WorkspaceIndexChange) => void;
  private indexWatcher?: FSWatcher;
  private indexTimer?: ReturnType<typeof setTimeout>;
  /** Each workspace file's text as last read or written, to tell the app's saves from others. */
  private stateTexts = new Map<string, string>();
  // Watching the active workspace's files for changes made outside the app.
  private listener?: (change: WorkspaceChange) => void;
  private watchers: FSWatcher[] = [];
  private watchedId?: string;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  /** Workspaces with an outside change sent to the app and not yet applied, by its sequence. */
  private pending = new Map<string, number>();
  constructor(private readonly root: string) {}
  get activeId(): string {
    return this.index?.activeId || 'default';
  }
  vaultPath(id: string): string {
    validId(id);
    return id === 'default'
      ? path.join(this.root, 'credentials.enc')
      : path.join(this.root, 'workspaces', id, 'credentials.enc');
  }
  /** A team workspace's shared folder; undefined for workspaces kept on this device. */
  private folderOf(id: string): string | undefined {
    return this.index?.workspaces.find((item) => item.id === id)?.folder;
  }
  /**
   * Which saved credential a team workspace's request, or a collection's auth, uses on this
   * device: kept with this device's own secrets (local.json), as the shared folder never holds
   * one. An empty id forgets it.
   */
  async setTeamCredential(
    id: string,
    scope: { request: string } | { collection: string },
    credentialId: string | undefined,
  ): Promise<void> {
    await this.changeTeamSecrets(id, scope, (entry) => {
      if (credentialId) entry.credentialId = credentialId;
      else delete entry.credentialId;
    });
  }
  /**
   * Keeps a team request's auth secrets — a literal token, password, or secret setting, such as an
   * OAuth 2.0 access token — on this device, as the app keeps them, replacing those kept before.
   * The command line uses it for a team folder this app has open, since its own copy is temporary.
   */
  async setTeamAuthSecrets(
    id: string,
    requestId: string,
    secrets: Pick<AuthSecrets, 'token' | 'password' | 'authOptions'>,
  ): Promise<void> {
    await this.changeTeamSecrets(id, { request: requestId }, (entry) => {
      for (const key of ['token', 'password', 'authOptions'] as const) {
        if (secrets[key] === undefined) delete entry[key];
        else entry[key] = secrets[key] as never;
      }
    });
  }
  private async changeTeamSecrets(
    id: string,
    scope: { request: string } | { collection: string },
    change: (entry: AuthSecrets & Record<string, unknown>) => void,
  ): Promise<void> {
    if (this.folderOf(id) === undefined)
      throw new Error('Only a team workspace keeps its secrets on this device.');
    const file = this.localPath(id);
    const local = await fs
      .readFile(file, 'utf8')
      .then((value) => JSON.parse(value) as TeamLocalFile)
      .catch((): TeamLocalFile => ({ version: 1, tabs: [], secrets: emptyTeamSecrets() }));
    local.secrets ??= emptyTeamSecrets();
    const bucket: Record<string, AuthSecrets> =
      'request' in scope ? (local.secrets.requests ??= {}) : (local.secrets.collectionAuth ??= {});
    const key = 'request' in scope ? scope.request : scope.collection;
    // Read and written as the record's own property, so no name reaches Object's members.
    const entry = { ...(Object.hasOwn(bucket, key) ? bucket[key] : {}) } as AuthSecrets &
      Record<string, unknown>;
    change(entry);
    Object.defineProperty(bucket, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await this.atomic(file, local);
  }
  /** What a person keeps on this device for a team workspace. */
  private localPath(id: string): string {
    validId(id);
    return path.join(this.root, 'workspaces', id, 'local.json');
  }
  /** You, as teammates see you; created with the system user name the first time. */
  private get me(): TeamMember {
    return this.index!.member!;
  }
  /** The active workspace's id and folder when it is a team workspace. */
  activeTeam(): { id: string; folder: string; member: TeamMember } | undefined {
    const folder = this.folderOf(this.activeId);
    return folder && this.index?.member
      ? { id: this.activeId, folder, member: this.index.member }
      : undefined;
  }
  /** The file the active workspace is saved in, for showing it in the file manager. */
  activeStatePath(): string {
    return this.statePath(this.activeId);
  }
  /**
   * Where to show a collection or folder in the file manager: its directory once saved, otherwise
   * the workspace's collections directory, or its workspace file before the first save.
   */
  async revealPath(folder?: string): Promise<string> {
    return this.transact(async () => {
      const id = this.activeId;
      const directory = folder ? this.directories.get(id)?.get(folder) : undefined;
      const candidates = [
        ...(directory ? [path.join(this.workspaceDirectory(id), directory)] : []),
        path.join(this.workspaceDirectory(id), COLLECTIONS_DIRECTORY),
      ];
      for (const candidate of candidates)
        if (
          await fs.access(candidate).then(
            () => true,
            () => false,
          )
        )
          return candidate;
      return this.statePath(id);
    });
  }
  private workspaceDirectory(id: string): string {
    validId(id);
    return (
      this.folderOf(id) ??
      this.index?.workspaces.find((item) => item.id === id)?.location ??
      (id === 'default' ? this.root : path.join(this.root, 'workspaces', id))
    );
  }
  /** Where workspaces are saved: the app's data folder, the storage folder, and the open one's. */
  storage(): Promise<WorkspaceStorageInfo> {
    return this.transact(async () => this.storageInfo());
  }
  private async storageInfo(): Promise<WorkspaceStorageInfo> {
    const storageFolder = this.index?.storageFolder;
    return {
      appData: this.root,
      ...(storageFolder
        ? {
            storageFolder,
            ...((await usableFolder(storageFolder))
              ? {}
              : {
                  storageProblem: 'This folder cannot be reached; new workspaces go in app data.',
                }),
          }
        : {}),
      current: this.workspaceDirectory(this.activeId),
    };
  }
  /** Saves new workspaces in `folder` (each in a folder of its own), or in app data when unset. */
  setStorageFolder(folder: string | undefined): Promise<WorkspaceStorageInfo> {
    return this.transact(async () => {
      let storageFolder: string | undefined;
      if (folder !== undefined) {
        storageFolder = checkedStorageFolder(folder, this.root);
        if (!(await usableFolder(storageFolder)))
          throw new Error('That folder cannot be written to. Choose another.');
      }
      const next = { ...this.index! };
      if (storageFolder) next.storageFolder = storageFolder;
      else delete next.storageFolder;
      await this.updateIndex(next);
      return this.storageInfo();
    });
  }
  private statePath(id: string): string {
    return path.join(this.workspaceDirectory(id), 'workspace.json');
  }
  private async atomic(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }
  /**
   * Reads a workspace: its workspace file and, once split, its collection files. A workspace saved
   * before collections had their own files has everything in the workspace file.
   */
  private async readState(id: string): Promise<WorkspaceState | null> {
    try {
      const state = await this.assemble(id, await fs.readFile(this.statePath(id), 'utf8'), true);
      this.watchIfActive(id);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Could not read this workspace. Existing files were preserved.', {
        cause: error,
      });
    }
  }
  /**
   * The workspace a workspace file's text describes, with its collection files. With `commit`,
   * this becomes what the app knows is on disk (and missing request ids are written back);
   * without it, the files are only looked at.
   */
  private async assemble(id: string, text: string, commit: boolean): Promise<WorkspaceState> {
    const saved = JSON.parse(text) as WorkspaceState | WorkspaceFile | TeamWorkspaceFile;
    if (this.folderOf(id) !== undefined) {
      if ((saved as TeamWorkspaceFile).storage !== TEAM_FORMAT)
        throw new Error('This folder does not hold an API Workbench team workspace.');
      return this.assembleTeam(id, text, saved as TeamWorkspaceFile, commit);
    }
    if (Array.isArray((saved as WorkspaceState).requests)) {
      validateState(saved as WorkspaceState);
      if (commit) this.stateTexts.set(id, text);
      return saved as WorkspaceState;
    }
    const { storage, collectionOrder, responses, specFiles, ...rest } = saved as WorkspaceFile;
    if ((storage as string) === TEAM_FORMAT)
      throw new Error('A team workspace file was found in a workspace kept on this device.');
    void storage;
    const collections = commit
      ? await this.readCollections(id, collectionOrder, specFiles)
      : await this.readAllFiles(id, collectionOrder, specFiles);
    // Scripts are run, so only text is kept from the file.
    const workspaceScripts = normalizedScripts(rest.workspaceScripts);
    delete rest.workspaceScripts;
    const scriptSnippets = normalizedSnippets(rest.scriptSnippets);
    delete rest.scriptSnippets;
    const state: WorkspaceState = {
      ...rest,
      ...(workspaceScripts ? { workspaceScripts } : {}),
      ...(scriptSnippets ? { scriptSnippets } : {}),
      ...(collections.specs.length ? { specs: collections.specs } : {}),
      ...(collections.mocks.length ? { mocks: collections.mocks } : {}),
      ...(collections.library.length ? { scriptLibrary: collections.library } : {}),
      requests: collections.requests.map((request) => ({
        ...request,
        response: responses?.[request.id] ?? null,
      })),
      ...withEntries('collectionHttpSettings', collections.collectionHttpSettings),
      ...withEntries('collectionAuth', collections.collectionAuth),
      ...withEntries('collectionScripts', collections.collectionScripts),
      ...withEntries('collectionTags', collections.collectionTags),
    };
    validateState(state);
    if (commit) {
      this.orders.set(id, collectionOrder);
      this.specEntries.set(id, specFiles);
      this.stateTexts.set(id, text);
    }
    return state;
  }
  /** A team workspace: the folder's files, with this device's own state and secrets put back. */
  private async assembleTeam(
    id: string,
    text: string,
    file: TeamWorkspaceFile,
    commit: boolean,
  ): Promise<WorkspaceState> {
    const collections = commit
      ? await this.readCollections(id, file.collectionOrder, file.specFiles, file.environmentOrder)
      : await this.readAllFiles(id, file.collectionOrder, file.specFiles, file.environmentOrder);
    const local = await fs
      .readFile(this.localPath(id), 'utf8')
      .then((value) => JSON.parse(value) as TeamLocalFile)
      .catch(() => undefined);
    const name =
      typeof file.name === 'string' && file.name.trim()
        ? file.name.trim().slice(0, 60)
        : 'Team workspace';
    const state = joinTeamState(
      {
        requests: collections.requests,
        // A folder whose environments were all removed still opens, with an empty one.
        environments: collections.environments?.length
          ? collections.environments
          : [{ name: 'Development', variables: [] }],
        ...(collections.specs.length ? { specs: collections.specs } : {}),
        ...(collections.mocks.length ? { mocks: collections.mocks } : {}),
        ...(collections.library.length ? { scriptLibrary: collections.library } : {}),
        ...withEntries('collectionHttpSettings', collections.collectionHttpSettings),
        ...withEntries('collectionAuth', collections.collectionAuth),
        ...withEntries('collectionScripts', collections.collectionScripts),
        ...withEntries('collectionTags', collections.collectionTags),
        ...(normalizedScripts(file.workspaceScripts)
          ? { workspaceScripts: normalizedScripts(file.workspaceScripts) }
          : {}),
        ...(normalizedSnippets(file.scriptSnippets)
          ? { scriptSnippets: normalizedSnippets(file.scriptSnippets) }
          : {}),
      },
      name,
      local,
      collections.history ?? [],
    );
    validateState(state);
    if (commit) {
      this.orders.set(id, file.collectionOrder);
      this.specEntries.set(id, file.specFiles as SpecEntry[] | undefined);
      this.environmentOrders.set(
        id,
        Array.isArray(file.environmentOrder) ? file.environmentOrder : [],
      );
      this.stateTexts.set(id, text);
    }
    return state;
  }
  /**
   * Saves a workspace: request files and folder metadata first, then the workspace file. The first
   * save of a workspace kept in one file leaves a copy of it as workspace.legacy.json.
   */
  private async writeState(id: string, state: WorkspaceState): Promise<void> {
    const directory = this.workspaceDirectory(id);
    const team = this.folderOf(id) !== undefined;
    const split = team ? splitTeamState(state) : undefined;
    const written = split?.shared ?? state;
    const { files, directories, order } = collectionFiles(written);
    const api = apiFiles(written);
    for (const [file, content] of api.files) files.set(file, content);
    const environments = split ? environmentFiles(split.shared.environments) : undefined;
    for (const [file, content] of environments?.files ?? []) files.set(file, content);
    const ownHistory = split ? historyFile(this.me) : undefined;
    if (split && ownHistory) files.set(ownHistory, historyText(this.me, split.history));
    // Your own state and secrets stay on this device, whatever happens to the shared files.
    if (split) await this.atomic(this.localPath(id), split.local);
    let previous = this.files.get(id);
    if (!previous) {
      // Not read this session: learn which files the app wrote before, so stale ones are removed.
      previous = await this.readAllFiles(id, undefined, undefined, undefined).then(
        (read) => read.files,
        () => new Map<string, string>(),
      );
      const legacy =
        !team &&
        (await fs
          .readFile(this.statePath(id), 'utf8')
          .then((text) => Array.isArray((JSON.parse(text) as Partial<WorkspaceState>).requests))
          .catch(() => false));
      // Never overwrite an earlier copy: the first one is the workspace as it was before.
      if (legacy)
        await fs
          .copyFile(
            this.statePath(id),
            path.join(directory, 'workspace.legacy.json'),
            fsConstants.COPYFILE_EXCL,
          )
          .catch(() => {});
    }
    // Teammates' history files are theirs: kept exactly as they were last read.
    if (team)
      for (const [file, content] of previous)
        if (file.startsWith(HISTORY_DIRECTORY + '/') && file !== ownHistory)
          files.set(file, content);
    // A change from outside that the app has not applied yet wins: this save may predate it.
    if (!this.pending.has(id)) {
      // Files edited outside the app since it last saw them are left as they are, and reloaded.
      const changed = await externallyChanged(directory, previous, files);
      await syncCollectionFiles(directory, previous, files, changed, team);
      const known = new Map(files);
      for (const file of changed)
        if (previous.has(file)) known.set(file, previous.get(file)!);
        else known.delete(file);
      this.files.set(id, known);
      this.directories.set(id, directories);
      this.orders.set(id, order);
      this.specEntries.set(id, api.specs);
      if (environments) this.environmentOrders.set(id, environments.order);
      if (changed.size) this.scheduleCheck(id);
    }
    this.watchIfActive(id);
    if (team) {
      if (this.pending.has(id)) return;
      const teamFile: TeamWorkspaceFile = {
        storage: TEAM_FORMAT,
        version: 1,
        name: workspaceName(state.settings?.workspaceName || this.entry(id).name),
        collectionOrder: order,
        environmentOrder: environments!.order,
        ...(api.specs.length ? { specFiles: api.specs } : {}),
        ...(normalizedScripts(state.workspaceScripts)
          ? { workspaceScripts: normalizedScripts(state.workspaceScripts) }
          : {}),
        ...(normalizedSnippets(state.scriptSnippets)
          ? { scriptSnippets: normalizedSnippets(state.scriptSnippets) }
          : {}),
      };
      await this.writeWorkspaceFile(id, JSON.stringify(teamFile, null, 2), true);
      return;
    }
    const {
      requests,
      collectionHttpSettings,
      collectionAuth,
      collectionScripts,
      collectionTags,
      scriptLibrary,
      specs,
      mocks,
      ...rest
    } = state;
    void specs;
    void mocks;
    void scriptLibrary;
    void collectionTags;
    void collectionScripts;
    const responses = Object.fromEntries(
      requests
        .filter((request) => request.response)
        .map((request) => [request.id, request.response]),
    );
    const file: WorkspaceFile = {
      ...rest,
      storage: 'collections',
      collectionOrder: this.pending.has(id) ? (this.orders.get(id) ?? order) : order,
      ...((this.pending.has(id) ? this.specEntries.get(id) : api.specs)?.length
        ? { specFiles: this.pending.has(id) ? this.specEntries.get(id) : api.specs }
        : {}),
      ...(Object.keys(responses).length ? { responses } : {}),
    };
    // The workspace file follows the same rule: an edit from outside is not overwritten.
    if (this.pending.has(id)) return;
    await this.writeWorkspaceFile(id, JSON.stringify(file), false);
  }
  /** Writes workspace.json unless it changed outside the app since it was last seen. */
  private async writeWorkspaceFile(id: string, text: string, shared: boolean): Promise<void> {
    const seen = this.stateTexts.get(id);
    const now = await fs.readFile(this.statePath(id), 'utf8').catch(() => undefined);
    if (seen !== undefined && now !== undefined && now !== seen) {
      this.scheduleCheck(id);
      return;
    }
    if (now !== text) await writeAtomically(this.statePath(id), text, shared);
    this.stateTexts.set(id, text);
  }
  /** Reads a workspace's files, writing back any ids it had to give request files. */
  private async readCollections(
    id: string,
    order: unknown,
    specEntries: unknown,
    environmentOrder?: unknown,
  ) {
    const directory = this.workspaceDirectory(id);
    const collections = await this.readAllFiles(id, order, specEntries, environmentOrder);
    for (const [file, text] of collections.repaired)
      await writeCollectionFile(directory, file, text, this.folderOf(id) !== undefined);
    this.files.set(id, collections.files);
    this.directories.set(id, collections.directories);
    return collections;
  }
  /**
   * Collection, specification, and mock files, with every file's text in one map; in a team
   * folder, environments and everyone's history too.
   */
  private async readAllFiles(
    id: string,
    order: unknown,
    specEntries: unknown,
    environmentOrder?: unknown,
  ) {
    const directory = this.workspaceDirectory(id);
    const collections = await readCollectionFiles(directory, order);
    const api = await readApiFiles(directory, specEntries);
    const team =
      this.folderOf(id) !== undefined
        ? await readTeamFiles(directory, environmentOrder, this.me)
        : undefined;
    return {
      ...collections,
      specs: api.specs,
      mocks: api.mocks,
      library: api.library,
      environments: team?.environments,
      history: team?.history,
      files: new Map([...collections.files, ...api.files, ...(team?.files ?? [])]),
    };
  }
  /**
   * Calls `listener` with the active workspace as it is on disk whenever its workspace file or
   * collection files change outside the app, or with an error when they cannot be read. The app's
   * own saves are not reported.
   */
  onWorkspaceChange(listener: (change: WorkspaceChange) => void): void {
    this.listener = listener;
    this.watchIfActive(this.activeId);
  }
  /** The app has applied the outside change with this sequence, so its saves write files again. */
  workspaceChangeApplied(sequence: number): void {
    for (const [id, pending] of this.pending) if (pending === sequence) this.pending.delete(id);
  }
  /** Stops watching; the store keeps working without it. */
  close(): void {
    this.closeWorkspaceWatchers();
    clearTimeout(this.indexTimer);
    this.indexWatcher?.close();
    this.indexWatcher = undefined;
  }
  private closeWorkspaceWatchers(): void {
    clearTimeout(this.checkTimer);
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.watchedId = undefined;
  }
  private watchIfActive(id: string): void {
    if (!this.listener || id !== this.activeId) return;
    const team = this.folderOf(id) !== undefined;
    // Each directory is watched once it exists (after the first save that needs it).
    const trees = [
      COLLECTIONS_DIRECTORY,
      SPECS_DIRECTORY,
      MOCKS_DIRECTORY,
      SCRIPTS_DIRECTORY,
      ...(team ? [ENVIRONMENTS_DIRECTORY, HISTORY_DIRECTORY] : []),
    ]
      .map((name) => path.join(this.workspaceDirectory(id), name))
      .filter((directory) => existsSync(directory));
    if (this.watchedId === id && this.watchers.length === 1 + trees.length) return;
    this.closeWorkspaceWatchers();
    const onEvent = (file: string | Buffer | null) => {
      if (file && String(file).endsWith('.tmp')) return;
      this.scheduleCheck(id);
    };
    try {
      // Only workspace.json: for the default workspace this directory also holds the app's caches.
      const directory = watch(this.workspaceDirectory(id), (_, file) => {
        if (file === null || String(file) === 'workspace.json') onEvent(file);
      });
      directory.on('error', () => this.closeWorkspaceWatchers());
      this.watchers.push(directory);
      this.watchedId = id;
    } catch {
      return;
    }
    for (const directory of trees)
      try {
        // Recursive watching covers every folder; it works on macOS, Windows, and Linux.
        const tree = watch(directory, { recursive: true }, (_, file) => onEvent(file));
        tree.on('error', () => this.closeWorkspaceWatchers());
        this.watchers.push(tree);
      } catch {
        // Removed since it was found: the next save creates it and watches it.
      }
    // Network drives and synced folders often send no file events, so team folders are also
    // checked every few seconds; an unchanged folder is not reported.
    if (team) this.pollTimer = setInterval(() => this.scheduleCheck(id), TEAM_POLL_MS);
  }
  /** Reloads the active workspace now if its files changed, as after a Git pull. */
  checkNow(): Promise<void> {
    clearTimeout(this.checkTimer);
    return this.checkWorkspace(this.activeId);
  }
  /** Checks for outside changes once a burst of file events (an editor's save) has settled. */
  private scheduleCheck(id: string): void {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => void this.checkWorkspace(id), 250);
  }
  private checkWorkspace(id: string): Promise<void> {
    return this.transact(async () => {
      if (id !== this.activeId || !this.listener) return;
      const text = await fs.readFile(this.statePath(id), 'utf8').catch(() => undefined);
      // Removed (or not yet written): there is nothing to reload, and the next save restores it.
      if (text === undefined) return;
      const known = this.files.get(id) ?? new Map<string, string>();
      let state: WorkspaceState;
      try {
        state = await this.assemble(id, text, false);
        const files =
          (await this.readAllFiles(
            id,
            this.orders.get(id),
            this.specEntries.get(id),
            this.environmentOrders.get(id),
          ).then(
            (read) => read.files,
            () => undefined,
          )) ?? new Map<string, string>();
        const same =
          text === this.stateTexts.get(id) &&
          files.size === known.size &&
          [...files].every(([file, content]) => known.get(file) === content);
        if (same) return;
        // Read again as the app's copy: request ids it had to add are written back now.
        state = await this.assemble(id, text, true);
      } catch (error) {
        // A half-written or invalid file: keep the app's workspace until it is fixed.
        this.listener({ sequence: ++this.sequence, error: (error as Error).message });
        return;
      }
      const sequence = ++this.sequence;
      this.pending.set(id, sequence);
      this.listener({ sequence, state });
    });
  }
  private async initialize(): Promise<void> {
    if (this.index) return;
    let index: WorkspaceIndex;
    try {
      const text = await fs.readFile(this.indexPath, 'utf8');
      index = JSON.parse(text) as WorkspaceIndex;
      this.indexText = text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not read workspace index. Existing files were preserved.', {
          cause: error,
        });
      const legacy = await this.readState('default');
      const now = new Date().toISOString();
      index = {
        version: 1,
        activeId: 'default',
        workspaces: [
          {
            id: 'default',
            name: workspaceName(legacy?.settings?.workspaceName || 'Personal workspace'),
            hasData: Boolean(legacy),
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      await this.atomic(this.indexPath, index);
      this.indexText = JSON.stringify(index);
    }
    validateIndex(index);
    this.index = index;
    if (!index.member) {
      // Teammates see this name in team workspaces; it can be changed when joining one.
      let name = 'Teammate';
      try {
        name = os.userInfo().username.slice(0, 60) || name;
      } catch {
        /* No user name on this system. */
      }
      await this.updateIndex({ ...index, member: { id: randomUUID(), name } });
    }
  }
  private get indexPath(): string {
    return path.join(this.root, 'workspaces.json');
  }
  /**
   * Takes workspaces.json as edited outside the app, before anything builds on the index: names,
   * added and removed workspaces. The open workspace stays open and listed, since switching it
   * (and its vault) happens in the app. An unreadable file is reported once and never overwritten.
   */
  private async refreshIndex(): Promise<void> {
    const text = await fs.readFile(this.indexPath, 'utf8').catch(() => undefined);
    if (text === undefined || text === this.indexText) return;
    const open = this.index!.workspaces.find((item) => item.id === this.activeId)!;
    let merged: WorkspaceIndex;
    let kept: boolean;
    try {
      const external = JSON.parse(text) as WorkspaceIndex;
      if (!external || !Array.isArray(external.workspaces))
        throw new Error('Invalid workspace index. Existing files were preserved.');
      kept = external.workspaces.some((item) => item?.id === open.id);
      merged = {
        ...external,
        activeId: open.id,
        workspaces: kept ? external.workspaces : [...external.workspaces, open],
        // You stay the same person if an outside edit dropped you.
        member: external.member ?? this.index!.member,
      };
      validateIndex(merged);
    } catch (error) {
      if (this.brokenIndexText !== text)
        this.indexListener?.({ error: `workspaces.json: ${(error as Error).message}` });
      this.brokenIndexText = text;
      return;
    }
    this.brokenIndexText = undefined;
    this.index = merged;
    this.indexText = text;
    this.indexListener?.({
      index: structuredClone(this.index),
      ...(kept ? {} : { warning: `“${open.name}” is open, so it stays in the workspace list.` }),
    });
  }
  /** Calls `listener` when workspaces.json changes outside the app, with the index as it is now. */
  onIndexChange(listener: (change: WorkspaceIndexChange) => void): void {
    this.indexListener = listener;
    if (this.indexWatcher) return;
    try {
      this.indexWatcher = watch(this.root, (_, file) => {
        if (file !== null && String(file) !== 'workspaces.json') return;
        clearTimeout(this.indexTimer);
        // Any transaction reads the index again first, so an empty one is enough.
        this.indexTimer = setTimeout(() => void this.transact(async () => {}), 250);
      });
      this.indexWatcher.on('error', () => {
        this.indexWatcher?.close();
        this.indexWatcher = undefined;
      });
    } catch {
      // Without a data directory there is nothing to watch yet.
    }
  }
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      await this.initialize();
      await this.refreshIndex();
      return operation();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private entry(id: string): WorkspaceSummary {
    validId(id);
    const entry = this.index!.workspaces.find((item) => item.id === id);
    if (!entry) throw new Error('Workspace no longer exists.');
    return entry;
  }
  private async updateIndex(index: WorkspaceIndex): Promise<void> {
    this.index = index;
    // While workspaces.json cannot be read, it is left for the person fixing it.
    if (this.brokenIndexText !== undefined) return;
    await this.atomic(this.indexPath, index);
    this.indexText = JSON.stringify(index);
  }
  list(): Promise<WorkspaceIndex> {
    return this.transact(async () => structuredClone(this.index!));
  }
  load(id?: string): Promise<WorkspaceState | null> {
    return this.transact(async () => {
      id ||= this.activeId;
      const entry = this.entry(id);
      const state = await this.readState(id);
      if (!state && (id !== 'default' || entry.hasData))
        throw new Error('Workspace data is missing. Existing files were preserved.');
      return state;
    });
  }
  save(state: WorkspaceState, id?: string): Promise<void> {
    // Serialize at invocation, so subsequent renderer edits cannot mutate a pending save.
    const snapshot = structuredClone(state);
    return this.transact(async () => {
      id ||= this.activeId;
      const entry = this.entry(id);
      validateState(snapshot);
      const name = workspaceName(snapshot.settings?.workspaceName || entry.name);
      await this.writeState(id, snapshot);
      await this.updateIndex({
        ...this.index!,
        workspaces: this.index!.workspaces.map((item) =>
          item.id === id
            ? { ...item, name, hasData: true, updatedAt: new Date().toISOString() }
            : item,
        ),
      });
    });
  }
  /**
   * Creates a workspace. `parent` is the folder it gets a folder of its own in: the storage folder
   * by default, `null` for the app's data folder, or a folder the person chose.
   */
  create(name: string, state: WorkspaceState, parent?: string | null): Promise<WorkspaceSummary> {
    const snapshot = structuredClone(state);
    return this.transact(async () => {
      name = workspaceName(name);
      validateState(snapshot);
      const id = randomUUID(),
        now = new Date().toISOString();
      snapshot.settings = {
        ...snapshot.settings,
        workspaceName: name,
      } as WorkspaceState['settings'];
      // An unreachable storage folder (an unplugged drive) falls back to app data, as if unset.
      let base = parent === undefined ? this.index!.storageFolder : (parent ?? undefined);
      if (base !== undefined) {
        base = checkedStorageFolder(base, this.root);
        if (!(await usableFolder(base))) {
          if (parent !== undefined) throw new Error('That folder cannot be written to.');
          base = undefined;
        }
      }
      const location = base ? await newWorkspaceFolder(base, name) : undefined;
      const entry: WorkspaceSummary = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        hasData: true,
        ...(location ? { location } : {}),
      };
      // The entry goes in first so the files are written to its folder.
      this.index = { ...this.index!, workspaces: [...this.index!.workspaces, entry] };
      try {
        await this.writeState(id, snapshot);
      } catch (error) {
        this.index = {
          ...this.index!,
          workspaces: this.index!.workspaces.filter((item) => item.id !== id),
        };
        throw error;
      }
      await this.updateIndex(this.index!);
      return entry;
    });
  }
  activate(id: string): Promise<WorkspaceState | null> {
    return this.transact(async () => {
      const entry = this.entry(id);
      const state = await this.readState(id);
      if (!state && (id !== 'default' || entry.hasData))
        throw new Error('Workspace data is missing. Existing files were preserved.');
      await this.updateIndex({ ...this.index!, activeId: id });
      this.watchIfActive(id);
      return state;
    });
  }
  rename(id: string, name: string): Promise<void> {
    return this.transact(async () => {
      this.entry(id);
      name = workspaceName(name);
      const state = await this.readState(id);
      if (state) {
        state.settings = { ...state.settings, workspaceName: name } as WorkspaceState['settings'];
        await this.writeState(id, state);
      }
      await this.updateIndex({
        ...this.index!,
        workspaces: this.index!.workspaces.map((item) =>
          item.id === id ? { ...item, name, updatedAt: new Date().toISOString() } : item,
        ),
      });
    });
  }
  /** You, as teammates see you in team workspaces. */
  member(): Promise<TeamMember> {
    return this.transact(async () => structuredClone(this.me));
  }
  setMemberName(name: unknown): Promise<TeamMember> {
    return this.transact(async () => this.renameMember(name));
  }
  private async renameMember(name: unknown): Promise<TeamMember> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60)
      throw new Error('Enter a name of 1–60 characters for teammates to see.');
    const member = { ...this.me, name: name.trim() };
    if (member.name !== this.me.name) await this.updateIndex({ ...this.index!, member });
    return structuredClone(member);
  }
  /**
   * Adds the team workspace in `folder`. A folder that already holds one is joined; otherwise one
   * is started there from `initial`, leaving the folder's other files alone. `share` copies a
   * workspace into an empty folder, with the vault of `vaultFrom`, so its saved credentials keep
   * working for you. The workspace still has to be activated.
   */
  openFolder(
    folder: string,
    initial: WorkspaceState,
    memberName: string,
    mode: 'open' | 'share',
    vaultFrom?: string,
  ): Promise<WorkspaceSummary> {
    const snapshot = structuredClone(initial);
    return this.transact(async () => {
      if (typeof folder !== 'string' || !path.isAbsolute(folder))
        throw new Error('Choose a folder for the team workspace.');
      folder = path.resolve(folder);
      const within = (child: string, parent: string) => {
        const relative = path.relative(parent, child);
        return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
      };
      if (within(folder, this.root) || within(this.root, folder))
        throw new Error('Choose a folder outside API Workbench’s own data folder.');
      await this.renameMember(memberName);
      const existing = this.index!.workspaces.find(
        (item) => item.folder && path.resolve(item.folder) === folder,
      );
      if (existing) {
        if (mode === 'share')
          throw new Error(`This folder is already the team workspace “${existing.name}”.`);
        return structuredClone(existing);
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const text = await fs
        .readFile(path.join(folder, 'workspace.json'), 'utf8')
        .catch(() => undefined);
      if (text !== undefined) {
        let file: Partial<TeamWorkspaceFile> | undefined;
        try {
          file = JSON.parse(text) as Partial<TeamWorkspaceFile>;
        } catch {
          /* Reported below. */
        }
        if (file?.storage !== TEAM_FORMAT)
          throw new Error(
            'This folder has a workspace.json that is not an API Workbench team workspace. Choose another folder.',
          );
        if (mode === 'share')
          throw new Error(
            'This folder already holds a team workspace. Use Open team folder to join it, or choose an empty folder.',
          );
        let name = 'Team workspace';
        try {
          name = workspaceName(file.name || path.basename(folder));
        } catch {
          /* Keep the default name. */
        }
        const entry: WorkspaceSummary = {
          id,
          name,
          createdAt: now,
          updatedAt: now,
          hasData: true,
          folder,
        };
        await this.updateIndex({ ...this.index!, workspaces: [...this.index!.workspaces, entry] });
        return structuredClone(entry);
      }
      validateState(snapshot);
      const name = workspaceName(
        snapshot.settings?.workspaceName || path.basename(folder) || 'Team workspace',
      );
      snapshot.settings = {
        ...snapshot.settings,
        workspaceName: name,
      } as WorkspaceState['settings'];
      const entry: WorkspaceSummary = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        hasData: true,
        folder,
      };
      const before = this.index!;
      // The entry comes first: it is what points this workspace's files at the folder.
      this.index = { ...before, workspaces: [...before.workspaces, entry] };
      try {
        await fs.mkdir(folder, { recursive: true });
        await fs.access(folder, fsConstants.W_OK);
        await this.writeState(id, snapshot);
        if (vaultFrom !== undefined)
          await fs.copyFile(this.vaultPath(vaultFrom), this.vaultPath(id)).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
      } catch (error) {
        this.index = before;
        this.files.delete(id);
        await fs.rm(path.join(this.root, 'workspaces', id), { recursive: true, force: true });
        throw new Error(`Could not set up the team folder: ${(error as Error).message}`, {
          cause: error,
        });
      }
      await this.updateIndex(this.index);
      return structuredClone(entry);
    });
  }
  delete(id: string): Promise<void> {
    return this.transact(async () => {
      this.entry(id);
      if (id === this.activeId)
        throw new Error('Switch to another workspace before deleting this one.');
      if (this.index!.workspaces.length < 2) throw new Error('Keep at least one workspace.');
      // Read before the entry goes from the index.
      const team = this.folderOf(id) !== undefined;
      const located = this.entry(id).location !== undefined;
      const directory = this.workspaceDirectory(id);
      await this.updateIndex({
        ...this.index!,
        workspaces: this.index!.workspaces.filter((item) => item.id !== id),
      });
      this.files.delete(id);
      this.directories.delete(id);
      // Leaving a team workspace removes only this device's copy: the shared folder stays.
      // A workspace in a folder of the person's own keeps its files there: only the app's copy of
      // its vault and preferences goes.
      if (team || located)
        await fs.rm(path.join(this.root, 'workspaces', id), { recursive: true, force: true });
      else if (id === 'default') {
        await fs.rm(this.statePath(id), { force: true });
        await fs.rm(this.vaultPath(id), { force: true });
        await fs.rm(path.join(this.root, COLLECTIONS_DIRECTORY), { recursive: true, force: true });
      } else await fs.rm(directory, { recursive: true, force: true });
    });
  }
}

/** A folder chosen for workspaces, checked: absolute, and not inside the app's own data folder. */
export function checkedStorageFolder(folder: unknown, appData: string): string {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\0]/.test(folder))
    throw new Error('Choose a folder by its full path.');
  const resolved = path.resolve(folder);
  const inside = path.relative(appData, resolved);
  if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside)))
    throw new Error('Choose a folder outside API Workbench’s own data folder.');
  return resolved;
}
/** Whether a folder exists (or can be made) and can be written to. */
async function usableFolder(folder: string): Promise<boolean> {
  try {
    await fs.mkdir(folder, { recursive: true });
    await fs.access(folder, fsConstants.W_OK);
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}
/**
 * A new, empty folder for a workspace in `parent`, named after it ("Shop API", then "Shop API 2"
 * when that is taken), so nothing already there is ever overwritten.
 */
async function newWorkspaceFolder(parent: string, name: string): Promise<string> {
  const base =
    name
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[ .]+|[ .]+$/g, '')
      .slice(0, 60) || 'Workspace';
  for (let attempt = 1; attempt < 1000; attempt++) {
    const folder = path.join(parent, attempt === 1 ? base : `${base} ${attempt}`);
    try {
      await fs.mkdir(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not find a free folder name for the workspace.');
}

/** A team workspace's device secrets before any were kept. */
function emptyTeamSecrets(): TeamLocalFile['secrets'] {
  return { requests: {}, collectionAuth: {}, collectionProxy: {}, environments: {} };
}
