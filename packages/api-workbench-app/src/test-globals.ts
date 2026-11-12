import * as assertions from '@techieutils/api-workbench-common/assertions';
import * as secretProviders from '@techieutils/api-workbench-common/secret-providers';
import * as testCases from '@techieutils/api-workbench-common/test-cases';
import * as captures from '@techieutils/api-workbench-common/variables';
import { vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import { action } from './actions';
import { render } from './shell';
import { AUTH_TYPE_NAMES, migratedAuthType, useAuthenticationStore } from './stores/authentication';
import { useCookiesStore } from './stores/cookies';
import { useDialogsStore } from './stores/dialogs';
import { useHTTPSettingsStore } from './stores/http-settings';
import { useRequestBodyStore } from './stores/request-body';
import { useRequestRowsStore } from './stores/request-rows';
import { useRequestTabsStore } from './stores/request-tabs';
import { useRequestTestsStore } from './stores/request-tests';
import { useScriptsStore } from './stores/scripts';
import {
  requestMethodClass,
  requestMethodLabel,
  requestProtocol,
  useProtocolsStore,
} from './stores/protocols';
import { useRequestsStore } from './stores/requests';
import { useResponseStore } from './stores/response';
import { useRunnerStore } from './stores/runner';
import { useScreensStore } from './stores/screens';
import { useSettingsStore } from './stores/settings';
import { useUpdatesStore } from './stores/updates';
import { useSourceEditorsStore } from './stores/source-editors';
import { useToolsStore } from './stores/tools';
import { useUiStore } from './stores/ui';
import { defaultOAuth, useVaultStore } from './stores/vault';
import { makeRequest, useWorkspaceStore } from './stores/workspace';
import { useWorkspacesStore } from './stores/workspaces';
import { useTeamGitStore } from './stores/team-git';
import { useShareStore } from './stores/share';
import { useSpecsStore } from './stores/api-specs';
import { useMocksStore } from './stores/mocks';
import { download, errorMessage, toast, uid } from './utils';
import { clearToasts } from './notifications';

/**
 * Installs the renderer's state and actions as globals. The Electron smoke tests
 * (scripts/ui-smoke.ts, scripts/protocol-ui-smoke.ts) drive the app by evaluating code against
 * these names; the app itself never reads them.
 */
export function installTestGlobals(): void {
  const ui = useUiStore();
  const workspace = useWorkspaceStore();
  const settings = useSettingsStore();
  const httpSettings = useHTTPSettingsStore();
  const authentication = useAuthenticationStore();
  const requestRows = useRequestRowsStore();
  const response = useResponseStore();
  const tools = useToolsStore();
  const screens = useScreensStore();
  const vault = useVaultStore();
  const dialogs = useDialogsStore();
  const cookies = useCookiesStore();
  const requestTests = useRequestTestsStore();
  const runner = useRunnerStore();
  const workspaces = useWorkspacesStore();
  const teamGit = useTeamGitStore();
  const share = useShareStore();
  const requestTabs = useRequestTabsStore();
  const editors = useSourceEditorsStore();
  const requestBody = useRequestBodyStore();
  const protocols = useProtocolsStore();
  const requests = useRequestsStore();

  /** Exposes store state as a global, read and written through the store. */
  function bridge<S extends object>(store: S, names: (keyof S & string)[], writable = true): void {
    for (const name of names)
      Object.defineProperty(globalThis, name, {
        enumerable: true,
        get: () => store[name],
        set: writable ? (value: S[typeof name]) => (store[name] = value) : undefined,
      });
  }
  bridge(workspace, ['state']);
  bridge(ui, [
    'view',
    'filter',
    'requestTab',
    'busy',
    'activeRequestId',
    'saveState',
    'explorerCollapsed',
    'overviewBannerHidden',
    'renamingRequestId',
    'explorerWidth',
  ]);
  bridge(ui, ['collapsedFolders', 'requestPanels', 'devTools'], false);
  /** Exposes a store field under a different global name. */
  function alias<S extends object, K extends keyof S & string>(
    name: string,
    store: S,
    key: K,
    writable = true,
  ): void {
    Object.defineProperty(globalThis, name, {
      enumerable: true,
      get: () => store[key],
      set: writable ? (value: S[K]) => (store[key] = value) : undefined,
    });
  }
  // API specifications and mock servers are driven through their stores.
  // Update status is set directly, since a build run from source never finds an update.
  Object.assign(globalThis, {
    specsStore: useSpecsStore(),
    mocksStore: useMocksStore(),
    updatesStore: useUpdatesStore(),
  });
  alias('responseTab', response, 'tab');
  alias('responseMode', response, 'mode');
  alias('responseEditorLanguage', response, 'language');
  alias('responseFilter', response, 'filter');
  alias('compareUI', response, 'compare', false);
  alias('requestConsoleEntries', tools, 'consoleEntries', false);
  alias('networkEntries', tools, 'networkEntries', false);
  alias('consoleOptions', tools, 'consoleOptions', false);
  alias('codeDialog', tools, 'codeDialog');
  alias('historyUI', screens, 'history', false);
  alias('cookieUI', cookies, 'ui', false);
  alias('documentationState', screens, 'documentation', false);
  alias('credentials', vault, 'credentials');
  alias('credentialsLoaded', vault, 'loaded');
  alias('credentialsLoading', vault, 'loading');
  alias('vaultStatus', vault, 'status');
  alias('vaultError', vault, 'error');
  alias('credentialDraft', vault, 'draft');
  alias('credentialFilter', vault, 'filter');
  alias('credentialKindFilter', vault, 'kindFilter');
  alias('credentialProviderFilter', vault, 'providerFilter');
  alias('oauthPending', vault, 'oauthPending');
  alias('providerCheckPending', vault, 'providerCheckPending');
  alias('providerChecks', vault, 'providerChecks', false);
  alias('workspaceSearch', dialogs, 'search', false);
  alias('commandPalette', dialogs, 'palette', false);
  alias('recentCommands', dialogs, 'recentCommands', false);
  alias('transferUI', dialogs, 'transfer', false);
  alias('workspaceUI', workspaces, 'manager', false);
  alias('teamUI', workspaces, 'team', false);
  alias('teamGitUI', teamGit, 'git', false);
  alias('gistUI', share, 'gist', false);
  alias('runnerState', runner, 'run', false);
  // The stores keep their own names; the tests use the names these had as globals.
  Object.defineProperties(globalThis, {
    settingsSection: {
      enumerable: true,
      get: () => settings.section,
      set: (value: typeof settings.section) => (settings.section = value),
    },
    httpSettingsScope: {
      enumerable: true,
      get: () => httpSettings.scope,
      set: (value: typeof httpSettings.scope) => (httpSettings.scope = value),
    },
    authScope: {
      enumerable: true,
      get: () => authentication.scope,
      set: (value: typeof authentication.scope) => (authentication.scope = value),
    },
    bulkRowDraft: {
      enumerable: true,
      get: () => requestRows.bulk,
      set: (value: typeof requestRows.bulk) => (requestRows.bulk = value),
    },
    automaticHeaderVisibility: { enumerable: true, get: () => requestRows.automaticHeaders },
    httpSettingsFilter: { enumerable: true, get: () => httpSettings.filter },
    httpSettingsDrafts: { enumerable: true, get: () => httpSettings.drafts },
  });

  /** Installs store actions and helpers as globals. */
  function expose(functions: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(functions))
      Object.defineProperty(globalThis, name, { enumerable: true, value });
  }
  expose({
    cookieJarEnabled: cookies.enabled,
    cookieJar: cookies.jar,
    setCookieJar: cookies.setJar,
    storeResponseCookies: cookies.storeResponse,
    requestCookieJar: cookies.requestJar,
    clearCookies: cookies.clear,
    responseSnapshots: response.snapshots,
    recordResponseSnapshot: response.recordSnapshot,
    comparePair: response.comparePair,
    compareUnifiedText: response.compareUnifiedText,
    responseCertificateData: response.certificateData,
    captureResults: requestTests.captureResults,
    applyCaptures: requestTests.applyCaptures,
    addRequestConsoleEntry: tools.addConsoleEntry,
    consoleSafeError: tools.consoleSafeError,
    clientCertificates: settings.clientCertificates,
    requestClientCertificate: settings.requestClientCertificate,
    requestCertificateURL: settings.requestCertificateURL,
    setWorkspaceCA: settings.setWorkspaceCA,
    documentationRequests: screens.documentationRequests,
    readCredentialProvider: vault.readProvider,
    toggleExplorer: ui.toggleExplorer,
    setOverviewBannerHidden: ui.setOverviewBannerHidden,
    initializeRunner: runner.initialize,
    startRunner: runner.start,
    stopRunner: runner.stop,
    workspaceSearchResults: dialogs.searchResults,
    openWorkspaceSearch: dialogs.openSearch,
    openCommandPalette: dialogs.openPalette,
    closeCommandPalette: dialogs.closePalette,
    openCollectionTransfer: dialogs.openTransfer,
    closeCollectionTransfer: dialogs.closeTransfer,
    workspaceStorageKey: workspaces.storageKey,
    saveWorkspaceSnapshot: workspaces.saveSnapshot,
    initializeWorkspaces: workspaces.initialize,
    normalizeWorkspaceState: workspaces.normalize,
    flushCurrentWorkspace: workspaces.flush,
    openWorkspaceManager: workspaces.open,
    closeWorkspaceManager: workspaces.close,
    selectWorkspace: workspaces.select,
    rememberRequestTab: requestTabs.remember,
    closeRequestTabs: requestTabs.close,
    reopenLastRequestTab: requestTabs.reopenLast,
    paneLayout: ui.paneLayout,
    togglePaneLayout: ui.togglePaneLayout,
    toggleDevTools: ui.toggleDevTools,
    toggleResponseMaximized: ui.toggleResponseMaximized,
    setResponseFilter: (value: string) => void (response.filter = value),
    filteredResponseBody: response.filteredBody,
    responseInspectorSource: response.inspectorSource,
    formatRequestSource: editors.formatRequest,
    formatResponseSource: editors.formatResponse,
    uploadFiles: requestBody.uploads,
    bodyType: requestBody.bodyType,
    prepareRequestBody: requestBody.prepareBody,
    automaticRequestHeaders: requestRows.automaticRequestHeaders,
    openCodeGenerator: tools.openCodeGenerator,
    closeCodeGenerator: tools.closeCodeGenerator,
    updateCodeGeneration: tools.updateCodeGeneration,
    scheduleDockedCodeGeneration: tools.scheduleDockedCodeGeneration,
    collectionHTTPSettings: httpSettings.collectionSettings,
    effectiveRequestHTTPSettings: httpSettings.effectiveRequest,
    effectiveProtocolHTTPSettings: httpSettings.effectiveProtocol,
    requireDesktopHTTPSettings: httpSettings.requireDesktop,
    collectionAuth: authentication.collectionAuth,
    effectiveAuth: authentication.effectiveAuth,
    applyRequestAuth: authentication.applyRequestAuth,
    importedAuthOptions: authentication.importedAuthOptions,
    importedCollectionAuthConfig: authentication.importedCollectionAuthConfig,
    ensureInlineOAuthToken: authentication.ensureInlineOAuthToken,
    migratedAuthType,
    AUTH_TYPE_NAMES,
    liveProtocols: protocols.live,
    protocolUI: protocols.protocolUI,
    protocolUIState: protocols.protocolUIState,
    requestProtocol,
    requestMethodClass,
    requestMethodLabel,
    stopLiveProtocol: protocols.stopLiveProtocol,
    connectLiveProtocol: protocols.connectLiveProtocol,
    bindProtocols: protocols.bindProtocols,
    render,
    action,
    current: workspace.current,
    settings: workspace.settings,
    normalizedSettings: workspace.normalizedSettings,
    resolve: workspace.resolve,
    persist: workspace.persist,
    saveWorkspace: workspace.saveNow,
    workspaceUnsaved: () => workspace.unsaved,
    persistedWorkspace: workspace.persistedWorkspace,
    backupWorkspace: workspace.backupWorkspace,
    importCollection: workspace.importCollection,
    makeRequest,
    openRequest: requests.openRequest,
    prepare: requests.prepare,
    execute: requests.execute,
    runTests: requestTests.runTests,
    scriptsStore: useScriptsStore(),
    applyTheme: settings.applyTheme,
    openCredential: vault.openCredential,
    openCredentialsPage: vault.openCredentialsPage,
    loadCredentials: vault.loadCredentials,
    defaultOAuth,
    toast,
    clearToasts,
    download,
    errorMessage,
    uid,
    WorkbenchAssertions: assertions,
    WorkbenchSecretProviders: secretProviders,
    WorkbenchTestBuilder: testCases,
    WorkbenchCaptures: captures,
    vaultIssue,
  });
  // Editor handles the smoke tests read.
  Object.defineProperties(globalThis, {
    documentationEditor: { enumerable: true, get: () => screens.documentationEditor() },
    requestSourceEditor: { enumerable: true, get: () => editors.requestEditor() },
    responseSourceEditor: { enumerable: true, get: () => editors.responseEditor() },
    protocolResponseEditor: { enumerable: true, get: () => protocols.protocolResponseEditor() },
  });
  Object.assign(globalThis, {
    /** The CodeMirror view of the editor inside the element a selector names. */
    editorView: (selector: string) => WorkbenchEditor.viewOf(document.querySelector(selector)),
    /** Replaces an editor's text, as pasting it would, leaving the cursor at its end. */
    setEditorText: (selector: string, text: string) => {
      const view = WorkbenchEditor.viewOf(document.querySelector(selector));
      if (!view) throw new Error(`No editor in ${selector}`);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
    },
  });
}
