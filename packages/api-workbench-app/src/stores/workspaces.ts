import { defineStore } from 'pinia';
import { nextTick, shallowReactive } from 'vue';
import { sanitizeClientCertificates } from '@techieutils/api-workbench-common/client-certificates';
import { sanitizeJar } from '@techieutils/api-workbench-common/cookies';
import * as http from '@techieutils/api-workbench-common/http-settings';
import { REQUEST_PROTOCOLS } from '@techieutils/api-workbench-common/types';
import {
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import type {
  AppSettings,
  AuthType,
  TeamMember,
  TeamPresence,
  TeamPresenceChange,
  WorkspaceBridge,
  WorkspaceIndex,
  WorkspaceIndexChange,
  WorkspaceLocationChoice,
  WorkspaceState,
  WorkspaceStorageInfo,
} from '@techieutils/api-workbench-common/types';
import { confirmAction } from '../confirm';
import { render } from '../shell';
import { errorMessage, toast } from '../utils';
import { migratedAuthType } from './authentication';
import { useHTTPSettingsStore } from './http-settings';
import { useProtocolsStore } from './protocols';
import { useRequestBodyStore } from './request-body';
import { useRequestRowsStore } from './request-rows';
import { useResponseStore } from './response';
import { useRunnerStore } from './runner';
import { useScreensStore } from './screens';
import { useSourceEditorsStore } from './source-editors';
import { useTeamGitStore } from './team-git';
import { useToolsStore } from './tools';
import { useUiStore } from './ui';
import { useVaultStore } from './vault';
import { DEFAULT_SETTINGS, makeRequest, useWorkspaceStore } from './workspace';
import { gitRemoteProblem } from '@techieutils/api-workbench-common/share-links';

const INDEX_KEY = 'api-workbench:workspaces';
const PROTOCOLS: readonly string[] = REQUEST_PROTOCOLS;

const storageKey = (id: string): string =>
  id === 'default' ? 'api-workbench' : `api-workbench:workspace:${id}`;
/** Outside Electron, workspaces live in local storage under an index. */
function browserIndex(): WorkspaceIndex {
  const value = localStorage.getItem(INDEX_KEY);
  if (value) return JSON.parse(value) as WorkspaceIndex;
  const previous = JSON.parse(
    localStorage.getItem('api-workbench') || 'null',
  ) as WorkspaceState | null;
  const now = new Date().toISOString();
  const index: WorkspaceIndex = {
    version: 1,
    activeId: 'default',
    workspaces: [
      {
        id: 'default',
        name: previous?.settings?.workspaceName || 'Personal workspace',
        hasData: Boolean(previous),
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  return index;
}
const writeBrowserIndex = (index: WorkspaceIndex): void =>
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length
    ? [Array.from(words[0])[0], words.length > 1 ? Array.from(words.at(-1)!)[0] : '']
        .join('')
        .toLocaleUpperCase()
    : 'W';
};
const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not available'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const nameError = (value: string): string =>
  !value.trim()
    ? 'Enter a workspace name.'
    : value.trim().length > 60
      ? 'Use 60 characters or fewer.'
      : '';

/** Workspace storage and switching, and the workspace manager dialog. */
export const useWorkspacesStore = defineStore('workspaces', () => {
  const workspace = useWorkspaceStore();
  const ui = useUiStore();
  /**
   * The current workspace id and the manager dialog. Shallow, so the index stays a plain object
   * and is replaced, not mutated, when it changes.
   */
  const manager = shallowReactive({
    id: 'default',
    index: { version: 1, activeId: 'default', workspaces: [] } as WorkspaceIndex,
    open: false,
    busy: false,
    error: '',
    editing: '',
    mode: 'details' as 'details' | 'create' | 'rename' | 'delete' | 'team',
    selectedId: '',
    query: '',
    draftName: '',
    nameError: '',
    loading: false,
    pendingLabel: '',
    /** Where the workspace being created is saved. */
    createLocation: 'default' as WorkspaceLocationChoice,
  });
  /** Where workspaces are saved, for Settings → Saving and the new-workspace form. */
  const storage = shallowReactive({
    info: null as WorkspaceStorageInfo | null,
    busy: false,
    error: '',
  });
  async function loadStorage(): Promise<void> {
    const bridge = window.workbench?.workspaces;
    if (!bridge?.storage) return;
    try {
      storage.info = await bridge.storage();
      storage.error = '';
    } catch (error) {
      storage.error = errorMessage(error);
    }
    render();
  }
  async function changeStorageFolder(choose: boolean): Promise<void> {
    const bridge = window.workbench?.workspaces;
    const change = choose ? bridge?.chooseStorageFolder : bridge?.resetStorageFolder;
    if (!change || storage.busy) return;
    storage.busy = true;
    storage.error = '';
    render();
    try {
      const before = storage.info?.storageFolder;
      storage.info = await change();
      manager.index = await service().list();
      if (storage.info.storageFolder !== before)
        toast(
          storage.info.storageFolder
            ? `New workspaces are saved in ${storage.info.storageFolder}`
            : 'New workspaces are saved in the app’s data folder',
          'success',
        );
    } catch (error) {
      storage.error = errorMessage(error);
    } finally {
      storage.busy = false;
      render();
    }
  }
  /**
   * Team workspaces: you as teammates see you, the name being edited in the team form, and who
   * else has the open team workspace, with the request they are on.
   */
  const team = shallowReactive({
    member: null as TeamMember | null,
    memberName: '',
    memberError: '',
    others: [] as TeamPresence[],
    /** A Git repository to clone as a team workspace, from the team form. */
    cloneURL: '',
    cloneError: '',
  });
  /** The open workspace's entry, and whether it lives in a shared folder. */
  const currentEntry = () => manager.index.workspaces.find((item) => item.id === manager.id);
  const isTeam = (id = manager.id) =>
    Boolean(manager.index.workspaces.find((item) => item.id === id)?.folder);

  // Storage
  async function saveSnapshot(snapshot: WorkspaceState, id: string): Promise<void> {
    if (window.workbench) return window.workbench.save(snapshot, id);
    const index = browserIndex();
    if (!index.workspaces.some((item) => item.id === id))
      throw new Error('Workspace no longer exists.');
    localStorage.setItem(storageKey(id), JSON.stringify(snapshot));
    index.workspaces = index.workspaces.map((item) =>
      item.id === id
        ? {
            ...item,
            name: snapshot.settings?.workspaceName || item.name,
            hasData: true,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    writeBrowserIndex(index);
  }
  function service(): WorkspaceBridge {
    if (window.workbench) return window.workbench.workspaces;
    return {
      list: async () => browserIndex(),
      create: async (name, state) => {
        const index = browserIndex(),
          now = new Date().toISOString();
        const item = {
          id: crypto.randomUUID(),
          name,
          createdAt: now,
          updatedAt: now,
          hasData: true,
        };
        localStorage.setItem(storageKey(item.id), JSON.stringify(state));
        index.workspaces.push(item);
        writeBrowserIndex(index);
        return item;
      },
      switch: async (id) => {
        const index = browserIndex();
        if (!index.workspaces.some((item) => item.id === id))
          throw new Error('Workspace no longer exists.');
        const saved = JSON.parse(
          localStorage.getItem(storageKey(id)) || 'null',
        ) as WorkspaceState | null;
        if (
          !saved &&
          (id !== 'default' || index.workspaces.find((item) => item.id === id)?.hasData)
        )
          throw new Error('Workspace data is missing. Existing data was preserved.');
        if (saved) normalize(saved);
        index.activeId = id;
        writeBrowserIndex(index);
        return saved;
      },
      rename: async (id, name) => {
        const index = browserIndex();
        if (!index.workspaces.some((item) => item.id === id))
          throw new Error('Workspace no longer exists.');
        const saved = JSON.parse(
          localStorage.getItem(storageKey(id)) || 'null',
        ) as WorkspaceState | null;
        if (saved) {
          saved.settings = { ...saved.settings, workspaceName: name } as AppSettings;
          localStorage.setItem(storageKey(id), JSON.stringify(saved));
        }
        index.workspaces = index.workspaces.map((item) =>
          item.id === id ? { ...item, name } : item,
        );
        writeBrowserIndex(index);
      },
      delete: async (id) => {
        const index = browserIndex();
        if (id === index.activeId || index.workspaces.length < 2)
          throw new Error('Switch to another workspace before deleting this one.');
        index.workspaces = index.workspaces.filter((item) => item.id !== id);
        writeBrowserIndex(index);
        localStorage.removeItem(storageKey(id));
      },
    };
  }
  async function initialize(): Promise<void> {
    manager.index = await service().list();
    manager.id = manager.index.activeId;
    // workspaces.json edited outside the app (an editor, git) reloads the list.
    unwatchIndex?.();
    unwatchIndex = window.workbench?.workspaces.onIndexChange?.(applyIndexChange);
    const bridge = window.workbench?.workspaces;
    if (bridge?.member) {
      team.member = await bridge.member();
      team.memberName = team.member.name;
    }
    unwatchPresence?.();
    unwatchPresence = bridge?.onPresence?.(applyPresence);
    // Closing the window with changes waiting saves them first; the main process asks beforehand
    // when auto save is off.
    unwatchClose?.();
    unwatchClose = bridge?.onSaveBeforeClose?.(() => {
      void workspace.saveNow().then(
        () => bridge.closeReady?.(true),
        () => bridge.closeReady?.(false),
      );
    });
    // In a browser there is no main process: the page's own prompt guards unsaved changes.
    if (!window.workbench && !beforeUnloadWatched) {
      beforeUnloadWatched = true;
      window.addEventListener('beforeunload', (event) => {
        if (workspace.unsaved && workspace.settings().autoSave === 'off') event.preventDefault();
        else if (workspace.unsaved) void workspace.saveNow().catch(() => {});
      });
    }
    clearInterval(presenceTimer);
    if (bridge?.setPresence) presenceTimer = setInterval(reportPresence, 1500);
  }
  let unwatchIndex: (() => void) | undefined;
  let unwatchClose: (() => void) | undefined;
  let beforeUnloadWatched = false;
  let unwatchPresence: (() => void) | undefined;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  /** The request last reported to teammates, so only changes are written to the folder. */
  let reported: string | undefined;
  function applyPresence(change: TeamPresenceChange): void {
    team.others = change.workspaceId === manager.id ? change.others : [];
    render();
  }
  /** Tells teammates which request you are on, when it changed. */
  function reportPresence(): void {
    if (!isTeam()) return;
    const request =
      ui.view === 'Collections' && workspace.state.tabs.length ? workspace.current() : undefined;
    const key = request ? `${request.id}|${request.name}` : '';
    if (key === reported) return;
    reported = key;
    void window.workbench?.workspaces.setPresence?.(request?.id, request?.name).catch(() => {});
  }
  /** Teammates on a request, for the request heading and explorer. */
  const othersOn = (requestId: string) =>
    team.others.filter((presence) => presence.requestId === requestId);
  /** Takes workspaces.json as edited outside the app: the list, and the open workspace's name. */
  function applyIndexChange(change: WorkspaceIndexChange): void {
    if ('error' in change) {
      toast(`Workspace list not reloaded: ${change.error}`, 'warning');
      return;
    }
    manager.index = change.index;
    if (change.warning) toast(change.warning, 'warning');
    // Saving copies the open workspace's own name into the list, so a rename goes there too.
    const name = change.index.workspaces.find((item) => item.id === manager.id)?.name;
    const settings = workspace.state.settings;
    if (name && settings && settings.workspaceName !== name) {
      settings.workspaceName = name;
      workspace.persist();
    }
    render();
  }
  /** Validates a saved workspace and fills in what older versions did not store. */
  function normalize(saved: WorkspaceState): WorkspaceState {
    if (
      !saved ||
      !Array.isArray(saved.requests) ||
      !saved.requests.length ||
      !Array.isArray(saved.environments) ||
      !saved.environments.length
    )
      throw new Error('Invalid workspace. Existing files were preserved.');
    saved.settings = workspace.normalizedSettings(saved.settings);
    saved.collectionHttpSettings = http.collectionOverrides(saved.collectionHttpSettings);
    saved.requests.forEach((request) => {
      if (request.protocol && !PROTOCOLS.includes(request.protocol))
        throw new Error('Unsupported saved request protocol.');
      request.httpSettings = http.overrides(request.httpSettings);
      request.auth = migratedAuthType(request.auth) as AuthType;
      // Settings edited by hand in a request's YAML file are checked like imported ones.
      if (request.socketio !== undefined) request.socketio = normalizedSocketIO(request.socketio);
      if (request.mqtt !== undefined) request.mqtt = normalizedMQTT(request.mqtt);
    });
    Object.values(saved.collectionAuth || {}).forEach((config) => {
      config.auth = migratedAuthType(config.auth) as AuthType;
    });
    saved.history = Array.isArray(saved.history) ? saved.history : [];
    if (saved.clientCertificates !== undefined)
      saved.clientCertificates = sanitizeClientCertificates(saved.clientCertificates);
    if (saved.cookieJar !== undefined)
      saved.cookieJar = {
        enabled: saved.cookieJar?.enabled !== false,
        cookies: sanitizeJar(saved.cookieJar?.cookies),
      };
    saved.environment = Math.min(
      Math.max(0, saved.environment || 0),
      saved.environments.length - 1,
    );
    saved.active = saved.requests.some((request) => request.id === saved.active)
      ? saved.active
      : saved.requests[0].id;
    saved.tabs = Array.isArray(saved.tabs)
      ? [...new Set(saved.tabs.filter((id) => saved.requests.some((request) => request.id === id)))]
      : [saved.active!];
    return saved;
  }
  function newState(name: string): WorkspaceState {
    const request = makeRequest('Untitled request', 'GET', '{{base_url}}', 'My collection');
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
      settings: {
        ...DEFAULT_SETTINGS,
        theme: workspace.settings().theme,
        // Saving works as the person set it up, in every workspace they make.
        autoSave: workspace.settings().autoSave,
        autoSaveDelaySeconds: workspace.settings().autoSaveDelaySeconds,
        workspaceName: name,
      },
    };
  }
  /** Saves the open workspace now, before something that needs its files up to date. */
  const flush = (): Promise<void> => workspace.saveNow();
  /**
   * Before leaving the open workspace: with auto save off and changes not saved, asks whether to
   * save them first; false when the person stays.
   */
  const mustAskToLeave = () => workspace.unsaved && workspace.settings().autoSave === 'off';
  /**
   * Runs `leave` at once when nothing needs asking (so it starts in the same tick, as before), or
   * after the person agrees to save first.
   */
  function leaveThen(next: string, leave: () => void): void {
    if (!mustAskToLeave()) return leave();
    void readyToLeave(next).then((ok) => ok && leave());
  }
  async function readyToLeave(next: string): Promise<boolean> {
    if (!mustAskToLeave()) return true;
    return confirmAction({
      title: `Save changes to “${workspace.settings().workspaceName}”?`,
      message: `Auto save is off for this workspace. Its changes are saved before ${next} opens; cancel to keep working here.`,
      confirmLabel: 'Save and continue',
      cancelLabel: 'Stay here',
    });
  }

  // Switching
  function lockReason(): string {
    const vault = useVaultStore();
    if (useProtocolsStore().liveSessionsOpen())
      return 'Disconnect live sessions before making workspace changes.';
    if (
      ui.busy ||
      vault.oauthPending ||
      vault.providerCheckPending ||
      vault.loading ||
      vault.draft ||
      useTeamGitStore().git.busy
    )
      return 'Finish active requests, Git sync, and credential operations before making workspace changes.';
    if (workspace.persistenceBlocked)
      return 'Resolve the workspace storage error before making changes.';
    return '';
  }
  /** Loads a workspace and resets everything that belonged to the previous one. */
  async function install(id: string): Promise<void> {
    const saved = await service().switch(id);
    const name = manager.index.workspaces.find((item) => item.id === id)?.name || 'New workspace';
    const next = normalize(saved || newState(name));
    workspace.resetPersistence();
    const protocols = useProtocolsStore();
    protocols.live.clear();
    protocols.protocolUI.clear();
    useSourceEditorsStore().clearFormatCache();
    useRequestBodyStore().uploads.clear();
    workspace.state = next;
    manager.id = id;
    useRunnerStore().initialize();
    const vault = useVaultStore();
    vault.credentials = [];
    vault.providerChecks.clear();
    vault.providerFilter = 'all';
    vault.loaded = false;
    vault.loading = false;
    vault.status = null;
    vault.error = '';
    vault.draft = null;
    vault.filter = '';
    vault.oauthPending = '';
    const tools = useToolsStore();
    tools.dismissCodeGenerator();
    tools.consoleEntries.length = 0;
    tools.networkEntries.length = 0;
    const rows = useRequestRowsStore();
    rows.bulk = undefined;
    rows.automaticHeaders.expanded = false;
    useHTTPSettingsStore().scope = 'request';
    const response = useResponseStore();
    response.tab = 'Body';
    response.mode = 'Pretty';
    response.language = 'auto';
    useScreensStore().documentation.collection = '';
    ui.filter = '';
    ui.renamingRequestId = undefined;
    ui.collapsedFolders.clear();
    ui.requestTab = 'Params';
    Object.assign(ui.requestPanels, { code: false, request: true, response: true });
    ui.view = next.tabs?.length ? 'Collections' : 'Overview';
    ui.saveState = isTeam(id) ? 'Saved to the team folder' : 'Saved locally';
    manager.editing = '';
    manager.open = false;
    team.others = [];
    reported = undefined;
    useTeamGitStore().reset();
  }
  async function runOperation(operation: () => Promise<void>, label = 'Saving workspace…') {
    if (manager.busy) return;
    manager.error = lockReason();
    if (manager.error) {
      render();
      return;
    }
    manager.busy = true;
    manager.pendingLabel = label;
    manager.error = '';
    render();
    try {
      await operation();
      manager.index = await service().list();
    } catch (error) {
      manager.error = errorMessage(error);
    } finally {
      manager.busy = false;
      manager.pendingLabel = '';
      render();
      void nextTick(() => {
        if (!manager.open)
          document.querySelector<HTMLButtonElement>('[data-action=workspace]')?.focus();
        else if (manager.error)
          document.querySelector<HTMLElement>('#workspace-manager-error')?.focus();
        else document.querySelector<HTMLElement>('#workspace-detail-title')?.focus();
      });
    }
  }

  // The manager dialog
  async function open(): Promise<void> {
    if (manager.busy || manager.loading) return;
    Object.assign(manager, {
      error: '',
      editing: '',
      mode: 'details',
      selectedId: manager.id,
      query: '',
      draftName: '',
      nameError: '',
      open: true,
      loading: true,
    });
    render();
    try {
      manager.index = await service().list();
    } catch (error) {
      manager.error = errorMessage(error);
    } finally {
      manager.loading = false;
      if (manager.open) {
        render();
        void nextTick(() => document.querySelector<HTMLInputElement>('#workspace-search')?.focus());
      }
    }
  }
  async function refresh(): Promise<void> {
    if (manager.busy || manager.loading) return;
    manager.loading = true;
    manager.error = '';
    render();
    try {
      manager.index = await service().list();
      if (!manager.index.workspaces.some((item) => item.id === manager.selectedId)) {
        manager.selectedId = manager.id;
        if (manager.mode !== 'create') manager.mode = 'details';
      }
    } catch (error) {
      manager.error = errorMessage(error);
    } finally {
      manager.loading = false;
      if (manager.open) {
        render();
        void nextTick(() =>
          (
            document.querySelector<HTMLInputElement>('.workspace-editor-form input') ||
            document.querySelector<HTMLInputElement>('#workspace-search')
          )?.focus(),
        );
      }
    }
  }
  function close(): void {
    if (manager.busy) return;
    Object.assign(manager, { open: false, error: '', editing: '', draftName: '', mode: 'details' });
    render();
    document.querySelector<HTMLButtonElement>('[data-action=workspace]')?.focus();
  }
  function edit(
    mode: 'details' | 'create' | 'rename' | 'delete' | 'team',
    id = manager.selectedId,
  ): void {
    if (manager.busy || manager.loading) return;
    Object.assign(manager, {
      selectedId: id,
      mode,
      editing: mode === 'rename' ? id : '',
      error: '',
      nameError: '',
      draftName:
        mode === 'rename'
          ? manager.index.workspaces.find((item) => item.id === id)?.name || ''
          : '',
    });
    render();
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('.workspace-editor-form input');
      if (input) {
        input.focus();
        if (mode === 'rename') input.select();
      } else if (mode === 'team') {
        team.memberName = team.member?.name ?? '';
        team.memberError = '';
        document.querySelector<HTMLInputElement>('#team-member-name')?.focus();
      } else document.querySelector<HTMLElement>('#workspace-detail-title')?.focus();
    });
  }
  /**
   * Opens a team folder chosen in the system dialog, joining the workspace in it or starting one
   * in an empty folder; with `share`, copies this workspace into an empty folder instead. Your name
   * is saved first, since teammates see it in presence and history.
   */
  function openTeam(share: boolean): void {
    const bridge = window.workbench?.workspaces;
    if (!bridge?.openTeamFolder || !bridge.shareToFolder) {
      manager.error = 'Team workspaces require the desktop app.';
      render();
      return;
    }
    const name = checkedMemberName();
    if (!name) return;
    void runOperation(
      async () => {
        await flush();
        const item = share
          ? await bridge.shareToFolder!(workspace.persistedWorkspace(), name)
          : await bridge.openTeamFolder!(newState(''), name);
        team.member = (await bridge.member?.()) ?? team.member;
        // Cancelled in the folder dialog: the form stays as it was.
        if (!item) return;
        manager.index = await service().list();
        await install(item.id);
        toast(
          share
            ? `Shared “${item.name}”. Teammates can open the same folder to join.`
            : `Opened the team workspace “${item.name}”`,
          'success',
        );
      },
      share ? 'Sharing workspace…' : 'Opening team folder…',
    );
  }
  /** Your name for teammates, checked before a team folder is opened, shared, or cloned. */
  function checkedMemberName(): string | undefined {
    const name = team.memberName.trim();
    team.memberError = !name
      ? 'Enter your name.'
      : name.length > 60
        ? 'Use 60 characters or fewer.'
        : '';
    if (!team.memberError) return name;
    render();
    void nextTick(() => document.querySelector<HTMLInputElement>('#team-member-name')?.focus());
    return undefined;
  }
  /**
   * Clones a Git repository into a folder chosen in the system dialog and opens its team
   * workspace; a repository without one gets this workspace shared into it.
   */
  function cloneTeam(): void {
    const bridge = window.workbench?.workspaces;
    if (!bridge?.cloneTeam) {
      manager.error = 'Cloning requires the desktop app.';
      render();
      return;
    }
    team.cloneError = gitRemoteProblem(team.cloneURL);
    if (team.cloneError) {
      render();
      void nextTick(() => document.querySelector<HTMLInputElement>('#team-clone-url')?.focus());
      return;
    }
    const name = checkedMemberName();
    if (!name) return;
    void runOperation(async () => {
      await flush();
      const result = await bridge.cloneTeam!(
        team.cloneURL.trim(),
        workspace.persistedWorkspace(),
        name,
      );
      team.member = (await bridge.member?.()) ?? team.member;
      if (!result) return;
      team.cloneURL = '';
      manager.index = await service().list();
      await install(result.workspace.id);
      toast(
        result.shared
          ? `Cloned the repository and shared “${result.workspace.name}” into it. Open Workspaces → Git sync to push it.`
          : `Cloned and opened the team workspace “${result.workspace.name}”`,
        'success',
      );
    }, 'Cloning repository…');
  }
  function setCloneURL(value: string): void {
    team.cloneURL = value;
    team.cloneError = '';
  }
  function setMemberName(value: string): void {
    team.memberName = value;
    team.memberError = '';
  }
  function select(id: string): void {
    const name = manager.index.workspaces.find((item) => item.id === id)?.name ?? 'the workspace';
    leaveThen(
      `“${name}”`,
      () =>
        void runOperation(async () => {
          await flush();
          await install(id);
        }, 'Opening workspace…'),
    );
  }
  function deleteSelected(): void {
    const id = manager.selectedId;
    if (id === manager.id) return;
    void runOperation(async () => {
      await service().delete(id);
      manager.mode = 'details';
      manager.selectedId = manager.id;
    }, 'Deleting workspace…');
  }
  /** Creates a workspace and opens it, or renames the one being edited. */
  function submitName(value: string): void {
    manager.draftName = value;
    manager.nameError = nameError(value);
    if (manager.nameError) {
      render();
      void nextTick(() =>
        document.querySelector<HTMLInputElement>('.workspace-editor-form input')?.focus(),
      );
      return;
    }
    const name = value.trim(),
      creating = manager.mode === 'create',
      id = manager.editing;
    if (!creating && manager.index.workspaces.find((item) => item.id === id)?.name === name) {
      edit('details');
      return;
    }
    const proceed = () =>
      void runOperation(
        async () => {
          await flush();
          if (creating) {
            const item = await service().create(name, newState(name), manager.createLocation);
            // The folder picker was cancelled: the form stays, as filled in.
            if (!item) return;
            manager.createLocation = 'default';
            manager.index = { ...manager.index, workspaces: [...manager.index.workspaces, item] };
            manager.mode = 'details';
            manager.selectedId = item.id;
            manager.draftName = '';
            await install(item.id);
          } else {
            await service().rename(id, name);
            if (id === manager.id)
              workspace.state.settings = { ...workspace.settings(), workspaceName: name };
            manager.mode = 'details';
            manager.editing = '';
            manager.draftName = '';
          }
        },
        creating ? 'Creating workspace…' : 'Saving workspace name…',
      );
    if (creating) leaveThen(`“${name}”`, proceed);
    else proceed();
  }
  return {
    manager,
    team,
    currentEntry,
    isTeam,
    othersOn,
    openTeam,
    cloneTeam,
    setCloneURL,
    setMemberName,
    storageKey,
    saveSnapshot,
    initialize,
    normalize,
    flush,
    storage,
    loadStorage,
    changeStorageFolder,
    lockReason,
    open,
    refresh,
    close,
    edit,
    select,
    deleteSelected,
    submitName,
    initials,
    formatDate,
    nameError,
  };
});
