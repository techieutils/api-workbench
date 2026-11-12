import { contextBridge, ipcRenderer } from 'electron';
import type { WorkbenchBridge } from '@techieutils/api-workbench-common/types';
const bridge: WorkbenchBridge = {
  protocols: {
    start: (input) => ipcRenderer.invoke('protocol:start', input),
    send: (id, message, binary, options) =>
      ipcRenderer.invoke('protocol:send', id, message, binary, options),
    finish: (id) => ipcRenderer.invoke('protocol:finish', id),
    stop: (id) => ipcRenderer.invoke('protocol:stop', id),
    inspectProto: (proto) => ipcRenderer.invoke('protocol:inspect', proto),
    onEvent: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        update: import('@techieutils/api-workbench-common/types').ProtocolEvent,
      ) => callback(update);
      ipcRenderer.on('protocol:event', listener);
      return () => ipcRenderer.removeListener('protocol:event', listener);
    },
  },
  mocks: {
    status: () => ipcRenderer.invoke('mock:status'),
    start: (mock) => ipcRenderer.invoke('mock:start', mock),
    stop: (id) => ipcRenderer.invoke('mock:stop', id),
    onLog: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        entry: import('@techieutils/api-workbench-common/types').MockLogEntry,
      ) => callback(entry);
      ipcRenderer.on('mock:log', listener);
      return () => ipcRenderer.removeListener('mock:log', listener);
    },
  },
  interceptor: {
    status: () => ipcRenderer.invoke('interceptor:status'),
    start: (options) => ipcRenderer.invoke('interceptor:start', options),
    stop: () => ipcRenderer.invoke('interceptor:stop'),
    setRecording: (recording) => ipcRenderer.invoke('interceptor:recording', recording),
    exportAuthority: () => ipcRenderer.invoke('interceptor:exportAuthority'),
    trustAuthority: () => ipcRenderer.invoke('interceptor:trustAuthority'),
    resetAuthority: () => ipcRenderer.invoke('interceptor:resetAuthority'),
    onCapture: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        capture: import('@techieutils/api-workbench-common/types').InterceptorCapture,
      ) => callback(capture);
      ipcRenderer.on('interceptor:capture', listener);
      return () => ipcRenderer.removeListener('interceptor:capture', listener);
    },
  },
  // The terminal runs in a window of its own (terminal-preload.ts); this window can only open it,
  // or stage a command at a new terminal's prompt, and hear how many shells are running.
  terminalWindow: {
    open: () => ipcRenderer.invoke('terminal:open'),
    dock: (bounds) => ipcRenderer.invoke('terminal:dock', bounds),
    focus: () => ipcRenderer.invoke('terminal:focus'),
    expand: () => ipcRenderer.invoke('terminal:expand'),
    return: () => ipcRenderer.invoke('terminal:return'),
    onPlacement: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, where: 'panel' | 'window') =>
        callback(where);
      ipcRenderer.on('terminal:placement', listener);
      return () => ipcRenderer.removeListener('terminal:placement', listener);
    },
    onReveal: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('terminal:reveal', listener);
      return () => ipcRenderer.removeListener('terminal:reveal', listener);
    },
    type: (text) => ipcRenderer.invoke('terminal:type', text),
    onLive: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, count: number) => callback(count);
      ipcRenderer.on('terminal:live', listener);
      return () => ipcRenderer.removeListener('terminal:live', listener);
    },
  },
  setTheme: (theme) => ipcRenderer.invoke('appearance:theme', theme),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  restart: () => ipcRenderer.invoke('app:restart'),
  runnerResources: () => ipcRenderer.invoke('runner:resources'),
  scripts: {
    run: (input) => ipcRenderer.invoke('scripts:run', input),
    trusted: (sources) => ipcRenderer.invoke('scripts:trusted', sources),
    allow: (sources) => ipcRenderer.invoke('scripts:allow', sources),
    edited: (previous, next) => ipcRenderer.invoke('scripts:edited', previous, next),
  },
  codegen: {
    targets: (protocol) => ipcRenderer.invoke('codegen:targets', protocol),
    generate: (input, target, client) =>
      ipcRenderer.invoke('codegen:generate', input, target, client),
  },
  parseImportDocument: (text) => ipcRenderer.invoke('import:parse', text),
  importLink: (url) => ipcRenderer.invoke('import:link', url),
  gists: { publish: (input) => ipcRenderer.invoke('gist:publish', input) },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (name, state, location) =>
      ipcRenderer.invoke('workspaces:create', name, state, location),
    storage: () => ipcRenderer.invoke('workspaces:storage'),
    chooseStorageFolder: () => ipcRenderer.invoke('workspaces:choose-storage-folder'),
    resetStorageFolder: () => ipcRenderer.invoke('workspaces:reset-storage-folder'),
    setUnsaved: (changes, ask) => ipcRenderer.invoke('app:unsaved', changes, ask),
    onSaveBeforeClose: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('app:save-before-close', listener);
      return () => ipcRenderer.removeListener('app:save-before-close', listener);
    },
    closeReady: (saved) => ipcRenderer.invoke('app:close-ready', saved),
    switch: (id) => ipcRenderer.invoke('workspaces:switch', id),
    rename: (id, name) => ipcRenderer.invoke('workspaces:rename', id, name),
    delete: (id) => ipcRenderer.invoke('workspaces:delete', id),
    reveal: (folder) => ipcRenderer.invoke('workspaces:reveal', folder),
    openTeamFolder: (initial, memberName) =>
      ipcRenderer.invoke('workspaces:open-folder', initial, memberName),
    shareToFolder: (state, memberName) =>
      ipcRenderer.invoke('workspaces:share-folder', state, memberName),
    cloneTeam: (url, state, memberName) =>
      ipcRenderer.invoke('workspaces:clone-git', url, state, memberName),
    git: {
      status: () => ipcRenderer.invoke('git:status'),
      connect: (url) => ipcRenderer.invoke('git:connect', url),
      commit: (message) => ipcRenderer.invoke('git:commit', message),
      pull: (choice) => ipcRenderer.invoke('git:pull', choice),
      push: () => ipcRenderer.invoke('git:push'),
      sync: (message, choice) => ipcRenderer.invoke('git:sync', message, choice),
    },
    member: () => ipcRenderer.invoke('team:member'),
    setMemberName: (name) => ipcRenderer.invoke('team:set-member', name),
    setPresence: (requestId, requestName) =>
      ipcRenderer.invoke('team:set-presence', requestId, requestName),
    onPresence: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('@techieutils/api-workbench-common/types').TeamPresenceChange,
      ) => callback(change);
      ipcRenderer.on('team:presence', listener);
      return () => ipcRenderer.removeListener('team:presence', listener);
    },
    onWorkspaceChange: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('@techieutils/api-workbench-common/types').WorkspaceChange,
      ) => callback(change);
      ipcRenderer.on('workspace:changed', listener);
      return () => ipcRenderer.removeListener('workspace:changed', listener);
    },
    workspaceChangeApplied: (sequence) => ipcRenderer.invoke('workspace:change-applied', sequence),
    onIndexChange: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: import('@techieutils/api-workbench-common/types').WorkspaceIndexChange,
      ) => callback(change);
      ipcRenderer.on('workspaces:changed', listener);
      return () => ipcRenderer.removeListener('workspaces:changed', listener);
    },
  },
  load: (id) => ipcRenderer.invoke('state:load', id),
  save: (state, id) => ipcRenderer.invoke('state:save', state, id),
  send: (request) => ipcRenderer.invoke('request:send', request),
  cancel: (id) => ipcRenderer.invoke('request:cancel', id),
  vault: {
    setup: (password) => ipcRenderer.invoke('vault:setup', password),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
    recover: (recoveryKey, password) => ipcRenderer.invoke('vault:recover', recoveryKey, password),
    changePassword: (current, next) => ipcRenderer.invoke('vault:change-password', current, next),
    lock: () => ipcRenderer.invoke('vault:lock'),
    reset: () => ipcRenderer.invoke('vault:reset'),
    useWorkbench: (enabled) => ipcRenderer.invoke('vault:use-workbench', enabled),
    saveRecoveryKey: () => ipcRenderer.invoke('vault:save-recovery'),
    copyRecoveryKey: () => ipcRenderer.invoke('vault:copy-recovery'),
    finishSetup: () => ipcRenderer.invoke('vault:finish-setup'),
    onLocked: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('vault:locked', listener);
      return () => ipcRenderer.removeListener('vault:locked', listener);
    },
  },
  credentials: {
    test: (id) => ipcRenderer.invoke('credentials:test', id),
    list: () => ipcRenderer.invoke('credentials:list'),
    save: (input) => ipcRenderer.invoke('credentials:save', input),
    delete: (id) => ipcRenderer.invoke('credentials:delete', id),
    importCertificate: (entry, name) =>
      ipcRenderer.invoke('credentials:importCertificate', entry, name),
    status: () => ipcRenderer.invoke('credentials:status'),
  },
  certificates: {
    choose: (kind) => ipcRenderer.invoke('certificates:choose', kind),
    inspect: (payload) => ipcRenderer.invoke('certificates:inspect', payload),
  },
  updates: {
    info: () => ipcRenderer.invoke('updates:info'),
    setPreferences: (preferences) => ipcRenderer.invoke('updates:preferences', preferences),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChange: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        info: import('@techieutils/api-workbench-common/types').UpdateInfo,
      ) => callback(info);
      ipcRenderer.on('updates:changed', listener);
      return () => ipcRenderer.removeListener('updates:changed', listener);
    },
  },
  oauth: {
    authorize: (id) => ipcRenderer.invoke('oauth:authorize', id),
    refresh: (id) => ipcRenderer.invoke('oauth:refresh', id),
    cancel: () => ipcRenderer.invoke('oauth:cancel'),
    disconnect: (id) => ipcRenderer.invoke('oauth:disconnect', id),
    token: (input) => ipcRenderer.invoke('oauth:token', input),
    discover: (url) => ipcRenderer.invoke('oauth:discover', url),
  },
};
contextBridge.exposeInMainWorld('workbench', bridge);
