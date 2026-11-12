import type { SchemaState } from './core/graphql-schema';
import { credentialFrom, type CredentialsView } from './core/credentials';
import { environmentRowsFrom, type EnvironmentsView } from './core/environments';
import {
  certificatesView,
  hostProblem,
  portProblem,
  type CertificatesView,
} from './core/certificates';
import { testResultsView, type TestResultsView } from './core/test-results';
import { HELP_ITEMS, HELP_PAGES, diagnostics as supportDiagnostics } from './core/support';
import {
  bugReportUrl,
  featureRequestUrl,
  issueSearchUrl,
} from '@techieutils/api-workbench-common/support-links';
import { mockDraftFrom, mockUpdate as mockSettingsChange } from './core/mock-edit';
import {
  folderChoices,
  newRequestArgs,
  newRequestFrom,
  type NewRequestTarget,
  type NewRequestView,
} from './core/new-request';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  CliError,
  builtInEngine,
  findRuntime,
  processEngine,
  type CliProcess,
  type Engine,
} from './core/cli';
import { LOOPBACK, refusedHost, refusedHosts } from './core/hosts';
import {
  FINISH_LINE,
  LIVE_PROTOCOLS,
  liveDraftFrom,
  liveUpdatePlan,
  STOP_LINE,
  applyLiveEvent,
  liveEvent,
  sendLine,
  type LiveSettings,
  type LiveView,
} from './core/live';
import {
  draftFrom,
  runnerOptionsFrom,
  runnerResults,
  updatePlan,
  type ConsoleEntry,
  type DocsView,
  type RequestDraft,
  type RunnerOptions,
  type RunnerView,
} from './core/editing';
import { findRequestFile, isTeamFolder, teamFolderName } from './core/files';
import {
  bodyFiles,
  createArgs,
  savedBodyPlan,
  isSpecText,
  parseHttpFile,
  requestAtLine,
  type HttpFileRequest,
} from './core/http-file';
import {
  badgeOf,
  buildTree,
  requestDescription,
  requestsUnder,
  sourceKey,
  tagsOf,
  type FolderNode,
  type ListOutput,
  type ListedEnvironment,
  type ListedRequest,
  type Node,
  type Source,
} from './core/model';
import {
  outcomes,
  selectionArgs,
  statusLine,
  type RunReport,
  type SendResult,
} from './core/report';
import { renderResponse, responseTitle } from './core/response';
import {
  mockDetailsView,
  mockLine,
  networkEntry,
  networkView,
  requestView,
  responseView,
  type ListedMock,
  type MockView,
  type NetworkEntry,
  type RequestDetails,
  type RequestView,
  type ResponseView,
} from './core/views';
import {
  Workbench,
  type CertificateFiles,
  type CodeTarget,
  type CookieJar,
  type TeamGitResult,
  type HistoryEntry,
  type ListedSecret,
  type ListedSpec,
  type RequestPlace,
  type RunHosts,
  type RunUploads,
  type ScriptChoice,
} from './core/workbench';
import { NetworkView, Panel, type Action } from './panels';
import { registerScripts, scriptUri } from './scripts';
import {
  defaultMQTT,
  defaultSocketIO,
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import { registerTools } from './tools';

/**
 * API Workbench in VS Code: the team workspace folders in the open workspace and the app's own
 * workspaces — their collections, environments, specifications, mock servers, history, and saved
 * credentials — in the sidebar; a request editor and responses in editor tabs; `.http` files with
 * Send Request above each request; OpenAPI files checked as they are saved; and a network log in
 * the panel. Everything goes through the bundled api-workbench command line, so requests go out
 * exactly as the app sends them. Runs report to the Test Explorer.
 */

const RESPONSE_SCHEME = 'apiworkbench-response';
const SPEC_SCHEME = 'apiworkbench-spec';

/** What is known about one source after listing it. */
interface Loaded {
  source: Source;
  list?: ListOutput;
  tree: FolderNode[];
  error?: string;
}

type Item =
  | { type: 'source'; loaded: Loaded }
  | { type: 'folder'; loaded: Loaded; node: FolderNode }
  | { type: 'request'; loaded: Loaded; request: ListedRequest }
  | { type: 'message'; text: string };

/** A request of a `.http` file, as CodeLens and the editor's commands pass it. */
interface HttpTarget {
  uri: string;
  id: string;
}
/** An item of one of the side views: a source heading, a value of a source, or a message. */
type SideItem<T> =
  | { type: 'group'; loaded: Loaded }
  | { type: 'value'; loaded: Loaded; value: T }
  | { type: 'message'; text: string; command?: vscode.Command };

interface RunningMock {
  loaded: Loaded;
  mock: ListedMock;
  process?: CliProcess;
  view: MockView;
  stopping: boolean;
}

/**
 * What `activate` returns: read-only views of the extension's state, for its own tests in a real
 * editor (`src/test/host.ts`). Other extensions should not rely on it.
 */
export interface ExtensionApi {
  /** Resolves once the sources have been listed. */
  ready(): Promise<void>;
  sources(): { name: string; kind: string; requests: number; error?: string }[];
  /** A tree item to pass to the commands, as a click in the view does. */
  item(sourceName: string, requestId?: string): unknown;
  /** The last result of each test item run, by id: passed, failed, errored, or skipped. */
  results(): Record<string, string>;
  /** The response shown last, as the webview renders it. */
  lastResponse(): ResponseView | undefined;
  /** What the network log shows. */
  network(): ReturnType<typeof networkView>;
  /** What runs the command line's commands: its own process, or inside VS Code. */
  engine(): Promise<string>;
  /** A live request's editor, once it is open. */
  live(sourceName: string, requestId: string): LiveView | undefined;
  /** The document of a request's script, as **Edit in editor** opens it. */
  scriptUri(sourceName: string, requestId: string, phase: 'pre' | 'post'): vscode.Uri | undefined;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel('API Workbench');
  const responses = new Map<string, string>();
  const responseEvents = new vscode.EventEmitter<vscode.Uri>();
  const specTexts = new Map<string, string>();
  const treeEvents = new vscode.EventEmitter<void>();
  let loaded: Loaded[] = [];
  let loading: Promise<void> | undefined;
  let lastSource: Source | undefined;
  let lastResponse: ResponseView | undefined;
  /** Scripts choices made in "ask" mode, kept until the window closes. */
  const scriptChoices = new Map<string, ScriptChoice>();
  const lastResults: Record<string, string> = {};
  /**
   * The API Workbench vault's password — one vault for every workspace of the app's data folder —
   * typed this session or remembered in the system keychain; only ever given to the command line.
   */
  let vaultPassword: string | undefined;
  /** Where a remembered password is kept: VS Code's secret storage, in the system keychain. */
  const vaultSecretKey = () =>
    `vaultPassword:${settings().get<string>('dataDir')?.trim() || 'default'}`;
  let vaultRemembered = false;
  const mocks = new Map<string, RunningMock>();
  let network: NetworkEntry[] = [];
  /** The panel's Console: what was done in this window, and what went wrong. */
  let consoleLog: ConsoleEntry[] = [];
  /** Values captured by each `.http` file's requests, given to the requests sent after them. */
  const fileCaptures = new Map<string, Record<string, string>>();

  const settings = () => vscode.workspace.getConfiguration('apiWorkbench');
  /** Whether a source has saved credentials here: an app workspace, or a team folder the app has. */
  const hasVault = (source: Source) => source.kind === 'app' || Boolean(source.inApp);
  const environmentOf = (source: Source) =>
    context.workspaceState.get<string>(`environment:${sourceKey(source)}`);
  const tagsFor = (source: Source) =>
    context.workspaceState.get<string[]>(`tags:${sourceKey(source)}`) ?? [];
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const cancelled = (error: unknown) => error instanceof CliError && error.code === 130;

  // The command line: inside VS Code (`apiWorkbench.engine` is builtIn), or its own process with
  // Node.js 22.19+ — the setting, `node` on PATH, or the editor's own.
  let workbench: Promise<Workbench> | undefined;
  const getWorkbench = (): Promise<Workbench> =>
    (workbench ??= (async () => {
      const cliPath =
        settings().get<string>('cliPath')?.trim() ||
        context.asAbsolutePath(path.join('dist', 'cli', 'api-workbench.cjs'));
      const dataDir = settings().get<string>('dataDir')?.trim() || undefined;
      const ownProcess = async () => {
        const configured = settings().get<string>('nodePath')?.trim() || undefined;
        const runtime = await findRuntime({ configured, fallback: process.execPath });
        return processEngine(runtime, cliPath);
      };
      let engine: Engine;
      // Inside VS Code by default: a process for each command takes about a second to start.
      if (settings().get<string>('engine', 'builtIn') === 'builtIn')
        try {
          // Node's own require, so the bundled command line is loaded as it is shipped.
          engine = builtInEngine(cliPath, createRequire(__filename));
        } catch (error) {
          // An older VS Code's Node.js cannot load it: its own process still works.
          if (!(error instanceof CliError && error.unsupportedRuntime)) throw error;
          log(`${error.message} Using a process of its own instead.`, 'error');
          engine = await ownProcess();
        }
      else engine = await ownProcess();
      log(`Using ${engine.description}.`);
      return new Workbench(engine, dataDir);
    })().catch((error: unknown) => {
      workbench = undefined;
      throw error;
    }));

  /** Redraws the panel; set once it exists, as a line may be logged before. */
  let refreshPanel = () => undefined as void;
  /** A line in the output channel and the panel's Console. */
  const log = (text: string, level: ConsoleEntry['level'] = 'info') => {
    output.appendLine(level === 'error' ? `Error: ${text}` : text);
    consoleLog = [...consoleLog, { time: new Date().toLocaleTimeString(), level, text }].slice(
      -500,
    );
    refreshPanel();
  };
  const report = (error: unknown) => {
    const message = messageOf(error);
    log(message, 'error');
    void vscode.window.showErrorMessage(`API Workbench: ${message}`);
  };
  /** The method or protocol badge of a request, for the tree and its editor tab. */
  const badge = (request: { method: string; protocol: string }) => {
    const name = badgeOf(request);
    return {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'methods', `${name}-light.svg`),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'methods', `${name}-dark.svg`),
    };
  };
  /** Asks before something that cannot be undone; true when the person agreed. */
  const confirmed = async (message: string, action: string, detail?: string) =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;

  // Sources: team folders in the open workspace, then the app's workspaces.
  async function discover(): Promise<Source[]> {
    const sources: Source[] = [];
    const files = await vscode.workspace.findFiles('**/workspace.json', '**/node_modules/**', 100);
    for (const file of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath)))
      if (await isTeamFolder(file.fsPath)) {
        const folder = path.dirname(file.fsPath);
        sources.push({ kind: 'team', folder, name: await teamFolderName(folder) });
      }
    const workspaces = await (await getWorkbench()).appWorkspaces();
    // A team folder the app on this computer has open uses the app's vault and credential choices.
    const inApp = new Set(workspaces.map((workspace) => workspace.folder).filter(Boolean));
    for (const source of sources)
      if (source.kind === 'team' && inApp.has(source.folder)) source.inApp = true;
    if (settings().get<boolean>('showAppWorkspaces', true)) {
      const teamFolders = new Set(sources.map((source) => source.kind === 'team' && source.folder));
      for (const workspace of workspaces)
        // A team workspace opened in the app is shown once, as its folder, when it is here.
        if (!(workspace.folder && teamFolders.has(workspace.folder)))
          sources.push({
            kind: 'app',
            id: workspace.id,
            name: workspace.name,
            folder: workspace.folder,
          });
    }
    return sources;
  }

  async function load(): Promise<void> {
    const next: Loaded[] = [];
    try {
      const bench = await getWorkbench();
      for (const source of await discover()) {
        try {
          const list = await bench.list(source);
          next.push({ source, list, tree: buildTree(list) });
          // Start on the source's active environment, as the app does, until one is chosen.
          if (!environmentOf(source)) {
            const environments = await bench.environments(source).catch(() => []);
            const active =
              environments.find((environment) => environment.active) ?? environments[0];
            if (active)
              await context.workspaceState.update(`environment:${sourceKey(source)}`, active.name);
          }
        } catch (error) {
          next.push({ source, tree: [], error: messageOf(error) });
        }
      }
    } catch (error) {
      report(error);
    }
    loaded = next;
    // Keep the source last used across a refresh, which makes new source objects.
    const last =
      lastSource && next.find((entry) => sourceKey(entry.source) === sourceKey(lastSource!));
    lastSource = last?.source ?? next[0]?.source;
    treeEvents.fire();
    for (const view of sideViews) view.refresh();
    syncTests();
    updateStatus();
    void loadTeamStatus();
  }
  /** Each team folder's git state, shown beside it: branch, commits to push and pull, changes. */
  const teamStatus = new Map<string, TeamGitResult['status']>();
  async function loadTeamStatus(): Promise<void> {
    const bench = await getWorkbench().catch(() => undefined);
    if (!bench) return;
    for (const entry of loaded) {
      if (!entry.source.folder || entry.error) continue;
      const status = await bench
        .team(entry.source, 'status')
        .then((result) => result.status)
        .catch(() => undefined);
      if (status?.repository) teamStatus.set(sourceKey(entry.source), status);
      else teamStatus.delete(sourceKey(entry.source));
    }
    // Shows the team commands in menus and the palette only when there is a team folder in Git.
    void vscode.commands.executeCommand(
      'setContext',
      'apiWorkbench.hasTeamGit',
      teamStatus.size > 0,
    );
    treeEvents.fire();
  }
  const gitLabel = (status: TeamGitResult['status']) =>
    [
      status.branch ?? '',
      status.ahead ? `↑${status.ahead}` : '',
      status.behind ? `↓${status.behind}` : '',
      status.changeCount ? `${status.changeCount} changed` : '',
    ]
      .filter(Boolean)
      .join(' ');
  const refresh = () => (loading ??= load().finally(() => (loading = undefined)));
  const findLoaded = (source: Source) =>
    loaded.find((entry) => sourceKey(entry.source) === sourceKey(source));

  // The Collections view
  const sourceLabel = (item: Loaded) => {
    const environment = environmentOf(item.source);
    const tags = tagsFor(item.source);
    return [
      item.source.kind === 'team' ? 'team folder' : item.source.folder ? 'app · team' : 'app',
      environment,
      tags.length ? tags.map((tag) => `#${tag}`).join(' ') : '',
      teamStatus.has(sourceKey(item.source))
        ? gitLabel(teamStatus.get(sourceKey(item.source))!)
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: treeEvents.event,
    getChildren(item) {
      if (!item) {
        if (loading && !loaded.length) return [{ type: 'message', text: 'Loading…' }];
        return loaded.map((entry) => ({ type: 'source', loaded: entry }) as Item);
      }
      if (item.type === 'source') {
        if (item.loaded.error) return [{ type: 'message', text: item.loaded.error }];
        return item.loaded.tree.map(
          (node) => ({ type: 'folder', loaded: item.loaded, node }) as Item,
        );
      }
      if (item.type === 'folder')
        return item.node.children.map((node: Node) =>
          node.kind === 'folder'
            ? { type: 'folder', loaded: item.loaded, node }
            : { type: 'request', loaded: item.loaded, request: node.request },
        );
      return [];
    },
    getTreeItem(item) {
      if (item.type === 'message') {
        const tree = new vscode.TreeItem(item.text);
        tree.iconPath = new vscode.ThemeIcon('info');
        return tree;
      }
      if (item.type === 'source') {
        const tree = new vscode.TreeItem(
          item.loaded.source.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        tree.description = sourceLabel(item.loaded);
        tree.tooltip =
          item.loaded.source.kind === 'team'
            ? item.loaded.source.folder
            : `API Workbench workspace “${item.loaded.source.name}”`;
        tree.iconPath = new vscode.ThemeIcon(
          item.loaded.source.kind === 'team' ? 'repo' : 'device-desktop',
        );
        // `.git` when it is a team folder in a Git repository, for the team commands.
        tree.contextValue = item.loaded.error
          ? 'source.error'
          : `source.${item.loaded.source.kind}${teamStatus.has(sourceKey(item.loaded.source)) ? '.git' : ''}`;
        return tree;
      }
      if (item.type === 'folder') {
        const tree = new vscode.TreeItem(item.node.name, vscode.TreeItemCollapsibleState.Collapsed);
        tree.iconPath = new vscode.ThemeIcon(
          item.node.path.includes('/') ? 'folder' : 'folder-library',
        );
        tree.tooltip = item.node.path;
        // `.top` for a collection, `.sub` for a folder in one: some actions are for collections.
        tree.contextValue = `${
          requestsUnder(item.node).some((request) => request.runnable)
            ? 'folder.runnable'
            : 'folder'
        }.${item.node.path.includes('/') ? 'sub' : 'top'}`;
        return tree;
      }
      const tree = new vscode.TreeItem(item.request.name);
      // The method or protocol is the badge, as the app's explorer shows it; tags follow the name.
      tree.description = (item.request.tags ?? []).map((tag) => `#${tag}`).join(' ');
      tree.tooltip = `${requestDescription(item.request)}\n${item.request.folder}/${item.request.name}${
        item.request.runnable ? '' : '\nA live connection: open it to connect and send messages.'
      }`;
      tree.iconPath = badge(item.request);
      tree.accessibilityInformation = {
        label: `${item.request.protocol === 'http' ? item.request.method : item.request.protocol} ${item.request.name}`,
      };
      tree.contextValue = `request.${item.request.runnable ? 'runnable' : 'live'}.${item.loaded.source.kind}`;
      tree.command = { command: 'apiWorkbench.openRequest', title: 'Open', arguments: [item] };
      return tree;
    },
  };
  const view = vscode.window.createTreeView('apiWorkbench.explorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  view.onDidChangeSelection((event) => {
    const first = event.selection[0];
    if (first && first.type !== 'message') {
      lastSource = first.loaded.source;
      updateStatus();
    }
  });

  /**
   * A side view listing something of each source (environments, specifications, …), fetched
   * when shown and kept until the next refresh. With one source its values are listed directly.
   */
  function sideView<T>(
    id: string,
    options: {
      fetch: (bench: Workbench, entry: Loaded) => Promise<T[]>;
      item: (value: T, entry: Loaded) => vscode.TreeItem;
      sources?: (entry: Loaded) => boolean;
      empty: string;
      /** A message item for an error, such as a locked vault, instead of the error's text. */
      onError?: (error: unknown, entry: Loaded) => SideItem<T> | undefined;
      /** What is under a value, such as an environment's variables, for a collapsible item. */
      children?: (bench: Workbench, value: T, entry: Loaded) => Promise<T[]>;
    },
  ) {
    const events = new vscode.EventEmitter<void>();
    const cache = new Map<string, Promise<SideItem<T>[]>>();
    const valuesOf = (entry: Loaded): Promise<SideItem<T>[]> => {
      const key = sourceKey(entry.source);
      let found = cache.get(key);
      if (!found) {
        found = getWorkbench()
          .then((bench) => options.fetch(bench, entry))
          .then((values) =>
            values.length
              ? values.map((value) => ({ type: 'value', loaded: entry, value }) as SideItem<T>)
              : [{ type: 'message', text: options.empty } as SideItem<T>],
          )
          .catch(
            (error: unknown) =>
              [
                options.onError?.(error, entry) ?? { type: 'message', text: messageOf(error) },
              ] as SideItem<T>[],
          );
        cache.set(key, found);
      }
      return found;
    };
    const shown = () =>
      loaded.filter((entry) => !entry.error && (options.sources?.(entry) ?? true));
    const tree = vscode.window.createTreeView<SideItem<T>>(id, {
      treeDataProvider: {
        onDidChangeTreeData: events.event,
        async getChildren(item) {
          if (!item) {
            const entries = shown();
            if (loading && !loaded.length) return [{ type: 'message', text: 'Loading…' }];
            if (!entries.length) return [{ type: 'message', text: options.empty }];
            if (entries.length === 1) return valuesOf(entries[0]);
            return entries.map((entry) => ({ type: 'group', loaded: entry }) as SideItem<T>);
          }
          if (item.type === 'group') return valuesOf(item.loaded);
          if (item.type === 'value' && options.children) {
            const { loaded: entry, value } = item;
            const children = options.children;
            return getWorkbench()
              .then((bench) => children(bench, value, entry))
              .then((values) =>
                values.map(
                  (child) => ({ type: 'value', loaded: entry, value: child }) as SideItem<T>,
                ),
              )
              .catch((error: unknown) => [
                { type: 'message', text: messageOf(error) } as SideItem<T>,
              ]);
          }
          return [];
        },
        getTreeItem(item) {
          if (item.type === 'message') {
            const tree = new vscode.TreeItem(item.text);
            tree.iconPath = new vscode.ThemeIcon(item.command ? 'lock' : 'info');
            tree.command = item.command;
            return tree;
          }
          if (item.type === 'group') {
            const tree = new vscode.TreeItem(
              item.loaded.source.name,
              vscode.TreeItemCollapsibleState.Expanded,
            );
            tree.iconPath = new vscode.ThemeIcon(
              item.loaded.source.kind === 'team' ? 'repo' : 'device-desktop',
            );
            tree.contextValue = `group.${item.loaded.source.kind}`;
            return tree;
          }
          return options.item(item.value, item.loaded);
        },
      },
    });
    return {
      tree,
      refresh(source?: Source) {
        if (source) cache.delete(sourceKey(source));
        else cache.clear();
        events.fire();
      },
      dispose() {
        tree.dispose();
        events.dispose();
      },
    };
  }

  /** An environment, or one of its variables (whose value is hidden when it looks secret). */
  type EnvItem = ListedEnvironment & {
    variable?: { key: string; value: string; enabled: boolean };
  };
  const environmentsView = sideView<EnvItem>('apiWorkbench.environments', {
    fetch: (bench, entry) => bench.environments(entry.source),
    children: async (bench, environment, entry) =>
      environment.variable
        ? []
        : (await bench.environment(entry.source, environment.name)).variables.map((variable) => ({
            ...environment,
            variable,
          })),
    empty: 'No environments.',
    item(environment, entry) {
      if (environment.variable) {
        const { key, value, enabled } = environment.variable;
        const tree = new vscode.TreeItem(key);
        tree.description = `${value}${enabled ? '' : ' · off'}`;
        tree.tooltip = `${key} = ${value}${value === '<hidden>' ? '\nIts value is hidden, as its name looks secret.' : ''}`;
        tree.iconPath = new vscode.ThemeIcon(enabled ? 'symbol-variable' : 'circle-slash');
        tree.contextValue = 'variable';
        return tree;
      }
      const inUse = environment.name === environmentOf(entry.source);
      const tree = new vscode.TreeItem(
        environment.name,
        environment.variables
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      tree.description = [
        inUse ? 'in use' : '',
        `${environment.variables} variable${environment.variables === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      tree.iconPath = new vscode.ThemeIcon(
        inUse ? 'pass-filled' : 'circle-large-outline',
        inUse ? new vscode.ThemeColor('testing.iconPassed') : undefined,
      );
      tree.contextValue = inUse ? 'environment.inUse' : 'environment';
      tree.command = {
        command: 'apiWorkbench.openEnvironments',
        title: 'Open Environments',
        arguments: [{ type: 'value', loaded: entry, value: environment }],
      };
      tree.accessibilityInformation = {
        label: `${environment.name}${inUse ? ', in use' : ''}`,
      };
      return tree;
    },
  });

  type JarCookie = CookieJar['cookies'][number];
  const cookiesView = sideView<JarCookie>('apiWorkbench.cookies', {
    // Team folders keep no cookies; each teammate's are in their own app.
    sources: (entry) => entry.source.kind === 'app',
    fetch: async (bench, entry) => (await bench.cookies(entry.source)).cookies,
    empty: 'No cookies.',
    item(cookie) {
      const tree = new vscode.TreeItem(cookie.name);
      tree.description = `${cookie.domain}${cookie.path === '/' ? '' : cookie.path}`;
      tree.tooltip = [
        `${cookie.name} for ${cookie.domain}${cookie.path}`,
        `Expires: ${cookie.expires}`,
        [cookie.secure ? 'Secure' : '', cookie.httpOnly ? 'HttpOnly' : '']
          .filter(Boolean)
          .join(' · '),
        'Its value stays in the app.',
      ]
        .filter(Boolean)
        .join('\n');
      tree.iconPath = new vscode.ThemeIcon('globe');
      tree.contextValue = 'cookie';
      return tree;
    },
  });

  const specsView = sideView<ListedSpec>('apiWorkbench.specs', {
    fetch: (bench, entry) => bench.specs(entry.source),
    empty: 'No API specifications.',
    item(spec) {
      const tree = new vscode.TreeItem(spec.name);
      tree.description = [
        spec.version,
        spec.errors ? `${spec.errors} error${spec.errors === 1 ? '' : 's'}` : 'valid',
        `${spec.operations} operation${spec.operations === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · ');
      tree.iconPath = new vscode.ThemeIcon(
        spec.errors ? 'warning' : 'symbol-interface',
        spec.errors ? new vscode.ThemeColor('problemsErrorIcon.foreground') : undefined,
      );
      tree.contextValue = 'spec';
      tree.tooltip = spec.collection ? `Generates “${spec.collection}”` : undefined;
      return tree;
    },
  });
  specsView.tree.onDidChangeSelection((event) => {
    const first = event.selection[0];
    if (first?.type === 'value') void openSpec(first.loaded, first.value);
  });

  const mockKey = (entry: Loaded, mock: ListedMock) => `${sourceKey(entry.source)}#${mock.id}`;
  const mocksView = sideView<ListedMock>('apiWorkbench.mocks', {
    fetch: (bench, entry) => bench.mocks(entry.source),
    empty: 'No mock servers.',
    item(mock, entry) {
      const running = mocks.get(mockKey(entry, mock));
      const live = running?.view.running;
      const tree = new vscode.TreeItem(mock.name);
      tree.description = live
        ? `${mock.https ? 'https ' : ''}:${running?.view.url?.split(':').pop() ?? mock.port}`
        : running?.process
          ? 'starting…'
          : 'stopped';
      tree.iconPath = new vscode.ThemeIcon(
        live ? 'circle-filled' : 'circle-outline',
        live ? new vscode.ThemeColor('testing.iconPassed') : undefined,
      );
      tree.accessibilityInformation = { label: `${mock.name}, ${tree.description}` };
      tree.tooltip = `${mock.routes} route${mock.routes === 1 ? '' : 's'} · port ${mock.port}`;
      tree.contextValue = live || running?.process ? 'mock.running' : 'mock.stopped';
      tree.command = {
        command: 'apiWorkbench.openMock',
        title: 'Open Mock Server',
        arguments: [{ type: 'value', loaded: entry, value: mock }],
      };
      return tree;
    },
  });

  const historyView = sideView<HistoryEntry>('apiWorkbench.history', {
    // A team folder opened here is read as a teammate who just joined, with no history of its own.
    sources: (entry) => entry.source.kind === 'app',
    fetch: (bench, entry) => bench.history(entry.source),
    empty: 'Nothing sent yet.',
    item(entry, loadedEntry) {
      const tree = new vscode.TreeItem(entry.request ?? entry.url);
      tree.description = [
        entry.method,
        entry.status === undefined ? 'no response' : String(entry.status),
        entry.timeMs === undefined ? '' : `${Math.round(entry.timeMs)} ms`,
        new Date(entry.date).toLocaleString(),
      ]
        .filter(Boolean)
        .join(' · ');
      tree.tooltip = `${entry.method} ${entry.url}${entry.author ? `\nSent by ${entry.author}` : ''}`;
      const failed = entry.status === undefined || entry.status >= 400;
      tree.iconPath = new vscode.ThemeIcon(
        failed ? 'error' : 'history',
        failed ? new vscode.ThemeColor('testing.iconFailed') : undefined,
      );
      const request = loadedEntry.list?.requests.find((r) => r.name === entry.request);
      tree.contextValue = request?.runnable ? 'history.request' : 'history';
      if (request)
        tree.command = {
          command: 'apiWorkbench.openRequest',
          title: 'Open',
          arguments: [{ type: 'request', loaded: loadedEntry, request } satisfies Item],
        };
      return tree;
    },
  });

  const credentialsView = sideView<ListedSecret>('apiWorkbench.credentials', {
    // A team folder's are each teammate's own, in their app: listed when this computer's app has it.
    sources: (entry) => hasVault(entry.source),
    fetch: (bench, entry) => bench.secrets(entry.source, vaultPassword),
    empty: 'No saved credentials.',
    onError(error, entry) {
      if (/vault is locked|password/i.test(messageOf(error)))
        return {
          type: 'message',
          text:
            vaultPassword !== undefined
              ? 'Wrong password — unlock again'
              : 'Locked — unlock to list saved credentials',
          command: {
            command: 'apiWorkbench.unlockVault',
            title: 'Unlock Credential Vault',
            arguments: [{ type: 'group', loaded: entry }],
          },
        };
      return undefined;
    },
    item(secret) {
      const tree = new vscode.TreeItem(secret.name);
      tree.description = [secret.type, secret.origin].filter(Boolean).join(' · ');
      tree.tooltip = `${secret.name}: ${secret.type}, sent only to ${secret.origin}. Its value stays in the vault.`;
      tree.iconPath = new vscode.ThemeIcon('key');
      tree.contextValue = 'secret';
      return tree;
    },
  });
  const sideViews = [
    environmentsView,
    specsView,
    mocksView,
    historyView,
    credentialsView,
    cookiesView,
  ];

  // The Test Explorer: one item per source, folder, and runnable request.
  const tests = vscode.tests.createTestController('apiWorkbench', 'API Workbench');
  const testRequests = new Map<string, { loaded: Loaded; requests: ListedRequest[] }>();
  function syncTests(): void {
    testRequests.clear();
    const items: vscode.TestItem[] = [];
    const add = (
      loaded: Loaded,
      id: string,
      label: string,
      requests: ListedRequest[],
      uri?: vscode.Uri,
    ) => {
      const item = tests.createTestItem(id, label, uri);
      testRequests.set(id, { loaded, requests });
      return item;
    };
    for (const entry of loaded) {
      if (!entry.list) continue;
      const key = sourceKey(entry.source);
      const runnable = entry.list.requests.filter((request) => request.runnable);
      if (!runnable.length) continue;
      const root = add(entry, key, entry.source.name, runnable);
      const walk = (parent: vscode.TestItem, nodes: Node[]) => {
        for (const node of nodes) {
          if (node.kind === 'request') {
            if (node.request.runnable)
              parent.children.add(
                add(entry, `${key}#${node.request.id}`, node.request.name, [node.request]),
              );
            continue;
          }
          const under = requestsUnder(node).filter((request) => request.runnable);
          if (!under.length) continue;
          const folder = add(entry, `${key}/${node.path}`, node.name, under);
          parent.children.add(folder);
          walk(folder, node.children);
        }
      };
      walk(root, entry.tree);
      items.push(root);
    }
    tests.items.replace(items);
  }

  async function scriptsFor(key: string, error: CliError): Promise<ScriptChoice> {
    const setting = settings().get<string>('scripts', 'ask');
    if (setting === 'allow' || setting === 'skip') return setting;
    const remembered = scriptChoices.get(key);
    if (remembered) return remembered;
    const run = 'Run scripts';
    const skip = 'Run without scripts';
    const answer = await vscode.window.showWarningMessage(
      'These requests have pre-request or post-response scripts, which run code from the workspace.',
      {
        modal: true,
        detail: `${error.message}\n\nThe choice is kept until this window closes; set "apiWorkbench.scripts" to choose for good.`,
      },
      run,
      skip,
    );
    const choice: ScriptChoice = answer === run ? 'allow' : answer === skip ? 'skip' : undefined;
    if (choice) scriptChoices.set(key, choice);
    return choice;
  }
  const initialScripts = (key: string): ScriptChoice => {
    const setting = settings().get<string>('scripts', 'ask');
    if (setting === 'allow' || setting === 'skip') return setting;
    return scriptChoices.get(key);
  };

  /** Runs `action` with the scripts choice, asking once when the command line needs one. */
  async function withScripts<T>(
    key: string,
    action: (scripts: ScriptChoice) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await action(initialScripts(key));
    } catch (error) {
      if (!(error instanceof CliError && error.needsScriptChoice)) throw error;
      const choice = await scriptsFor(key, error);
      return choice ? action(choice) : undefined;
    }
  }

  /** Hosts this workspace's `.http` files may send to without asking, as the person chose. */
  const ALLOWED_HOSTS = 'apiWorkbench.allowedHosts';
  const approvedHosts = () => context.workspaceState.get<string[]>(ALLOWED_HOSTS, []);
  /** Whether sends from `source` ask before a new host: a team folder comes with a repository. */
  const guardsHosts = (source: Source) =>
    source.kind === 'team' && settings().get<boolean>('confirmNewHosts', true);
  /**
   * Asks whether to send to `hosts`, which no request from this workspace has gone to: "once"
   * for this time, "always" to remember them for the workspace (done here), or undefined.
   */
  async function approveHosts(
    from: string,
    hosts: string[],
    what: { once: string; detail: string; note?: string },
  ): Promise<'once' | 'always' | undefined> {
    const always = hosts.length === 1 ? 'Always Allow This Host' : 'Always Allow These Hosts';
    const named =
      hosts.length === 1 ? hosts[0] : `${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1)}`;
    const answer = await vscode.window.showWarningMessage(
      `Send to ${named}?`,
      {
        modal: true,
        detail: `${from} ${what.detail} ${named}, which no request from this workspace has gone to yet. Headers and bodies go there, with the values your environment and earlier responses fill in.${what.note ? ` ${what.note}` : ''}\n\nRequests to this computer never ask. "API Workbench: Forget Approved Hosts" asks again; "apiWorkbench.confirmNewHosts" turns this off.`,
      },
      what.once,
      always,
    );
    if (answer === always) {
      await context.workspaceState.update(ALLOWED_HOSTS, [
        ...new Set([...approvedHosts(), ...hosts]),
      ]);
      return 'always';
    }
    return answer === what.once ? 'once' : undefined;
  }
  /**
   * Sends one request so it goes only to this computer and hosts approved for the workspace,
   * asking before the first send anywhere else: a `.http` file or a team folder from a
   * repository can point a request at any server, with the environment's values and captured
   * tokens in it. `from` names where the request comes from, for the question.
   */
  async function withHosts<T>(
    from: string,
    action: (allowedHosts: Iterable<string> | undefined) => Promise<T>,
    guarded = settings().get<boolean>('confirmNewHosts', true),
  ): Promise<T | undefined> {
    if (!guarded) return action(undefined);
    const allowed = new Set(approvedHosts());
    for (;;) {
      try {
        return await action(allowed);
      } catch (error) {
        const host = error instanceof CliError ? error.refusedHost : undefined;
        if (!host || allowed.has(host)) throw error;
        const answer = await approveHosts(from, [host], {
          once: 'Send',
          detail: 'sends this request to',
        });
        if (!answer) return undefined;
        allowed.add(host);
      }
    }
  }
  /**
   * A run of a team folder's requests, as `withHosts` sends one. First it asks where the run
   * would go (`run --list-hosts`, which sends nothing) and asks about every host not yet approved,
   * before anything is sent. A host only the run can know — one an earlier response's capture
   * fills in — fails unsent instead, and is asked about afterwards, with a run again.
   */
  async function withRunHosts<T extends { report: { results?: { error?: string }[] } }>(
    source: Source,
    preflight: () => Promise<RunHosts>,
    action: (allowedHosts: Iterable<string> | undefined) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (!guardsHosts(source)) return action(undefined);
    const allowed = new Set([...LOOPBACK, ...approvedHosts()]);
    // A command line that cannot list hosts still checks each request as it is sent.
    const planned = await preflight().catch(() => undefined);
    const ahead = (planned?.hosts ?? []).filter((host) => !allowed.has(host));
    if (ahead.length) {
      const answer = await approveHosts(source.name, ahead, {
        once: 'Run',
        detail: 'will send requests to',
      });
      if (!answer) return undefined;
      for (const host of ahead) allowed.add(host);
    }
    const result = await action(allowed);
    const refused = refusedHosts(result?.report.results).filter((host) => !allowed.has(host));
    if (!result || !refused.length) return result;
    const answer = await approveHosts(source.name, refused, {
      once: 'Run Again',
      detail: `has requests that were not sent, as values from earlier responses send them to`,
      note: 'Running again sends the run’s other requests again too.',
    });
    if (!answer) return result;
    for (const host of refused) allowed.add(host);
    // The run's other requests were already sent; running again sends them again, as asked.
    return action(allowed);
  }

  // The panel: every send and run from VS Code this session, what was done, and how fast.
  const clearPanel = () => {
    network = [];
    consoleLog = [];
    networkPanel.refresh();
  };
  const networkPanel = new NetworkView(
    context.extensionUri,
    () => networkView(network, consoleLog),
    (action) => {
      if (action === 'clear') clearPanel();
    },
  );
  refreshPanel = () => networkPanel.refresh();
  const logSend = (result: SendResult, startedAt = Date.now() - (result.durationMs ?? 0)) => {
    network = [...network, networkEntry(result, startedAt)].slice(-1000);
    networkPanel.refresh();
  };

  async function runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = tests.createTestRun(request);
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    // The requests chosen, by source, less those excluded.
    const chosen = new Map<string, { loaded: Loaded; requests: ListedRequest[] }>();
    const include = request.include ?? [...tests.items].map(([, item]) => item);
    const excluded = new Set(
      (request.exclude ?? []).flatMap(
        (item) => testRequests.get(item.id)?.requests.map((r) => r.id) ?? [],
      ),
    );
    for (const item of include) {
      const entry = testRequests.get(item.id);
      if (!entry) continue;
      const key = sourceKey(entry.loaded.source);
      const group = chosen.get(key) ?? { loaded: entry.loaded, requests: [] };
      group.requests.push(...entry.requests.filter((r) => !excluded.has(r.id)));
      chosen.set(key, group);
    }
    try {
      const bench = await getWorkbench();
      for (const [key, group] of chosen) {
        if (token.isCancellationRequested) break;
        // One entry per request, though it may be chosen through its folder and itself.
        const items = new Map(group.requests.map((r) => [r.id, findTest(`${key}#${r.id}`)]));
        const selection = selectionArgs(group.requests, group.loaded.list?.requests ?? []);
        if (!selection) continue;
        for (const item of items.values()) if (item) run.started(item);
        const source = group.loaded.source;
        const startedAt = Date.now();
        try {
          const result = await withScripts(key, (scripts) =>
            withRunHosts(
              source,
              () =>
                bench.runHosts(source, {
                  selection,
                  environment: environmentOf(source),
                  tags: tagsFor(source),
                }),
              (allowedHosts) =>
                bench.run(source, {
                  selection,
                  environment: environmentOf(source),
                  tags: tagsFor(source),
                  scripts,
                  signal: abort.signal,
                  password: vaultPassword,
                  uploads: runUploads(source),
                  ...(allowedHosts ? { allowedHosts } : {}),
                }),
            ),
          );
          if (!result) {
            for (const item of items.values()) if (item) run.skipped(item);
            continue;
          }
          run.appendOutput(result.output.replace(/\r?\n/g, '\r\n'));
          // The results as a page, as the app's runner shows them, unless turned off.
          if (settings().get<boolean>('showTestResults', true))
            showTestResults(group.loaded, result.report, result.output, request);
          // The run's requests went one after another, so each starts where the last ended.
          let at = startedAt;
          for (const sent of result.report.results) {
            logSend(sent, at);
            at += sent.durationMs ?? 0;
          }
          const found = outcomes(result.report);
          for (const [id, item] of items) {
            if (!item) continue;
            const outcome = found.get(id);
            // Not sent: left out by the tag filter, or the run stopped first.
            lastResults[item.id] = outcome?.state ?? 'skipped';
            if (!outcome) run.skipped(item);
            else if (outcome.state === 'passed') run.passed(item, outcome.durationMs);
            else {
              const messages = outcome.messages.map((text) => new vscode.TestMessage(text));
              if (outcome.state === 'errored') run.errored(item, messages, outcome.durationMs);
              else run.failed(item, messages, outcome.durationMs);
            }
          }
        } catch (error) {
          const message = new vscode.TestMessage(messageOf(error));
          for (const item of items.values())
            if (item) {
              lastResults[item.id] = 'errored';
              run.errored(item, message);
            }
          if (!cancelled(error)) report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      run.end();
    }
  }
  /** The last run of each source's results page, to run again. */
  const lastRuns = new Map<string, vscode.TestRunRequest>();
  /** Opens or updates a source's Test results page with a finished run. */
  function showTestResults(
    entry: Loaded,
    report: RunReport,
    output: string,
    request: vscode.TestRunRequest,
  ): void {
    const key = `results:${sourceKey(entry.source)}`;
    lastRuns.set(key, request);
    const labels = (request.include ?? []).map((item) => item.label);
    const view = testResultsView(report, output, {
      workspace: entry.source.name,
      scope: labels.length ? labels.join(', ') : 'Every request',
      environment: environmentOf(entry.source),
      finishedAt: new Date().toLocaleTimeString(),
    });
    const title = `Test results · ${entry.source.name}`;
    const existing = Panel.get<TestResultsView>(key);
    if (existing) {
      existing.update(view, title);
      existing.reveal(vscode.ViewColumn.Beside);
      return;
    }
    new Panel<TestResultsView>(
      key,
      context.extensionUri,
      title,
      view,
      (action, _panel, value) => {
        if (action === 'showOutput')
          void vscode.commands.executeCommand('testing.showMostRecentOutput');
        else if (action === 'rerun') {
          const again = lastRuns.get(key);
          if (!again) return;
          const cancel = new vscode.CancellationTokenSource();
          void runTests(again, cancel.token).finally(() => cancel.dispose());
        } else if (action === 'openRequest' && typeof value === 'string') {
          const fresh = findLoaded(entry.source);
          const found = fresh?.list?.requests.find((item) => item.id === value);
          if (fresh && found) void openRequest({ type: 'request', loaded: fresh, request: found });
        }
      },
      vscode.ViewColumn.Beside,
    );
  }
  const findTest = (id: string): vscode.TestItem | undefined => {
    let found: vscode.TestItem | undefined;
    const visit = (collection: vscode.TestItemCollection) =>
      collection.forEach((item) => {
        if (found) return;
        if (item.id === id) found = item;
        else visit(item.children);
      });
    visit(tests.items);
    return found;
  };
  tests.createRunProfile('Run', vscode.TestRunProfileKind.Run, runTests, true);

  // .http files: the workspace environment their {{variables}} come from, under their own.
  const HTTP_ENVIRONMENT = 'httpEnvironment';
  type HttpEnvironmentChoice = { key: string; environment?: string } | 'none';
  /** The team folder a file is in, the innermost when one is inside another. */
  const teamFolderOf = (file: string) =>
    loaded
      .filter((entry) => !entry.error && entry.source.kind === 'team' && entry.source.folder)
      .filter((entry) => {
        const relative = path.relative(entry.source.folder!, file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      })
      .sort((a, b) => b.source.folder!.length - a.source.folder!.length)[0];
  /**
   * The environment a `.http` file's requests use: the one chosen with Choose .http Environment…,
   * or else the environment in use of the team folder the file is in; none otherwise.
   */
  const httpEnvironmentFor = (
    document: vscode.TextDocument,
  ): { source: Source; name?: string } | undefined => {
    const choice = context.workspaceState.get<HttpEnvironmentChoice>(HTTP_ENVIRONMENT);
    if (choice === 'none') return undefined;
    if (choice) {
      const entry = loaded.find((item) => !item.error && sourceKey(item.source) === choice.key);
      if (entry)
        return { source: entry.source, name: choice.environment ?? environmentOf(entry.source) };
    }
    const entry = document.uri.scheme === 'file' ? teamFolderOf(document.uri.fsPath) : undefined;
    return entry ? { source: entry.source, name: environmentOf(entry.source) } : undefined;
  };
  const httpStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  httpStatus.command = 'apiWorkbench.chooseHttpEnvironment';
  httpStatus.name = 'API Workbench .http Environment';
  function updateHttpStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== 'http') return httpStatus.hide();
    const chosen = httpEnvironmentFor(document);
    httpStatus.text = chosen
      ? `$(layers) .http: ${chosen.name ?? 'its environment'} (${chosen.source.name})`
      : '$(layers) .http: file variables';
    httpStatus.tooltip = chosen
      ? `{{variables}} in this file come from ${chosen.source.name}'s ${chosen.name ?? 'environment in use'}, under the file's own @variables — click to change`
      : "{{variables}} in this file come only from its own @variables and captured values — click to use a workspace's environment";
    httpStatus.show();
  }
  // The status bar: the environment in use, and the mock servers running.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'apiWorkbench.selectEnvironment';
  status.name = 'API Workbench Environment';
  function updateStatus(): void {
    // A .http file's environment follows its team folder's.
    updateHttpStatus();
    if (!lastSource) return status.hide();
    status.text = `$(layers) ${environmentOf(lastSource) ?? 'No environment'}`;
    status.tooltip = `API Workbench environment for ${lastSource.name} — click to change`;
    status.show();
  }
  const mockStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
  mockStatus.name = 'API Workbench Mock Servers';
  function updateMockStatus(): void {
    const running = [...mocks.values()].filter((mock) => mock.view.running);
    if (!running.length) return mockStatus.hide();
    const port = (mock: RunningMock) => mock.view.url?.split(':').pop() ?? String(mock.mock.port);
    mockStatus.text =
      running.length === 1
        ? `$(server) Mock :${port(running[0])}`
        : `$(server) ${running.length} mocks`;
    mockStatus.tooltip = running
      .map((mock) => `${mock.mock.name} — ${mock.view.url ?? ''}`)
      .join('\n');
    mockStatus.command = {
      command: 'apiWorkbench.openMock',
      title: 'Open Mock Server',
      arguments: [{ type: 'value', loaded: running[0].loaded, value: running[0].mock }],
    };
    mockStatus.show();
  }

  // The vault: unlocked while a password typed this session is held, until locked again.
  const vaultStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 18);
  vaultStatus.name = 'API Workbench Vault';
  vaultStatus.text = '$(unlock) Vault unlocked';
  vaultStatus.tooltip = 'API Workbench credentials are unlocked in this window — click to lock';
  vaultStatus.command = 'apiWorkbench.lockVault';
  const updateVaultStatus = () => {
    vaultStatus.text = vaultRemembered
      ? '$(unlock) Vault unlocked (keychain)'
      : '$(unlock) Vault unlocked';
    vaultStatus.tooltip = vaultRemembered
      ? 'API Workbench credentials unlock with the password remembered in the system keychain — click to lock this window'
      : 'API Workbench credentials are unlocked in this window — click to lock';
    if (vaultPassword !== undefined) vaultStatus.show();
    else vaultStatus.hide();
  };
  // A password remembered in the system keychain unlocks the vault as the window opens.
  void Promise.resolve(context.secrets.get(vaultSecretKey())).then((saved) => {
    if (!saved || vaultPassword !== undefined) return;
    vaultPassword = saved;
    vaultRemembered = true;
    updateVaultStatus();
    credentialsView.refresh();
  });

  async function pickSource(
    item?: Item | SideItem<unknown>,
    placeHolder = 'Choose a workspace',
  ): Promise<Loaded | undefined> {
    if (item && item.type !== 'message') return item.loaded;
    const usable = loaded.filter((entry) => !entry.error);
    if (usable.length <= 1) return usable[0];
    const picked = await vscode.window.showQuickPick(
      usable.map((entry) => ({
        label: entry.source.name,
        description: sourceLabel(entry),
        iconPath: new vscode.ThemeIcon(entry.source.kind === 'team' ? 'repo' : 'device-desktop'),
        entry,
      })),
      { placeHolder, prompt: 'Team folders are in this repository; the others are the app’s.' },
    );
    return picked?.entry;
  }

  /** Opens one of API Workbench's own pages (GitHub, the documentation) in the browser. */
  const openPage = async (url: string) => {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  };
  /** Versions and platform for a bug report, as `core/support.ts` writes them. */
  const diagnosticText = async () => {
    let cliVersion: string | undefined;
    try {
      cliVersion = await (await getWorkbench()).version();
    } catch {
      /* Said by its absence: the command line could not run. */
    }
    return supportDiagnostics({
      extensionVersion: String(context.extension.packageJSON.version ?? ''),
      vscodeVersion: vscode.version,
      appName: vscode.env.appName,
      platform: process.platform,
      arch: process.arch,
      engine: settings().get<string>('engine', 'builtIn'),
      cliVersion,
      remote: vscode.env.remoteName,
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      teamFolders: loaded.filter((entry) => entry.source.kind === 'team').length,
      appWorkspaces: loaded.filter((entry) => entry.source.kind === 'app').length,
    });
  };
  // The .http environment shows while a .http file is open.
  context.subscriptions.push(
    httpStatus,
    vscode.window.onDidChangeActiveTextEditor(() => updateHttpStatus()),
  );
  updateHttpStatus();
  // Help and Feedback: one entry a line, each running its command.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('apiWorkbench.help', {
      getChildren: () => [...HELP_ITEMS],
      getTreeItem: (item: (typeof HELP_ITEMS)[number]) => {
        const node = new vscode.TreeItem(item.label);
        node.description = item.description;
        node.iconPath = new vscode.ThemeIcon(item.icon);
        node.command = { command: item.command, title: item.label };
        node.tooltip = `${item.label}: ${item.description}`;
        return node;
      },
    }),
  );

  // Read-only documents: a response as text, and a workspace's specifications.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(RESPONSE_SCHEME, {
      onDidChange: responseEvents.event,
      provideTextDocumentContent: (uri) => responses.get(uri.toString()) ?? '',
    }),
    vscode.workspace.registerTextDocumentContentProvider(SPEC_SCHEME, {
      provideTextDocumentContent: (uri) => specTexts.get(uri.toString()) ?? '',
    }),
  );
  let documents = 0;
  async function openResponseText(result: SendResult): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: RESPONSE_SCHEME,
      path: `/${++documents}/${responseTitle(result)}`,
    });
    responses.set(uri.toString(), renderResponse(result, result.request.method));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  // The request editor: a saved request, its response beside it.
  const requestPanelKey = (entry: Loaded, request: ListedRequest) =>
    `request:${sourceKey(entry.source)}#${request.id}`;
  const lastSends = new Map<string, SendResult>();
  /**
   * Files chosen for requests this window, by request editor key: a file body's path, and form
   * file fields' by field name. As in the app they last the session; the request keeps their names.
   */
  const uploads = new Map<string, { binary?: string; fields: Record<string, string> }>();
  const uploadNames = (key: string): RequestView['uploads'] => {
    const chosen = uploads.get(key);
    if (!chosen) return undefined;
    return {
      ...(chosen.binary ? { binary: path.basename(chosen.binary) } : {}),
      fields: Object.fromEntries(
        Object.entries(chosen.fields).map(([field, file]) => [field, path.basename(file)]),
      ),
    };
  };
  /** The files chosen for a workspace's requests, by request id, for a run of them. */
  const runUploads = (source: Source): RunUploads => {
    const prefix = `request:${sourceKey(source)}#`;
    return Object.fromEntries(
      [...uploads]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, chosen]) => [key.slice(prefix.length), chosen]),
    );
  };
  /** The most a file sent with a request may be, as in the app. */
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  /** Chooses the file for a file body (`field` null) or a form's file field, in VS Code's dialog. */
  async function chooseUpload(key: string, panel: Panel<RequestView>, value: unknown) {
    const field = (value as { field?: unknown } | undefined)?.field;
    if (
      field !== null &&
      (typeof field !== 'string' || !field.trim() || /[\r\n=]/.test(field) || field.length > 1000)
    )
      return;
    const [file] =
      (await vscode.window.showOpenDialog({
        title:
          field === null ? 'Choose the file to send as the body' : `Choose the file for ${field}`,
        canSelectMany: false,
        openLabel: 'Choose',
      })) ?? [];
    if (!file) return;
    try {
      const info = await vscode.workspace.fs.stat(file);
      if (info.size > MAX_UPLOAD_BYTES)
        return void vscode.window.showWarningMessage(
          `${path.basename(file.fsPath)} is larger than 20 MB, the most a request sends.`,
        );
    } catch (error) {
      return report(error);
    }
    const chosen = uploads.get(key) ?? { fields: {} };
    if (field === null) chosen.binary = file.fsPath;
    else chosen.fields[field] = file.fsPath;
    uploads.set(key, chosen);
    panel.update({ ...panel.current, uploads: uploadNames(key) });
  }
  const editorView = (
    entry: Loaded,
    details: RequestDetails,
    extra: {
      revision?: number;
      response?: ResponseView;
      credentials?: RequestView['credentials'];
    } = {},
  ): RequestView => ({
    ...requestView(details, {
      environment: environmentOf(entry.source),
      hasFile: Boolean(entry.source.folder),
      revision: extra.revision,
      response: extra.response,
    }),
    credentials: extra.credentials,
    graphqlSchema: graphqlSchemas.get(`request:${sourceKey(entry.source)}#${details.id}`),
    uploads: uploadNames(`request:${sourceKey(entry.source)}#${details.id}`),
  });
  /** GraphQL schemas fetched this window, by request editor; fetched again only when asked. */
  const graphqlSchemas = new Map<string, SchemaState>();
  /**
   * The saved credentials a request's auth can use: an app workspace's, when its vault opens
   * without a password or with one typed this session. Names and origins only, never secrets.
   */
  const credentialChoices = async (entry: Loaded): Promise<RequestView['credentials']> => {
    if (!hasVault(entry.source)) return undefined;
    try {
      const secrets = await (await getWorkbench()).secrets(entry.source, vaultPassword);
      return secrets.map((secret) => ({
        id: secret.id,
        label: `${secret.name} (${secret.type}, ${secret.origin})`,
      }));
    } catch {
      return undefined;
    }
  };
  async function openRequest(item: Item | undefined): Promise<Panel<RequestView> | undefined> {
    if (!item || item.type !== 'request') return undefined;
    // A live request opens in its connection editor.
    if (!item.request.runnable) {
      await openLive(item);
      return undefined;
    }
    lastSource = item.loaded.source;
    updateStatus();
    const key = requestPanelKey(item.loaded, item.request);
    const existing = Panel.get<RequestView>(key);
    if (existing) {
      existing.reveal();
      return existing;
    }
    try {
      const bench = await getWorkbench();
      const [details, credentials] = await Promise.all([
        bench.showRequest({ source: item.loaded.source }, item.request.id),
        credentialChoices(item.loaded),
      ]);
      return new Panel<RequestView>(
        key,
        context.extensionUri,
        item.request.name,
        editorView(item.loaded, details, { credentials }),
        (action, panel, value) => void requestAction(action, item, panel, value),
        vscode.ViewColumn.Active,
        badge(details),
      );
    } catch (error) {
      report(error);
      return undefined;
    }
  }
  /**
   * Saves the editor's edits with `request update`, then shows the request as saved. False when
   * the edits could not be saved (the editor shows why), so a send waiting on it does not go out.
   */
  async function saveRequest(
    item: Item & { type: 'request' },
    panel: Panel<RequestView>,
    value: unknown,
  ): Promise<boolean> {
    const draft: RequestDraft | undefined = draftFrom(value);
    if (!draft) {
      panel.update({ ...panel.current, error: 'The edited request could not be read.' });
      return false;
    }
    const { args, input, env } = updatePlan(panel.current.saved, draft);
    // Nothing the command line would change, such as blank lines: the editor starts again from saved.
    if (!args.length) {
      panel.update({ ...panel.current, revision: panel.current.revision + 1 });
      return true;
    }
    panel.update({ ...panel.current, saving: true, error: undefined });
    try {
      const bench = await getWorkbench();
      await bench.updateRequest(item.loaded.source, item.request.id, args, { input, env });
      void refreshMockPages(item.loaded.source);
      const details = await bench.showRequest({ source: item.loaded.source }, item.request.id);
      panel.update(
        editorView(item.loaded, details, {
          revision: panel.current.revision + 1,
          response: panel.current.response,
          credentials: panel.current.credentials,
        }),
        details.name,
        badge(details),
      );
      log(`Saved ${details.name}.`);
      // The tree shows the method; a team folder's file change also refreshes it.
      if (details.method !== item.request.method && item.loaded.source.kind === 'app')
        void refresh();
      return true;
    } catch (error) {
      panel.update({ ...panel.current, saving: false, error: messageOf(error) });
      log(messageOf(error), 'error');
      return false;
    }
  }
  /**
   * Gets a request's OAuth 2.0 access token, as Get new access token does in the app: the command
   * line keeps it in the request, and VS Code learns only when it expires. A browser sign-in opens
   * the provider's page; cancelling the notification stops waiting for it.
   */
  async function getToken(
    item: Item & { type: 'request' },
    panel: Panel<RequestView>,
    refresh: boolean,
  ): Promise<void> {
    const source = item.loaded.source;
    const name = panel.current.name;
    panel.update({ ...panel.current, error: undefined });
    try {
      const bench = await getWorkbench();
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: refresh
            ? `Refreshing the access token of ${name}…`
            : `Getting an access token for ${name}…`,
          cancellable: true,
        },
        (progress, cancel) => {
          const abort = new AbortController();
          cancel.onCancellationRequested(() => abort.abort());
          return bench.requestToken(
            source,
            item.request.id,
            { environment: environmentOf(source), refresh, signal: abort.signal },
            (url) => {
              progress.report({ message: 'Sign in in your browser, then come back.' });
              void openSignIn(url);
            },
          );
        },
      );
      const details = await bench.showRequest({ source }, item.request.id);
      panel.update(
        editorView(item.loaded, details, {
          revision: panel.current.revision + 1,
          response: panel.current.response,
          credentials: panel.current.credentials,
        }),
      );
      log(
        `Got an access token for ${name}${
          result.expiresAt ? `, until ${new Date(result.expiresAt).toLocaleString()}` : ''
        }.`,
      );
      void vscode.window.setStatusBarMessage(`Access token saved for ${name}`, 3000);
    } catch (error) {
      panel.update({ ...panel.current, error: messageOf(error) });
      log(messageOf(error), 'error');
    }
  }
  /**
   * Fetches a GraphQL request's schema with an introspection query, sent as the request is sent,
   * for the Query editor's suggestions and the schema list. Kept until the window closes.
   */
  async function fetchSchema(
    item: Item & { type: 'request' },
    panel: Panel<RequestView>,
  ): Promise<void> {
    const key = panel.key;
    const show = (state: SchemaState) => {
      graphqlSchemas.set(key, state);
      if (Panel.get(key) === panel) panel.update({ ...panel.current, graphqlSchema: state });
    };
    const before = graphqlSchemas.get(key);
    show({ ...before, status: 'loading' });
    try {
      const schema = await (
        await getWorkbench()
      ).requestSchema(item.loaded.source, item.request.id, {
        environment: environmentOf(item.loaded.source),
        password: vaultPassword,
      });
      show({ status: 'ready', schema, fetchedAt: new Date().toLocaleTimeString() });
      log(`Fetched the GraphQL schema of ${panel.current.name}: ${schema.types.length} types.`);
    } catch (error) {
      // A schema fetched before stays for suggestions, with why it could not be fetched again.
      show({ ...before, status: 'error', message: messageOf(error) });
      log(messageOf(error), 'error');
    }
  }
  /** Opens an OAuth sign-in page; only a web address, which VS Code may ask about first. */
  const openSignIn = async (url: string) => {
    if (!/^https?:\/\//i.test(url))
      return log('The sign-in address is not a web address.', 'error');
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  };
  /** The workspaces a request can be added to, with their collections and folders. */
  const newRequestTargets = (): NewRequestTarget[] =>
    loaded
      .filter((entry) => !entry.error && entry.list)
      .map((entry) => ({
        key: sourceKey(entry.source),
        label: entry.source.name,
        kind: entry.source.kind,
        folders: folderChoices(
          entry.list!.collections,
          entry.list!.requests.map((request) => request.folder),
        ),
      }));
  /**
   * The New Request page: the kind of request, its workspace and collection, name, and URL. Opened
   * from a folder or workspace in the tree, it starts there.
   */
  async function openNewRequest(item?: Item): Promise<void> {
    if (loading) await loading;
    const existing = Panel.get<NewRequestView>('new-request');
    const start =
      item && item.type !== 'message' && 'loaded' in item
        ? sourceKey(item.loaded.source)
        : undefined;
    const folder = item?.type === 'folder' ? item.node.path : undefined;
    const view: NewRequestView = {
      view: 'newRequest',
      targets: newRequestTargets(),
      workspace: start ?? (lastSource ? sourceKey(lastSource) : undefined),
      folder,
      creating: false,
    };
    if (existing) {
      existing.reveal();
      return;
    }
    new Panel<NewRequestView>(
      'new-request',
      context.extensionUri,
      'New Request',
      view,
      (action, panel, value) => void newRequestAction(action, panel, value),
    );
  }
  async function newRequestAction(action: Action, panel: Panel<NewRequestView>, value: unknown) {
    if (action === 'cancel') return panel.dispose();
    if (action === 'fromCurl') {
      panel.dispose();
      return vscode.commands.executeCommand('apiWorkbench.newRequestFromCurl');
    }
    if (action !== 'create' || panel.current.creating) return;
    const input = newRequestFrom(value, panel.current.targets);
    if (typeof input === 'string') return panel.update({ ...panel.current, error: input });
    const entry = loaded.find((item) => sourceKey(item.source) === input.workspace);
    if (!entry) return panel.update({ ...panel.current, error: 'That workspace is gone.' });
    panel.update({ ...panel.current, creating: true, error: undefined });
    try {
      const created = await (
        await getWorkbench()
      ).createRequest(entry.source, newRequestArgs(input));
      void refreshMockPages(entry.source);
      log(`Created “${created.name}” in ${input.folder}.`);
      await refresh();
      const fresh = findLoaded(entry.source);
      const request = fresh?.list?.requests.find((r) => r.id === created.id);
      panel.dispose();
      // A live request opens in its connection editor, an HTTP one in the request editor.
      if (fresh && request) await openRequest({ type: 'request', loaded: fresh, request });
    } catch (error) {
      panel.update({ ...panel.current, creating: false, error: messageOf(error) });
    }
  }
  async function requestAction(
    action: Action,
    item: Item & { type: 'request' },
    panel: Panel<RequestView>,
    value: unknown,
  ) {
    if (action === 'save') return void (await saveRequest(item, panel, value));
    if (action === 'chooseUpload')
      return chooseUpload(requestPanelKey(item.loaded, item.request), panel, value);
    if (action === 'fetchSchema') {
      // Unsaved changes (its URL, headers, auth) are saved first: the schema is asked as it is sent.
      if (value !== undefined && !(await saveRequest(item, panel, value))) return;
      return fetchSchema(item, panel);
    }
    if (action === 'getToken' || action === 'refreshToken') {
      // Unsaved settings are saved first, so the token is got with what the editor shows.
      if (value !== undefined && !(await saveRequest(item, panel, value))) return;
      return getToken(item, panel, action === 'refreshToken');
    }
    // Send with unsaved edits saves them first, so what is sent is what the editor shows.
    if (action === 'send' && value !== undefined && !(await saveRequest(item, panel, value)))
      return;
    if (action === 'editPre' || action === 'editPost') {
      // The script in VS Code's own editor, beside the request; saving it saves the request's.
      const document = await vscode.workspace.openTextDocument(
        scriptUri(
          sourceKey(item.loaded.source),
          item.request.id,
          action === 'editPre' ? 'pre' : 'post',
          item.request.name,
        ),
      );
      await vscode.languages.setTextDocumentLanguage(document, 'javascript');
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      return;
    }
    const command = {
      send: 'apiWorkbench.sendRequest',
      code: 'apiWorkbench.generateCode',
      curl: 'apiWorkbench.copyAsCurl',
      environment: 'apiWorkbench.selectEnvironment',
      openFile: 'apiWorkbench.openRequestFile',
    }[action as string];
    if (command) return vscode.commands.executeCommand(command, item);
    if (action === 'copyBody' && panel.current.response)
      await copyBody(panel.current.response.rawBody || panel.current.response.body);
    if (action === 'openText') {
      const sent = lastSends.get(panel.key);
      if (sent) await openResponseText(sent);
    }
  }
  const copyBody = async (body: string) => {
    await vscode.env.clipboard.writeText(body);
    void vscode.window.setStatusBarMessage('Response body copied', 2500);
  };
  /** Shows the environment now in use in a source's open request editors. */
  const syncEnvironmentInPanels = (source: Source) => {
    for (const panel of Panel.all<RequestView>(`request:${sourceKey(source)}#`))
      panel.update({ ...panel.current, environment: environmentOf(source) });
    for (const panel of Panel.all<RunnerView>(`runner:${sourceKey(source)}`))
      panel.update({ ...panel.current, environment: environmentOf(source) });
  };

  async function sendSaved(item: Item & { type: 'request' }): Promise<void> {
    const source = item.loaded.source;
    lastSource = source;
    updateStatus();
    if (!item.request.runnable) {
      await openLive(item, true);
      return;
    }
    const panel = (await openRequest(item)) ?? undefined;
    if (panel) panel.update({ ...panel.current, sending: true, error: undefined });
    await vscode.window.withProgress(
      {
        location: panel
          ? { viewId: 'apiWorkbench.explorer' }
          : vscode.ProgressLocation.Notification,
        title: `Sending ${item.request.name}…`,
        cancellable: !panel,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        try {
          const bench = await getWorkbench();
          const startedAt = Date.now();
          const result = await withScripts(sourceKey(source), (scripts) =>
            withHosts(
              source.name,
              (allowedHosts) =>
                bench.send(source, item.request.id, {
                  environment: environmentOf(source),
                  uploads: uploads.get(requestPanelKey(item.loaded, item.request)),
                  scripts,
                  save: settings().get<boolean>('saveSends', true),
                  signal: abort.signal,
                  password: vaultPassword,
                  ...(allowedHosts ? { allowedHosts } : {}),
                }),
              guardsHosts(source),
            ),
          );
          if (!result) {
            panel?.update({ ...panel.current, sending: false });
            return;
          }
          logSend(result, startedAt);
          lastResponse = responseView(result, result.request.method, startedAt);
          if (panel) {
            lastSends.set(panel.key, result);
            panel.update({ ...panel.current, sending: false, response: lastResponse });
          }
          log(`${result.request.name}: ${statusLine(result)}`);
          // History gains the send in one of the app's workspaces.
          if (source.kind === 'app') historyView.refresh(source);
          // A saved credential needs the vault: unlock it, then send again.
          if (result.error && /vault is locked/i.test(result.error) && hasVault(source))
            void vscode.window
              .showWarningMessage(
                `${item.request.name} uses a saved credential. Unlock the credential vault to send it.`,
                'Unlock and send again',
              )
              .then(async (answer) => {
                if (!answer) return;
                await vscode.commands.executeCommand('apiWorkbench.unlockVault', {
                  type: 'group',
                  loaded: item.loaded,
                });
                if (vaultPassword !== undefined) await sendSaved(item);
              });
        } catch (error) {
          panel?.update({ ...panel.current, sending: false, error: messageOf(error) });
          if (!cancelled(error) && !panel) report(error);
          else log(messageOf(error), 'error');
        }
      },
    );
  }

  // Live requests: a WebSocket, gRPC call, SSE, or NDJSON stream kept open by the command line.
  const liveKey = (entry: Loaded, request: ListedRequest) =>
    `live:${sourceKey(entry.source)}#${request.id}`;
  const liveConnections = new Map<string, CliProcess>();
  async function openLive(
    item: Item & { type: 'request' },
    connectNow = false,
  ): Promise<Panel<LiveView> | undefined> {
    const key = liveKey(item.loaded, item.request);
    const existing = Panel.get<LiveView>(key);
    if (existing) {
      existing.reveal();
      if (connectNow && !liveConnections.has(key)) connectLive(item, existing);
      return existing;
    }
    let details: RequestDetails;
    try {
      details = await (
        await getWorkbench()
      ).showRequest({ source: item.loaded.source }, item.request.id);
    } catch (error) {
      report(error);
      return undefined;
    }
    const view: LiveView = {
      ...liveViewOf(item.loaded, details),
      state: 'idle',
      writable: false,
      finishable: false,
      events: [],
      revision: 0,
      saving: false,
      credentials: await credentialChoices(item.loaded),
    };
    const panel = new Panel<LiveView>(
      key,
      context.extensionUri,
      details.name,
      view,
      (action, shown, value) => void liveAction(action, item, shown, value),
      vscode.ViewColumn.Active,
      badge(details),
    );
    panel.onClose(() => {
      liveConnections.get(key)?.stop();
      liveConnections.delete(key);
    });
    if (connectNow) connectLive(item, panel);
    return panel;
  }
  /** What a live request's editor shows of the request as saved, and starts its edits from. */
  const liveViewOf = (
    entry: Loaded,
    details: RequestDetails,
  ): Omit<
    LiveView,
    'state' | 'writable' | 'finishable' | 'events' | 'revision' | 'saving' | 'credentials'
  > => {
    // The URL, headers, and auth as the request editor reads them, secrets left out.
    const asRequest = requestView(details, { hasFile: false });
    const settings: LiveSettings = {};
    if (details.protocol === 'grpc')
      settings.grpc = {
        proto: details.grpc?.proto ?? '',
        method: details.grpc?.method ?? '',
        tls: details.grpc?.tls ?? false,
      };
    else if (details.protocol === 'socketio')
      settings.socketio = normalizedSocketIO(details.socketio) ?? defaultSocketIO();
    else if (details.protocol === 'mqtt')
      settings.mqtt = normalizedMQTT(details.mqtt) ?? defaultMQTT();
    return {
      view: 'live',
      name: details.name,
      breadcrumb: [...details.folder.split('/').filter(Boolean), details.name],
      protocol: details.protocol,
      url: details.url,
      method: details.grpc?.method,
      environment: environmentOf(entry.source),
      body: details.bodyText ?? '',
      supported: LIVE_PROTOCOLS.includes(details.protocol),
      saved: {
        url: asRequest.saved.url,
        headers: asRequest.saved.headers,
        auth: asRequest.saved.auth,
        body: details.bodyText ?? '',
        settings,
      },
      hasSecret: asRequest.hasSecret,
      savedSecrets: asRequest.savedSecrets,
      methods: details.grpc?.methods?.map((method) => ({
        path: method.path,
        kind:
          method.requestStream && method.responseStream
            ? 'bidirectional stream'
            : method.requestStream
              ? 'client stream'
              : method.responseStream
                ? 'server stream'
                : 'unary',
      })),
      ...liveSettings(details),
    };
  };
  /** A Socket.IO request's event, or an MQTT request's topic and subscriptions, to start from. */
  const liveSettings = (
    details: RequestDetails,
  ): Pick<LiveView, 'sendOptions' | 'subscriptions'> => {
    if (details.protocol === 'socketio') {
      const config = normalizedSocketIO(details.socketio) ?? defaultSocketIO();
      return { sendOptions: { event: config.event, ack: config.ack } };
    }
    if (details.protocol === 'mqtt') {
      const config = normalizedMQTT(details.mqtt) ?? defaultMQTT();
      return {
        sendOptions: { topic: config.topic, qos: config.qos, retain: config.retain },
        subscriptions: config.subscriptions
          .filter((row) => row.enabled)
          .map((row) => `${row.topic} (QoS ${row.qos})`),
      };
    }
    return {};
  };
  /**
   * Opens a live request. From a team folder it connects only to this computer and hosts approved
   * for the workspace (`withHosts` explains why); anywhere else, it asks, and connects again if
   * allowed. `alsoAllowed` holds hosts allowed for this connection only.
   */
  function connectLive(
    item: Item & { type: 'request' },
    panel: Panel<LiveView>,
    alsoAllowed: string[] = [],
  ): void {
    const key = panel.key;
    if (liveConnections.has(key) || !panel.current.supported) return;
    const source = item.loaded.source;
    const guarded = guardsHosts(source);
    panel.update({
      ...panel.current,
      state: 'connecting',
      error: undefined,
      environment: environmentOf(source),
    });
    void getWorkbench()
      .then((bench) => {
        const started = Date.now();
        const process = bench.connect(
          source,
          item.request.id,
          {
            environment: environmentOf(source),
            password: vaultPassword,
            ...(guarded ? { allowedHosts: [...approvedHosts(), ...alsoAllowed] } : {}),
          },
          (line) => {
            const event = liveEvent(line);
            if (!event) return;
            panel.update(applyLiveEvent(panel.current, event));
            if (event.type === 'open') log(`Connected ${item.request.name}.`);
            if (event.type === 'error') log(`${item.request.name}: ${event.data}`, 'error');
          },
        );
        liveConnections.set(key, process);
        void process.exited.then(({ code, message }) => {
          liveConnections.delete(key);
          const failed = code === 2 && message;
          panel.update({
            ...panel.current,
            state: 'closed',
            writable: false,
            finishable: false,
            ...(failed ? { error: message } : {}),
          });
          log(
            failed
              ? `${item.request.name}: ${message}`
              : `${item.request.name} closed after ${Math.round((Date.now() - started) / 1000)} s.`,
            failed ? 'error' : 'info',
          );
          // Not connected because it goes to a host not yet approved: ask, then connect again.
          const host = failed && guarded ? refusedHost(message) : undefined;
          if (host && !alsoAllowed.includes(host))
            void approveHosts(source.name, [host], {
              once: 'Connect',
              detail: `connects ${item.request.name} to`,
            }).then((answer) => {
              if (answer) connectLive(item, panel, [...alsoAllowed, host]);
            });
          // A saved credential needs the vault: unlock it, then connect again.
          if (failed && /vault is locked|password/i.test(message) && hasVault(source))
            void vscode.window
              .showWarningMessage(
                `${item.request.name} uses a saved credential. Unlock the credential vault to connect.`,
                'Unlock and connect',
              )
              .then(async (answer) => {
                if (!answer) return;
                await vscode.commands.executeCommand('apiWorkbench.unlockVault', {
                  type: 'group',
                  loaded: item.loaded,
                });
                if (vaultPassword !== undefined) connectLive(item, panel);
              });
        });
      })
      .catch((error: unknown) =>
        panel.update({ ...panel.current, state: 'closed', error: messageOf(error) }),
      );
  }
  async function liveAction(
    action: Action,
    item: Item & { type: 'request' },
    panel: Panel<LiveView>,
    value: unknown,
  ): Promise<void> {
    const process = liveConnections.get(panel.key);
    if (action === 'connect') return connectLive(item, panel);
    if (action === 'disconnect') {
      // Asks it to close the connection; stops the command line if it does not answer.
      process?.write(STOP_LINE);
      setTimeout(() => liveConnections.get(panel.key)?.stop(), 2000);
      return;
    }
    if (action === 'sendMessage') {
      const found = sendLine(value, panel.current.protocol);
      if ('error' in found) return panel.update({ ...panel.current, error: found.error });
      if (!process) return panel.update({ ...panel.current, error: 'Connect first.' });
      panel.update({ ...panel.current, error: undefined });
      return process.write(found.line);
    }
    if (action === 'finish') return process?.write(FINISH_LINE);
    if (action === 'clear') return panel.update({ ...panel.current, events: [] });
    if (action === 'environment') {
      await vscode.commands.executeCommand('apiWorkbench.selectEnvironment', {
        type: 'source',
        loaded: item.loaded,
      });
      return panel.update({ ...panel.current, environment: environmentOf(item.loaded.source) });
    }
    if (action === 'save') {
      const draft = liveDraftFrom(value, panel.current.protocol);
      if (!draft)
        return panel.update({ ...panel.current, error: 'The edited request could not be read.' });
      const plan = liveUpdatePlan(panel.current.saved, draft);
      if (!plan.args.length && !plan.settings)
        return panel.update({ ...panel.current, revision: panel.current.revision + 1 });
      panel.update({ ...panel.current, saving: true, error: undefined });
      try {
        const bench = await getWorkbench();
        await bench.updateRequest(item.loaded.source, item.request.id, plan.args, plan);
        void refreshMockPages(item.loaded.source);
        const details = await bench.showRequest({ source: item.loaded.source }, item.request.id);
        // The connection keeps what it opened with; the next Connect uses what was saved.
        panel.update(
          {
            ...panel.current,
            ...liveViewOf(item.loaded, details),
            revision: panel.current.revision + 1,
            saving: false,
          },
          details.name,
        );
        log(
          `Saved ${details.name}.${liveConnections.has(panel.key) ? ' Reconnect to use the changes.' : ''}`,
        );
      } catch (error) {
        panel.update({ ...panel.current, saving: false, error: messageOf(error) });
      }
    }
  }

  // .http files: each request is sent from a copy of the editor's text, so what is sent is what
  // is on screen, saved or not; the file itself is never changed.
  const httpRequestOf = async (
    target?: HttpTarget,
  ): Promise<{ document: vscode.TextDocument; request: HttpFileRequest } | undefined> => {
    let document: vscode.TextDocument | undefined;
    let id = target?.id;
    if (target) document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    else {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.languageId !== 'http') return undefined;
      document = editor.document;
      id = requestAtLine(parseHttpFile(document.getText()), editor.selection.active.line)?.id;
    }
    const file = parseHttpFile(document.getText());
    const request = file.requests.find((candidate) => candidate.id === id);
    if (!request) return undefined;
    if (file.problem)
      throw new CliError(`Line ${file.problem.line + 1}: ${file.problem.message}`, 2);
    return { document, request };
  };
  /** The folder a document's relative paths mean: its own, or an untitled one's workspace folder. */
  const documentFolder = (document: vscode.TextDocument) =>
    document.uri.scheme === 'file'
      ? path.dirname(document.uri.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  async function withFileCopy<T>(
    document: vscode.TextDocument,
    action: (file: string) => Promise<T>,
  ): Promise<T> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-http-'));
    const name = path.basename(document.uri.path).replace(/\.[^.]*$/, '') || 'requests';
    const file = path.join(folder, `${name}.http`);
    try {
      await writeFile(file, document.getText(), { mode: 0o600 });
      return await action(file);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  const httpEditorKey = (target: HttpTarget) => `http:${target.uri}#${target.id}`;
  /** A `.http` file's request in the request editor, to read and send; the file is where it is edited. */
  async function openHttpRequest(target?: HttpTarget): Promise<void> {
    let found;
    try {
      found = await httpRequestOf(target);
    } catch (error) {
      return report(error);
    }
    if (!found) return;
    const { document, request } = found;
    const at: HttpTarget = { uri: document.uri.toString(), id: request.id };
    const key = httpEditorKey(at);
    const existing = Panel.get<RequestView>(key);
    if (existing) return existing.reveal();
    // A `< ./path` body or a multipart form sends files the .http file names, read when sent.
    const files = bodyFiles(request);
    const view = requestView(
      {
        id: request.id,
        name: request.name,
        folder: path.basename(document.uri.path),
        method: request.method,
        protocol: 'http',
        url: request.url,
        auth: 'None',
        tags: [],
        headers: request.headers
          .filter(
            (header) =>
              files?.bodyType !== 'form-data' || header.key.trim().toLowerCase() !== 'content-type',
          )
          .map((header) => ({ ...header, enabled: true })),
        bodyText: files ? '' : request.body,
        bodyType: files?.bodyType ?? (request.body ? 'raw' : 'none'),
        ...(files?.binaryName ? { binaryName: files.binaryName } : {}),
        ...(files
          ? { formFields: files.form.map((row) => ({ ...row, kind: row.kind ?? 'text' })) }
          : {}),
        tests: [],
        captures: [],
      },
      { hasFile: false, kind: 'file' },
    );
    if (files)
      view.uploads = {
        ...(files.files.binary ? { binary: files.files.binary } : {}),
        fields: files.files.fields,
      };
    new Panel<RequestView>(
      key,
      context.extensionUri,
      request.name,
      view,
      (action, panel) => {
        if (action === 'send') void sendHttp(at, true);
        else if (action === 'code') void generateCode(at);
        else if (action === 'saveToCollection')
          void vscode.commands.executeCommand('apiWorkbench.saveToCollection', at);
        else if (action === 'copyBody' && panel.current.response)
          void copyBody(panel.current.response.rawBody || panel.current.response.body);
        else if (action === 'openText') {
          const sent = lastSends.get(key);
          if (sent) void openResponseText(sent);
        }
      },
      vscode.ViewColumn.Beside,
      badge({ method: request.method, protocol: 'http' }),
    );
  }

  async function sendHttp(target?: HttpTarget, fromEditor = false): Promise<void> {
    let found;
    try {
      found = await httpRequestOf(target);
    } catch (error) {
      return report(error);
    }
    if (!found) {
      void vscode.window.showInformationMessage(
        'Put the cursor in a request of a .http file to send it.',
      );
      return;
    }
    const { document, request } = found;
    const fileKey = document.uri.toString();
    const key = `response:${fileKey}#${request.id}`;
    const title = `Response · ${request.name}`;
    const again = { uri: fileKey, id: request.id } satisfies HttpTarget;
    const editor = Panel.get<RequestView>(httpEditorKey(again));
    type ResponseOnly = {
      view: 'response';
      response?: ResponseView;
      sending: boolean;
      error?: string;
      fromFile: boolean;
    };
    let panel = fromEditor && editor ? undefined : Panel.get<ResponseOnly>(key);
    editor?.update({ ...editor.current, sending: true, error: undefined });
    if (!(fromEditor && editor)) {
      const sending: ResponseOnly = {
        view: 'response',
        response: panel?.current.response,
        sending: true,
        fromFile: true,
      };
      if (panel) {
        panel.update(sending);
        panel.reveal(vscode.ViewColumn.Beside);
      } else
        panel = new Panel<ResponseOnly>(
          key,
          context.extensionUri,
          title,
          sending,
          (action, shown) => {
            if (action === 'send') void sendHttp(again);
            else if (action === 'copyBody' && shown.current.response)
              void copyBody(shown.current.response.rawBody || shown.current.response.body);
            else if (action === 'openText') {
              const sent = lastSends.get(key);
              if (sent) void openResponseText(sent);
            }
          },
          vscode.ViewColumn.Beside,
        );
    }
    try {
      const bench = await getWorkbench();
      const startedAt = Date.now();
      const result = await withScripts(`file:${fileKey}`, (scripts) =>
        withHosts(path.basename(document.uri.path), (allowedHosts) =>
          withFileCopy(document, (file) =>
            bench.sendFile(file, request.id, {
              scripts,
              variables: fileCaptures.get(fileKey),
              environment: httpEnvironmentFor(document),
              // The text is sent from a copy, so its `< ./path` files are found beside the original.
              baseDir: documentFolder(document),
              ...(allowedHosts ? { allowedHosts } : {}),
            }),
          ),
        ),
      );
      if (!result) {
        panel?.update({ ...panel.current, sending: false });
        editor?.update({ ...editor.current, sending: false });
        return;
      }
      logSend(result, startedAt);
      // Captured values go to the requests sent after it from the same file, as a chain.
      const captured = { ...fileCaptures.get(fileKey) };
      for (const capture of result.captures) {
        const name = capture.variable ?? capture.name;
        if (name && !capture.error && capture.value !== undefined) captured[name] = capture.value;
      }
      fileCaptures.set(fileKey, captured);
      lastResponse = responseView(result, request.method, startedAt);
      lastSends.set(key, result);
      if (editor) lastSends.set(httpEditorKey(again), result);
      panel?.update(
        { view: 'response', response: lastResponse, sending: false, fromFile: true },
        title,
      );
      editor?.update({ ...editor.current, sending: false, response: lastResponse });
      log(`${request.name}: ${statusLine(result)}`);
    } catch (error) {
      panel?.update({ view: 'response', sending: false, error: messageOf(error), fromFile: true });
      editor?.update({ ...editor.current, sending: false, error: messageOf(error) });
      log(messageOf(error), 'error');
    }
  }

  async function send(target: Item | HttpTarget | undefined): Promise<void> {
    if (target && 'uri' in target) return sendHttp(target);
    if (target?.type === 'request') return sendSaved(target);
    if (vscode.window.activeTextEditor?.document.languageId === 'http') return sendHttp();
    // From the palette: any request of any workspace, or only the one in use (a toggle).
    const picked = await pickRequest();
    if (picked) return sendSaved(picked);
  }

  /** A team folder's git, as the app's Sync does: status, commit, pull, push, or all three. */
  async function teamAction(
    item: Item | undefined,
    command: 'status' | 'commit' | 'pull' | 'push' | 'sync',
  ): Promise<void> {
    const entry = item && item.type !== 'message' ? item.loaded : await pickTeam();
    if (!entry?.source.folder) {
      void vscode.window.showInformationMessage('Choose a team workspace in a Git repository.');
      return;
    }
    let message: string | undefined;
    if (command === 'commit' || command === 'sync') {
      message = (
        await vscode.window.showInputBox({
          title: command === 'sync' ? 'Sync Team Folder' : 'Commit Team Folder',
          prompt: 'The commit message for your changes',
          value: 'Update API requests',
        })
      )?.trim();
      if (!message) return;
    }
    try {
      const bench = await getWorkbench();
      let result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `Team ${command}…` },
        () => bench.team(entry.source, command, { message }),
      );
      if (result.conflicts?.length) {
        const mine = 'Keep mine';
        const theirs = 'Keep theirs';
        const answer = await vscode.window.showWarningMessage(
          `${result.conflicts.length} file${result.conflicts.length === 1 ? ' was' : 's were'} changed by you and a teammate.`,
          { modal: true, detail: result.conflicts.join('\n') },
          mine,
          theirs,
        );
        if (!answer) return;
        result = await bench.team(entry.source, command === 'sync' ? 'sync' : 'pull', {
          message,
          keep: answer === mine ? 'mine' : 'theirs',
        });
      }
      teamStatus.set(sourceKey(entry.source), result.status);
      treeEvents.fire();
      if (result.message) log(result.message);
      if (command !== 'status') {
        if (command === 'pull' || command === 'sync') await refresh();
        void vscode.window.setStatusBarMessage(
          `$(check) ${result.message || `Team ${command} done`}`,
          4000,
        );
        return;
      }
      const { status } = result;
      const picked = await vscode.window.showQuickPick(
        status.changes.map((change) => ({
          label: change.path,
          description: change.kind,
          iconPath: new vscode.ThemeIcon(
            change.kind === 'deleted'
              ? 'diff-removed'
              : change.kind === 'added'
                ? 'diff-added'
                : 'diff-modified',
          ),
          change,
        })),
        {
          title: `${status.branch ?? 'No branch'}${status.upstream ? ` → ${status.upstream}` : ''}`,
          placeHolder: `${status.changeCount ? `${status.changeCount} changed` : 'Nothing changed'} · ${status.ahead} to push · ${status.behind} to pull`,
          prompt: 'Open a changed file',
        },
      );
      if (picked && picked.change.kind !== 'deleted') {
        // Paths are relative to the team folder; a file outside it is never opened from here.
        const root = path.resolve(entry.source.folder);
        const file = path.resolve(root, picked.change.path);
        if (file.startsWith(root + path.sep))
          await vscode.window.showTextDocument(vscode.Uri.file(file));
      }
    } catch (error) {
      report(error);
    }
  }
  const pickTeam = async (): Promise<Loaded | undefined> => {
    const teams = loaded.filter((entry) => teamStatus.has(sourceKey(entry.source)));
    if (teams.length <= 1) return teams[0];
    return (
      await vscode.window.showQuickPick(
        teams.map((entry) => ({
          label: entry.source.name,
          description: sourceLabel(entry),
          entry,
        })),
        { placeHolder: 'Which team folder?' },
      )
    )?.entry;
  };

  /**
   * A request chosen from every workspace, each with its method badge. With several workspaces,
   * the toggle in the title keeps the list to the workspace last used.
   */
  function pickRequest(): Promise<(Item & { type: 'request' }) | undefined> {
    const usable = loaded.filter((entry) => entry.list);
    const current = lastSource && findLoaded(lastSource);
    const pick = vscode.window.createQuickPick<
      vscode.QuickPickItem & { item?: Item & { type: 'request' } }
    >();
    pick.title = 'Send Request';
    pick.placeholder = 'Search requests by name, method, or folder';
    pick.prompt = 'The response opens in the request editor.';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    const only: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('filter'),
      tooltip: current ? `Only ${current.source.name}` : 'Only the workspace in use',
      location: vscode.QuickInputButtonLocation.Title,
      toggle: { checked: false },
    };
    if (usable.length > 1 && current) pick.buttons = [only];
    const fill = (onlyCurrent: boolean) => {
      pick.items = (onlyCurrent && current ? [current] : usable).flatMap((entry) => [
        { label: entry.source.name, kind: vscode.QuickPickItemKind.Separator },
        ...(entry.list?.requests ?? [])
          .filter((request) => request.runnable)
          .map((request) => ({
            label: request.name,
            description: `${request.method} · ${request.folder}`,
            iconPath: badge(request),
            item: { type: 'request', loaded: entry, request } as Item & { type: 'request' },
          })),
      ]);
    };
    fill(false);
    return new Promise((resolve) => {
      pick.onDidTriggerButton((button) => {
        if (button === only) fill(Boolean(only.toggle?.checked));
      });
      pick.onDidAccept(() => {
        resolve(pick.selectedItems[0]?.item);
        pick.hide();
      });
      pick.onDidHide(() => {
        resolve(undefined);
        pick.dispose();
      });
      pick.show();
    });
  }

  const runItem = (item?: Item) => {
    const id =
      !item || item.type === 'message'
        ? undefined
        : item.type === 'source'
          ? sourceKey(item.loaded.source)
          : item.type === 'folder'
            ? `${sourceKey(item.loaded.source)}/${item.node.path}`
            : `${sourceKey(item.loaded.source)}#${item.request.id}`;
    const test = id ? findTest(id) : undefined;
    if (id && !test) {
      void vscode.window.showInformationMessage('There is nothing the command line can run here.');
      return;
    }
    const cancel = new vscode.CancellationTokenSource();
    return runTests(new vscode.TestRunRequest(test ? [test] : undefined), cancel.token).finally(
      () => cancel.dispose(),
    );
  };

  // The runner: a collection run with iterations, a delay, or a data file, or a load test.
  const runnerAborts = new Map<string, AbortController>();
  async function openRunner(item?: Item): Promise<void> {
    const entry = await pickSource(item, 'Run which workspace?');
    if (!entry?.list) return;
    const key = `runner:${sourceKey(entry.source)}`;
    const collections = [
      ...new Set(
        entry.list.requests
          .filter((request) => request.runnable)
          .flatMap((request) =>
            request.folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')),
          ),
      ),
    ];
    const chosen = item?.type === 'folder' ? item.node.path : '';
    const existing = Panel.get<RunnerView>(key);
    if (existing) {
      if (chosen && !existing.current.running)
        existing.update({
          ...existing.current,
          options: { ...existing.current.options, collection: chosen },
        });
      return existing.reveal();
    }
    let dataFile: string | undefined;
    const options: RunnerOptions = {
      collection: chosen,
      mode: 'collection',
      iterations: 1,
      delayMs: 0,
      bail: false,
      concurrency: 5,
      durationSeconds: 10,
    };
    const view: RunnerView = {
      view: 'runner',
      workspace: entry.source.name,
      environment: environmentOf(entry.source),
      collections,
      options,
      running: false,
      results: [],
      thresholds: [],
    };
    new Panel<RunnerView>(
      key,
      context.extensionUri,
      `Runner · ${entry.source.name}`,
      view,
      (action, panel, value) => {
        if (action === 'cancel') runnerAborts.get(key)?.abort();
        else if (action === 'environment')
          void vscode.commands
            .executeCommand('apiWorkbench.selectEnvironment', { type: 'source', loaded: entry })
            .then(() =>
              panel.update({ ...panel.current, environment: environmentOf(entry.source) }),
            );
        else if (action === 'clearData') {
          dataFile = undefined;
          panel.update({ ...panel.current, data: undefined });
        } else if (action === 'pickData')
          void vscode.window
            .showOpenDialog({
              canSelectMany: false,
              openLabel: 'Use',
              title: 'Run once per row of this file',
              filters: { Data: ['csv', 'json', 'yaml', 'yml', 'xml'] },
            })
            .then((files) => {
              if (!files?.[0]) return;
              dataFile = files[0].fsPath;
              panel.update({ ...panel.current, data: path.basename(dataFile) });
            });
        else if (action === 'run') {
          const given = runnerOptionsFrom(value, collections);
          if (!given) {
            panel.update({ ...panel.current, error: 'Those run settings are not valid.' });
            return;
          }
          void runRunner(entry, panel, given, dataFile);
        }
      },
    );
  }
  async function runRunner(
    entry: Loaded,
    panel: Panel<RunnerView>,
    options: RunnerOptions,
    data?: string,
  ): Promise<void> {
    const key = panel.key;
    if (runnerAborts.has(key)) return;
    const abort = new AbortController();
    runnerAborts.set(key, abort);
    const environment = environmentOf(entry.source);
    panel.update({
      ...panel.current,
      options,
      environment,
      running: true,
      error: undefined,
      summary: undefined,
      results: [],
      thresholds: [],
    });
    const what = options.collection || 'every request';
    log(`Running ${what} in ${entry.source.name} (${options.mode}).`);
    const startedAt = Date.now();
    try {
      const bench = await getWorkbench();
      const result = await withScripts(sourceKey(entry.source), (scripts) =>
        withRunHosts(
          entry.source,
          () => bench.runnerHosts(entry.source, { ...options, environment, data }),
          (allowedHosts) =>
            bench.runner(entry.source, {
              ...options,
              environment,
              data,
              scripts,
              signal: abort.signal,
              password: vaultPassword,
              uploads: runUploads(entry.source),
              ...(allowedHosts ? { allowedHosts } : {}),
            }),
        ),
      );
      if (!result) return panel.update({ ...panel.current, running: false });
      let at = startedAt;
      for (const sent of result.report.results ?? []) {
        logSend(sent, at);
        at += sent.durationMs ?? 0;
      }
      panel.update({ ...panel.current, running: false, ...runnerResults(result.report) });
      log(
        `Run of ${what} ${result.report.passed ? 'passed' : 'failed'} in ${Math.round(result.report.summary.elapsedMs)} ms.`,
        result.report.passed ? 'info' : 'error',
      );
    } catch (error) {
      panel.update({
        ...panel.current,
        running: false,
        error: cancelled(error) ? 'Stopped.' : messageOf(error),
      });
      log(messageOf(error), 'error');
    } finally {
      runnerAborts.delete(key);
    }
  }

  // Code generation: the language last chosen first, then every language and library.
  const languageIds: Record<string, string> = {
    '.sh': 'shellscript',
    '.py': 'python',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.rs': 'rust',
    '.ps1': 'powershell',
    '.c': 'c',
    '.m': 'objective-c',
    '.r': 'r',
    '.clj': 'clojure',
    '.ml': 'ocaml',
    '.http': 'http',
  };
  async function generateCode(target: Item | HttpTarget | undefined): Promise<void> {
    try {
      const bench = await getWorkbench();
      let place: RequestPlace;
      let id: string;
      let environment: string | undefined;
      let copy: vscode.TextDocument | undefined;
      if (target && 'uri' in target) {
        const found = await httpRequestOf(target);
        if (!found) return;
        copy = found.document;
        id = found.request.id;
        place = { file: '' };
      } else if (target?.type === 'request') {
        place = { source: target.loaded.source };
        id = target.request.id;
        environment = environmentOf(target.loaded.source);
      } else return void (await vscode.commands.executeCommand('apiWorkbench.sendRequest'));
      const produce = async (where: RequestPlace) => {
        const targets: CodeTarget[] = await bench.codeTargets(where);
        const last = context.globalState.get<string>('codeTarget');
        const choices = targets.flatMap((lang) =>
          lang.clients.map((client) => ({
            label: `${lang.label}: ${client.label}`,
            lang,
            client: client.id,
            key: `${lang.id}/${client.id}`,
          })),
        );
        choices.sort((a, b) => Number(b.key === last) - Number(a.key === last));
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Generate code in…',
          matchOnDescription: true,
        });
        if (!picked) return;
        await context.globalState.update('codeTarget', picked.key);
        const result = await bench.code(where, id, picked.lang.id, picked.client, environment);
        const document = await vscode.workspace.openTextDocument({
          content: result.code,
          language: languageIds[picked.lang.extension] ?? 'plaintext',
        });
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        if (result.notes.length) output.appendLine(result.notes.join('\n'));
      };
      if (copy) await withFileCopy(copy, (file) => produce({ file }));
      else await produce(place);
    } catch (error) {
      report(error);
    }
  }

  // Specifications: shown read-only, checked as they open and save.
  const diagnostics = vscode.languages.createDiagnosticCollection('API Workbench');
  async function lintDocument(document: vscode.TextDocument): Promise<void> {
    const lintable =
      (document.uri.scheme === 'file' &&
        /\.(ya?ml|json)$/i.test(document.uri.fsPath) &&
        isSpecText(document.getText())) ||
      document.uri.scheme === SPEC_SCHEME;
    if (!lintable) return;
    try {
      const bench = await getWorkbench();
      const analysis =
        document.uri.scheme === SPEC_SCHEME
          ? await (async () => {
              const [, key, id] = document.uri.path.split('/');
              const entry = loaded.find((l) => sourceKey(l.source) === decodeURIComponent(key));
              return entry ? bench.lintSpec({ source: entry.source, id }) : undefined;
            })()
          : await bench.lintSpec({ file: document.uri.fsPath });
      if (!analysis) return;
      diagnostics.set(
        document.uri,
        analysis.problems.map((problem) => {
          const line = Math.min(Math.max((problem.line ?? 1) - 1, 0), document.lineCount - 1);
          const text = document.lineAt(line);
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, text.firstNonWhitespaceCharacterIndex, line, text.text.length),
            problem.message,
            problem.severity === 'error'
              ? vscode.DiagnosticSeverity.Error
              : vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = 'API Workbench';
          return diagnostic;
        }),
      );
    } catch (error) {
      output.appendLine(`Could not check ${document.uri.fsPath}: ${messageOf(error)}`);
    }
  }
  async function openSpec(entry: Loaded, spec: ListedSpec): Promise<void> {
    try {
      const text = await (await getWorkbench()).exportSpec(entry.source, spec.id);
      const json = /^\s*[{[]/.test(text);
      const uri = vscode.Uri.from({
        scheme: SPEC_SCHEME,
        path: `/${encodeURIComponent(sourceKey(entry.source))}/${spec.id}/${spec.name.replace(/[\\/]/g, '-')}.${json ? 'json' : 'yaml'}`,
      });
      specTexts.set(uri.toString(), text);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
      void lintDocument(document);
    } catch (error) {
      report(error);
    }
  }
  /** Which specification a command acts on: a spec in the view, or an open OpenAPI file. */
  function specTarget(
    arg: SideItem<ListedSpec> | vscode.Uri | undefined,
  ): { entry?: Loaded; spec: string; name: string } | undefined {
    if (arg && 'type' in arg && arg.type === 'value')
      return { entry: arg.loaded, spec: arg.value.id, name: arg.value.name };
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SPEC_SCHEME) {
      const [, key, id, name] = uri.path.split('/');
      const entry = loaded.find((l) => sourceKey(l.source) === decodeURIComponent(key));
      return entry ? { entry, spec: id, name: name.replace(/\.[^.]+$/, '') } : undefined;
    }
    if (uri?.scheme === 'file')
      return { spec: uri.fsPath, name: path.basename(uri.fsPath).replace(/\.[^.]+$/, '') };
    return undefined;
  }

  /** A specification's operations and problems in an editor tab, with its actions. */
  async function previewDocs(arg?: SideItem<ListedSpec> | vscode.Uri): Promise<void> {
    const target = specTarget(arg);
    if (!target) {
      void vscode.window.showInformationMessage('Open an OpenAPI or Swagger file first.');
      return;
    }
    try {
      const bench = await getWorkbench();
      const analysis = await bench.lintSpec(
        target.entry ? { source: target.entry.source, id: target.spec } : { file: target.spec },
      );
      const view: DocsView = {
        view: 'docs',
        name: target.name,
        title: analysis.title,
        version: analysis.version,
        errors: analysis.problems.filter((problem) => problem.severity === 'error').length,
        warnings: analysis.problems.filter((problem) => problem.severity === 'warning').length,
        operations: analysis.endpoints,
      };
      const key = `docs:${target.entry ? sourceKey(target.entry.source) : 'file'}#${target.spec}`;
      const existing = Panel.get<DocsView>(key);
      if (existing) {
        existing.update(view);
        return existing.reveal();
      }
      const again = arg;
      new Panel<DocsView>(key, context.extensionUri, `Docs · ${target.name}`, view, (action) => {
        if (action === 'generate')
          void vscode.commands.executeCommand('apiWorkbench.generateFromSpec', again);
        else if (action === 'mockFromSpec')
          void vscode.commands.executeCommand('apiWorkbench.mockFromSpec', again);
      });
    } catch (error) {
      report(error);
    }
  }

  /** Makes a mock server answering for a specification's operations, starts it, and shows it. */
  async function mockFromSpec(arg?: SideItem<ListedSpec> | vscode.Uri): Promise<void> {
    const target = specTarget(arg);
    if (!target) {
      void vscode.window.showInformationMessage('Open an OpenAPI or Swagger file first.');
      return;
    }
    const entry =
      target.entry ?? (await pickSource(undefined, 'Add the mock server to which workspace?'));
    if (!entry) return;
    try {
      const bench = await getWorkbench();
      const existing = (await bench.mocks(entry.source)).map((mock) => mock.name.toLowerCase());
      let name = `${target.name} mock`;
      for (let n = 2; existing.includes(name.toLowerCase()); n++) name = `${target.name} mock ${n}`;
      const created = await bench.createMock(entry.source, name, { spec: target.spec });
      log(`Created mock “${created.name}” with ${created.routes} routes on port ${created.port}.`);
      mocksView.refresh(entry.source);
      const mock: ListedMock = {
        id: created.id,
        name: created.name,
        port: created.port,
        routes: created.routes,
        https: false,
      };
      await openMock(entry, mock);
      await startMock(entry, mock);
    } catch (error) {
      report(error);
    }
  }

  // Mock servers: each started one is a command line serving it until stopped.
  const mockPanelKey = (key: string) => `mock:${key}`;
  /**
   * After a request is added or changed, the mock servers made from its collection may have
   * changed with it: their list is refreshed, and an open mock page shows its new routes (a
   * running one offers Restart). A page is left as it is when its routes did not change, so
   * edits made on it are kept.
   */
  const refreshMockPages = async (source: Source) => {
    mocksView.refresh(source);
    const prefix = mockPanelKey(`${sourceKey(source)}#`);
    for (const panel of Panel.all<MockView>(prefix)) {
      const id = panel.key.slice(prefix.length);
      try {
        const details = mockDetailsView(await (await getWorkbench()).mock(source, id));
        if (
          JSON.stringify(details.saved) === JSON.stringify(panel.current.saved) &&
          JSON.stringify(details.collectionSync) === JSON.stringify(panel.current.collectionSync)
        )
          continue;
        const routesChanged =
          JSON.stringify(details.saved?.routes) !== JSON.stringify(panel.current.saved?.routes);
        const view: MockView = {
          ...panel.current,
          ...details,
          revision: (panel.current.revision ?? 0) + (routesChanged ? 1 : 0),
          restartNeeded: panel.current.restartNeeded || (routesChanged && panel.current.running),
        };
        const running = [...mocks.values()].find(
          (item) => mockPanelKey(mockKey(item.loaded, item.mock)) === panel.key,
        );
        if (running) running.view = { ...running.view, ...view, log: running.view.log };
        panel.update(view);
      } catch {
        /* The page shows what it had; the next save or open reads it again. */
      }
    }
  };
  const mockUpdate = (running: RunningMock) => {
    Panel.get<MockView>(mockPanelKey(mockKey(running.loaded, running.mock)))?.update(running.view);
    mocksView.refresh(running.loaded.source);
    updateMockStatus();
  };
  async function startMock(entry: Loaded, mock: ListedMock): Promise<void> {
    const key = mockKey(entry, mock);
    const current = mocks.get(key);
    if (current?.process) return;
    const running: RunningMock = {
      loaded: entry,
      mock,
      stopping: false,
      view: {
        view: 'mock',
        name: mock.name,
        workspace: entry.source.name,
        running: false,
        port: mock.port,
        routes: mock.routes,
        https: mock.https,
        log: current?.view.log ?? [],
        chips: Panel.get<MockView>(mockPanelKey(key))?.current.chips ?? current?.view.chips,
        routeList:
          Panel.get<MockView>(mockPanelKey(key))?.current.routeList ?? current?.view.routeList,
        saved: Panel.get<MockView>(mockPanelKey(key))?.current.saved ?? current?.view.saved,
        revision:
          Panel.get<MockView>(mockPanelKey(key))?.current.revision ?? current?.view.revision,
      },
    };
    mocks.set(key, running);
    try {
      const bench = await getWorkbench();
      running.process = bench.startMock(entry.source, mock.id, (line) => {
        const parsed = mockLine(line);
        if (!parsed) return;
        if ('started' in parsed) {
          running.view = { ...running.view, running: true, url: parsed.started, error: undefined };
          log(`Mock “${mock.name}” on ${parsed.started}`);
        } else if ('entry' in parsed)
          running.view = { ...running.view, log: [...running.view.log, parsed.entry].slice(-500) };
        else return;
        mockUpdate(running);
      });
      mockUpdate(running);
      void running.process.exited.then(({ code, message }) => {
        running.process = undefined;
        const failed = !running.stopping && code !== 0 && code !== 130;
        running.view = {
          ...running.view,
          running: false,
          url: undefined,
          ...(failed ? { error: message || `Stopped with exit code ${code}.` } : {}),
        };
        if (failed) report(new Error(`Mock “${mock.name}”: ${running.view.error}`));
        else log(`Mock “${mock.name}” stopped.`);
        mockUpdate(running);
      });
    } catch (error) {
      running.view = { ...running.view, error: messageOf(error) };
      mockUpdate(running);
      report(error);
    }
  }
  function stopMock(entry: Loaded, mock: ListedMock): void {
    const running = mocks.get(mockKey(entry, mock));
    if (!running?.process) return;
    running.stopping = true;
    running.process.stop();
  }
  /**
   * The Environments page of a source, as the app's: its environments on the left, the one chosen
   * as a table of variables on the right, saved at once. `selected` opens that environment.
   */
  async function openEnvironments(entry: Loaded, selected?: string): Promise<void> {
    const key = `environments:${sourceKey(entry.source)}`;
    const load = async (
      wanted?: string,
      extra: Partial<EnvironmentsView> = {},
    ): Promise<EnvironmentsView> => {
      const bench = await getWorkbench();
      const list = await bench.environments(entry.source);
      const inUse = environmentOf(entry.source);
      const name =
        (wanted && list.some((item) => item.name === wanted) ? wanted : undefined) ??
        (inUse && list.some((item) => item.name === inUse) ? inUse : list[0]?.name);
      const variables = name ? (await bench.environment(entry.source, name)).variables : [];
      return {
        view: 'environments',
        workspace: entry.source.name,
        environments: list.map((item) => ({
          name: item.name,
          variables: item.variables,
          inUse: item.name === inUse,
        })),
        ...(name ? { selected: name } : {}),
        variables: variables.map(({ key, value, enabled }) => ({ key, value, enabled })),
        team: entry.source.kind === 'team',
        revision: 0,
        ...extra,
      };
    };
    const existing = Panel.get<EnvironmentsView>(key);
    if (existing) {
      existing.reveal();
      if (selected && selected !== existing.current.selected)
        existing.update(await load(selected, { revision: existing.current.revision + 1 }));
      return;
    }
    let panel: Panel<EnvironmentsView>;
    try {
      panel = new Panel<EnvironmentsView>(
        key,
        context.extensionUri,
        `Environments · ${entry.source.name}`,
        await load(selected),
        (action, shown, value) => void environmentsAction(action, shown, value),
      );
    } catch (error) {
      return report(error);
    }
    const reload = async (
      wanted = panel.current.selected,
      extra: Partial<EnvironmentsView> = {},
    ) => {
      if (Panel.get(key) !== panel) return;
      panel.update(await load(wanted, { revision: panel.current.revision + 1, ...extra }));
      environmentsView.refresh(entry.source);
    };
    async function environmentsAction(
      action: Action,
      shown: Panel<EnvironmentsView>,
      value: unknown,
    ) {
      const bench = await getWorkbench();
      const name = typeof value === 'string' ? value : shown.current.selected;
      try {
        if (action === 'refresh') return await reload();
        if (action === 'chooseEnvironment' && typeof value === 'string') return await reload(value);
        if (action === 'useEnvironment' && name) {
          await useEnvironment(entry, name);
          return await reload(name);
        }
        if (action === 'newEnvironment') {
          const created = (
            await vscode.window.showInputBox({
              title: 'New environment',
              prompt: shown.current.selected
                ? `Its name; it starts as a copy of ${shown.current.selected} if you choose Copy`
                : 'Its name',
              placeHolder: 'Staging',
            })
          )?.trim();
          if (!created) return;
          const copy = shown.current.selected
            ? await vscode.window.showQuickPick(['Empty', `Copy of ${shown.current.selected}`], {
                title: `New environment “${created}”`,
              })
            : 'Empty';
          if (!copy) return;
          await bench.createEnvironment(
            entry.source,
            created,
            copy === 'Empty' ? undefined : shown.current.selected,
          );
          return await reload(created);
        }
        if (action === 'renameEnvironment' && name) {
          const to = (
            await vscode.window.showInputBox({ title: `Rename “${name}”`, value: name })
          )?.trim();
          if (!to || to === name) return;
          await bench.renameEnvironment(entry.source, name, to);
          if (environmentOf(entry.source) === name) await useEnvironment(entry, to);
          return await reload(to);
        }
        if (action === 'deleteEnvironment' && name) {
          if (
            !(await confirmed(
              `Delete the environment “${name}”?`,
              'Delete',
              'Its variables are removed.',
            ))
          )
            return;
          await bench.deleteEnvironment(entry.source, name);
          return await reload(undefined);
        }
        if (action === 'saveVariables' && name) {
          const rows = environmentRowsFrom(value);
          if (typeof rows === 'string') return shown.update({ ...shown.current, error: rows });
          shown.update({ ...shown.current, saving: true, error: undefined });
          await bench.updateEnvironment(entry.source, name, rows);
          log(`Saved ${rows.length} variable${rows.length === 1 ? '' : 's'} in ${name}.`);
          return await reload(name, { saving: false });
        }
      } catch (error) {
        shown.update({ ...shown.current, saving: false, error: messageOf(error) });
      }
    }
  }
  /** An open Environments page shows a change made in the tree. */
  const refreshEnvironmentsPage = async (source: Source) => {
    const page = Panel.get<EnvironmentsView>(`environments:${sourceKey(source)}`);
    const entry = findLoaded(source);
    if (page && entry) {
      page.dispose();
      await openEnvironments(entry, page.current.selected);
    }
  };
  /**
   * The Credentials page of one of the app's workspaces, as the app's Credentials screen: its saved
   * credentials, and a form to add or change one. `editing` opens the form: `new`, or an id.
   */
  async function openCredentials(entry: Loaded, editing?: string): Promise<void> {
    const key = `credentials:${sourceKey(entry.source)}`;
    const load = async (base: Partial<CredentialsView> = {}): Promise<CredentialsView> => {
      try {
        const credentials = await (await getWorkbench()).secrets(entry.source, vaultPassword);
        return {
          view: 'credentials',
          workspace: entry.source.name,
          vault: 'unlocked',
          credentials,
          revision: 0,
          ...base,
        };
      } catch (error) {
        const locked = /vault is locked|password/i.test(messageOf(error));
        return {
          view: 'credentials',
          workspace: entry.source.name,
          vault: 'locked',
          credentials: [],
          revision: 0,
          ...base,
          ...(locked ? {} : { error: messageOf(error) }),
        };
      }
    };
    const existing = Panel.get<CredentialsView>(key);
    if (existing) {
      existing.reveal();
      if (editing)
        existing.update({ ...existing.current, editing, revision: existing.current.revision + 1 });
      return;
    }
    const panel = new Panel<CredentialsView>(
      key,
      context.extensionUri,
      `Credentials · ${entry.source.name}`,
      await load({ editing }),
      (action, shown, value) => void credentialsAction(action, shown, value),
    );
    const reload = async (extra: Partial<CredentialsView> = {}) => {
      if (Panel.get(key) !== panel) return;
      panel.update(await load({ revision: panel.current.revision + 1, ...extra }));
      credentialsView.refresh(entry.source);
    };
    async function credentialsAction(
      action: Action,
      shown: Panel<CredentialsView>,
      value: unknown,
    ) {
      if (action === 'refresh') return reload({ editing: shown.current.editing });
      if (action === 'unlock') {
        await vscode.commands.executeCommand('apiWorkbench.unlockVault', {
          type: 'group',
          loaded: entry,
        });
        return reload({ editing: shown.current.editing });
      }
      if (action === 'deleteCredential') {
        const row = shown.current.credentials.find((item) => item.id === value);
        if (
          !row ||
          !(await confirmed(
            `Delete the credential “${row.name}”?`,
            'Delete',
            'Requests that use it stop sending it.',
          ))
        )
          return;
        try {
          await (await getWorkbench()).deleteSecret(entry.source, row.id, vaultPassword);
          log(`Deleted the credential “${row.name}”.`);
          await reload();
        } catch (error) {
          shown.update({ ...shown.current, error: messageOf(error) });
        }
        return;
      }
      if (action !== 'saveCredential' || shown.current.saving) return;
      const save = credentialFrom(value, shown.current.credentials);
      if (typeof save === 'string') return shown.update({ ...shown.current, error: save });
      shown.update({ ...shown.current, saving: true, error: undefined });
      try {
        await (await getWorkbench()).saveCredential(entry.source, save, vaultPassword);
        log(`${save.isNew ? 'Saved' : 'Updated'} the credential “${save.name}”.`);
        await reload({ editing: undefined, saving: false });
        void vscode.window.setStatusBarMessage(`Credential “${save.name}” saved`, 3000);
      } catch (error) {
        shown.update({ ...shown.current, saving: false, error: messageOf(error) });
      }
    }
  }
  /**
   * The Certificates page of a workspace, as the app's Settings → Certificates: its client
   * certificates, switched on or off, added and removed, and the CA certificates it trusts.
   * Certificate files are chosen in VS Code's own dialog and the passphrase typed in a hidden box,
   * both handed to the command line here — never through the page.
   */
  async function openCertificates(entry: Loaded): Promise<void> {
    const key = `certificates:${sourceKey(entry.source)}`;
    const load = async (extra: { busy?: boolean; error?: string } = {}) => {
      const meta = { workspace: entry.source.name, canAdd: hasVault(entry.source), ...extra };
      try {
        return certificatesView(await (await getWorkbench()).certificates(entry.source), meta);
      } catch (error) {
        return certificatesView(
          { certificates: [], authorities: [] },
          { ...meta, error: meta.error ?? messageOf(error) },
        );
      }
    };
    const existing = Panel.get<CertificatesView>(key);
    if (existing) return existing.reveal();
    const panel = new Panel<CertificatesView>(
      key,
      context.extensionUri,
      `Certificates · ${entry.source.name}`,
      await load(),
      (action, shown, value) => void certificatesAction(action, shown, value),
    );
    const reload = async (extra: { error?: string } = {}) => {
      if (Panel.get(key) === panel) panel.update(await load(extra));
    };
    /** The vault's password, asking to unlock it first; undefined when it stays locked. */
    const unlocked = async (): Promise<string | undefined> => {
      if (vaultPassword === undefined)
        await vscode.commands.executeCommand('apiWorkbench.unlockVault', {
          type: 'group',
          loaded: entry,
        });
      return vaultPassword;
    };
    const pickFile = async (title: string, filters: Record<string, string[]>) =>
      (
        await vscode.window.showOpenDialog({
          title,
          canSelectMany: false,
          openLabel: 'Choose',
          filters: { ...filters, 'All files': ['*'] },
        })
      )?.[0]?.fsPath;
    async function addCertificate(): Promise<void> {
      const title = 'Add a client certificate';
      const host = (
        await vscode.window.showInputBox({
          title,
          prompt:
            'The host it is presented to: a name, *.example.com for its subdomains, or an address',
          placeHolder: 'api.example.com',
          ignoreFocusOut: true,
          validateInput: (value) => hostProblem(value),
        })
      )?.trim();
      if (!host) return;
      const portText = await vscode.window.showInputBox({
        title,
        prompt: `The port on ${host}, or empty for any port`,
        placeHolder: '443',
        ignoreFocusOut: true,
        validateInput: (value) => portProblem(value),
      });
      if (portText === undefined) return;
      const kind = await vscode.window.showQuickPick(
        [
          {
            label: 'PEM certificate and key',
            description: '.pem, .crt, .key',
            type: 'pem' as const,
          },
          { label: 'PFX/P12 bundle', description: '.pfx, .p12', type: 'pfx' as const },
        ],
        { title, placeHolder: 'What the certificate is kept in' },
      );
      if (!kind) return;
      let files: CertificateFiles;
      if (kind.type === 'pfx') {
        const pfx = await pickFile('Choose the PFX/P12 bundle', { 'PFX/P12': ['pfx', 'p12'] });
        if (!pfx) return;
        files = { pfx };
      } else {
        const cert = await pickFile('Choose the certificate', {
          Certificates: ['pem', 'crt', 'cer'],
        });
        if (!cert) return;
        const keyFile = await pickFile('Choose its private key', { Keys: ['pem', 'key'] });
        if (!keyFile) return;
        files = { cert, key: keyFile };
      }
      const passphrase = await vscode.window.showInputBox({
        title,
        prompt:
          kind.type === 'pfx'
            ? 'The bundle’s passphrase, or empty if it has none'
            : 'The key’s passphrase, or empty if it has none',
        password: true,
        ignoreFocusOut: true,
      });
      if (passphrase === undefined) return;
      const password = await unlocked();
      if (password === undefined) return;
      panel.update({ ...panel.current, busy: true, error: undefined });
      try {
        await (
          await getWorkbench()
        ).addCertificate(
          entry.source,
          { ...files, host, ...(portText.trim() ? { port: Number(portText) } : {}), passphrase },
          password,
        );
        log(
          `Added a client certificate for ${host}${portText.trim() ? `:${portText.trim()}` : ''}.`,
        );
        credentialsView.refresh(entry.source);
        await reload();
      } catch (error) {
        await reload({ error: messageOf(error) });
      }
    }
    async function certificatesAction(
      action: Action,
      shown: Panel<CertificatesView>,
      value: unknown,
    ) {
      if (shown.current.busy && action !== 'refresh') return;
      const bench = await getWorkbench();
      try {
        if (action === 'refresh') return await reload();
        if (action === 'addCertificate') return await addCertificate();
        if (action === 'toggleCertificate') {
          const { id, enabled } = (value ?? {}) as { id?: unknown; enabled?: unknown };
          const row = shown.current.certificates.find((item) => item.id === id);
          if (!row || typeof enabled !== 'boolean') return;
          await bench.setCertificateEnabled(entry.source, row.id, enabled);
          return await reload();
        }
        if (action === 'removeCertificate') {
          const row = shown.current.certificates.find((item) => item.id === value);
          if (
            !row ||
            !(await confirmed(
              `Remove the client certificate for ${row.host}?`,
              'Remove',
              'Requests to it stop presenting it, and its key leaves the vault. The files it was read from are not touched.',
            ))
          )
            return;
          const password = row.legacy ? vaultPassword : await unlocked();
          if (!row.legacy && password === undefined) return;
          await bench.removeCertificate(entry.source, row.id, password);
          log(`Removed the client certificate for ${row.host}.`);
          credentialsView.refresh(entry.source);
          return await reload();
        }
        if (action === 'trustCertificates') {
          const file = await pickFile('Choose CA certificates to trust', {
            'PEM certificates': ['pem', 'crt', 'cer'],
          });
          if (!file) return;
          await bench.trustCertificates(entry.source, file);
          return await reload();
        }
        if (action === 'untrustCertificates') {
          if (
            !(await confirmed(
              'Stop trusting the custom CA certificates?',
              'Stop trusting',
              'Requests in this workspace will trust only the system’s certificate store; servers signed by these CAs will fail verification.',
            ))
          )
            return;
          await bench.trustCertificates(entry.source, undefined);
          return await reload();
        }
      } catch (error) {
        await reload({ error: messageOf(error) });
      }
    }
  }
  /**
   * Saves the mock page's edits with `mock update`, then shows the mock as saved. A running mock
   * keeps its old settings until it is restarted, and the page offers to.
   */
  async function saveMock(
    entry: Loaded,
    mock: ListedMock,
    panel: Panel<MockView>,
    value: unknown,
  ): Promise<void> {
    const saved = panel.current.saved;
    if (!saved || panel.current.saving) return;
    const draft = mockDraftFrom(value, saved);
    if (typeof draft === 'string') return panel.update({ ...panel.current, error: draft });
    const change = mockSettingsChange(saved, draft);
    if (!change) return;
    panel.update({ ...panel.current, saving: true, error: undefined });
    const key = mockKey(entry, mock);
    try {
      const bench = await getWorkbench();
      await bench.updateMock(entry.source, mock.id, change);
      const details = mockDetailsView(await bench.mock(entry.source, mock.id));
      mock.name = draft.settings.name;
      mock.port = draft.settings.port;
      const running = mocks.get(key);
      const view: MockView = {
        ...panel.current,
        ...details,
        name: mock.name,
        port: mock.port,
        https: draft.settings.https.enabled,
        saving: false,
        restartNeeded: Boolean(running?.process),
        revision: (panel.current.revision ?? 0) + 1,
      };
      if (running) running.view = { ...running.view, ...view, log: running.view.log };
      panel.update(view, `Mock · ${mock.name}`);
      mocksView.refresh(entry.source);
      log(`Saved the mock server “${mock.name}”.`);
      // Its new routes are requests in the collection it was made from, too.
      const added = draft.routes.filter((route) => route.id.startsWith('new:')).length;
      if (added && details.fromCollection) {
        await refresh();
        void vscode.window.setStatusBarMessage(
          `Added ${added} route${added === 1 ? '' : 's'} to ${mock.name} and to the collection ${details.fromCollection}`,
          4000,
        );
      }
    } catch (error) {
      panel.update({ ...panel.current, saving: false, error: messageOf(error) });
      log(messageOf(error), 'error');
    }
  }
  /** Sync now: puts a mock made from a collection fully in step with it, both ways. */
  async function syncMockNow(
    entry: Loaded,
    mock: ListedMock,
    panel: Panel<MockView>,
  ): Promise<void> {
    try {
      const done = await (await getWorkbench()).syncMock(entry.source, mock.id);
      log(
        `Synced “${mock.name}” with ${done.collection}: ${done.routesAdded} route(s) and ${done.requestsAdded} request(s) added.`,
      );
      void vscode.window.setStatusBarMessage(
        done.routesAdded || done.requestsAdded
          ? `Added ${done.routesAdded} route${done.routesAdded === 1 ? '' : 's'} and ${done.requestsAdded} request${done.requestsAdded === 1 ? '' : 's'}`
          : `${mock.name} and ${done.collection} are in step`,
        4000,
      );
      await refreshMockPages(entry.source);
      if (done.requestsAdded) await refresh();
    } catch (error) {
      panel.update({ ...panel.current, error: messageOf(error) });
    }
  }
  /** Stops a running mock and starts it again, with its saved settings. */
  async function restartMock(entry: Loaded, mock: ListedMock): Promise<void> {
    const running = mocks.get(mockKey(entry, mock));
    if (running?.process) {
      const exited = running.process.exited;
      stopMock(entry, mock);
      await exited;
    }
    const panel = Panel.get<MockView>(mockPanelKey(mockKey(entry, mock)));
    if (panel) panel.update({ ...panel.current, restartNeeded: false });
    await startMock(entry, mock);
  }
  async function openMock(entry: Loaded, mock: ListedMock): Promise<void> {
    const key = mockKey(entry, mock);
    const panelKey = mockPanelKey(key);
    const existing = Panel.get<MockView>(panelKey);
    if (existing) return existing.reveal();
    const view: MockView = mocks.get(key)?.view ?? {
      view: 'mock',
      name: mock.name,
      workspace: entry.source.name,
      running: false,
      port: mock.port,
      routes: mock.routes,
      https: mock.https,
      log: [],
    };
    const panel = new Panel<MockView>(
      panelKey,
      context.extensionUri,
      `Mock · ${mock.name}`,
      view,
      (action, shown, value) => {
        if (action === 'start') void startMock(entry, mock);
        else if (action === 'stop') stopMock(entry, mock);
        else if (action === 'saveMock') void saveMock(entry, mock, shown, value);
        else if (action === 'restart') void restartMock(entry, mock);
        else if (action === 'syncMock') void syncMockNow(entry, mock, shown);
        else if (action === 'copyUrl' && shown.current.url)
          void vscode.env.clipboard.writeText(shown.current.url);
      },
    );
    // Its routes and settings, shown once listed; a running mock keeps them in its view.
    try {
      const details = mockDetailsView(await (await getWorkbench()).mock(entry.source, mock.id));
      const running = mocks.get(key);
      if (running) running.view = { ...running.view, ...details };
      panel.update({ ...panel.current, ...details });
    } catch (error) {
      log(`Could not list the routes of ${mock.name}: ${messageOf(error)}`, 'error');
    }
  }
  const mockArg = async (arg?: SideItem<ListedMock>) => {
    if (arg?.type === 'value') return { entry: arg.loaded, mock: arg.value };
    const entry = await pickSource(undefined, 'Choose the workspace of the mock server');
    if (!entry) return undefined;
    const list = await (await getWorkbench()).mocks(entry.source);
    if (!list.length) {
      void vscode.window.showInformationMessage(`${entry.source.name} has no mock servers.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      list.map((mock) => ({
        label: mock.name,
        description: `port ${mock.port} · ${mock.routes} routes`,
        mock,
      })),
      { placeHolder: 'Choose a mock server' },
    );
    return picked && { entry, mock: picked.mock };
  };

  // CodeLens: Send Request above each request of a .http file; actions above a specification.
  const lensEvents = new vscode.EventEmitter<void>();
  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensEvents.event,
    provideCodeLenses(document) {
      if (document.languageId === 'http') {
        const uri = document.uri.toString();
        return parseHttpFile(document.getText()).requests.flatMap((request) => {
          const range = new vscode.Range(request.startLine, 0, request.startLine, 0);
          const target: HttpTarget = { uri, id: request.id };
          return [
            new vscode.CodeLens(range, {
              title: '$(play) Send request',
              command: 'apiWorkbench.sendRequest',
              arguments: [target],
            }),
            new vscode.CodeLens(range, {
              title: 'Generate code',
              command: 'apiWorkbench.generateCode',
              arguments: [target],
            }),
            new vscode.CodeLens(range, {
              title: 'Open in Workbench',
              command: 'apiWorkbench.openHttpRequest',
              arguments: [target],
            }),
            new vscode.CodeLens(range, {
              title: 'Save to collection',
              command: 'apiWorkbench.saveToCollection',
              arguments: [target],
            }),
          ];
        });
      }
      if (
        (document.uri.scheme === 'file' || document.uri.scheme === SPEC_SCHEME) &&
        isSpecText(document.getText())
      ) {
        const range = new vscode.Range(0, 0, 0, 0);
        const list = [
          new vscode.CodeLens(range, {
            title: 'Generate collection',
            command: 'apiWorkbench.generateFromSpec',
            arguments: [document.uri],
          }),
          new vscode.CodeLens(range, {
            title: 'Start mock',
            command: 'apiWorkbench.mockFromSpec',
            arguments: [document.uri],
          }),
          new vscode.CodeLens(range, {
            title: 'Preview docs',
            command: 'apiWorkbench.previewDocs',
            arguments: [document.uri],
          }),
          new vscode.CodeLens(range, {
            title: 'Check specification',
            command: 'apiWorkbench.lintSpec',
            arguments: [document.uri],
          }),
        ];
        if (document.uri.scheme === 'file')
          list.push(
            new vscode.CodeLens(range, {
              title: 'Add to workspace',
              command: 'apiWorkbench.importSpec',
              arguments: [document.uri],
            }),
            // VS Code's own formatter for YAML or JSON, whichever is installed.
            new vscode.CodeLens(range, {
              title: 'Format',
              command: 'editor.action.formatDocument',
            }),
          );
        return list;
      }
      return [];
    },
  };
  /** A .http file's header problem shows where it is, as the command line will refuse it. */
  const httpDiagnostics = (document: vscode.TextDocument) => {
    if (document.languageId !== 'http') return;
    const { problem } = parseHttpFile(document.getText());
    diagnostics.set(
      document.uri,
      problem
        ? [
            Object.assign(
              new vscode.Diagnostic(
                document.lineAt(problem.line).range,
                `${problem.message}. A header is “Name: value”; leave a blank line before the body.`,
                vscode.DiagnosticSeverity.Error,
              ),
              { source: 'API Workbench' },
            ),
          ]
        : [],
    );
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{workspace.json,collections/**/*.{yaml,yml},environments/*.{yaml,yml}}',
  );
  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 400);
  };
  watcher.onDidChange(later);
  watcher.onDidCreate(later);
  watcher.onDidDelete(later);

  const useEnvironment = async (entry: Loaded, name: string) => {
    await context.workspaceState.update(`environment:${sourceKey(entry.source)}`, name);
    lastSource = entry.source;
    treeEvents.fire();
    environmentsView.refresh(entry.source);
    syncEnvironmentInPanels(entry.source);
    updateStatus();
  };

  for (const document of vscode.workspace.textDocuments) {
    void lintDocument(document);
    httpDiagnostics(document);
  }

  context.subscriptions.push(
    output,
    view,
    ...sideViews,
    tests,
    status,
    mockStatus,
    vaultStatus,
    watcher,
    treeEvents,
    responseEvents,
    lensEvents,
    diagnostics,
    { dispose: () => clearTimeout(timer) },
    { dispose: () => mocks.forEach((mock) => mock.process?.stop()) },
    vscode.window.registerWebviewViewProvider('apiWorkbench.network', networkPanel),
    vscode.languages.registerCodeLensProvider(
      [{ language: 'http' }, { language: 'yaml' }, { language: 'json' }, { scheme: SPEC_SCHEME }],
      lenses,
    ),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void lintDocument(document);
      httpDiagnostics(document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => void lintDocument(document)),
    vscode.workspace.onDidChangeTextDocument((event) => httpDiagnostics(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('apiWorkbench')) {
        workbench = undefined;
        void refresh();
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.refresh', () => refresh()),
    vscode.commands.registerCommand('apiWorkbench.openRequest', (item?: Item) =>
      openRequest(item).then(() => undefined),
    ),
    vscode.commands.registerCommand('apiWorkbench.sendRequest', (target?: Item | HttpTarget) =>
      send(target),
    ),
    vscode.commands.registerCommand('apiWorkbench.run', (item?: Item) => runItem(item)),
    vscode.commands.registerCommand(
      'apiWorkbench.selectEnvironment',
      async (item?: Item | SideItem<unknown>) => {
        const last = lastSource && findLoaded(lastSource);
        const entry =
          item && item.type !== 'message' ? item.loaded : (last ?? (await pickSource()));
        if (!entry) return;
        try {
          const environments = await (await getWorkbench()).environments(entry.source);
          const current = environmentOf(entry.source);
          const picked = await vscode.window.showQuickPick(
            environments.map((environment) => ({
              label: environment.name,
              iconPath: new vscode.ThemeIcon(
                environment.name === current ? 'pass-filled' : 'circle-large-outline',
              ),
              description: [
                environment.name === current ? 'in use' : '',
                `${environment.variables} variable${environment.variables === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(' · '),
            })),
            {
              placeHolder: `Environment for ${entry.source.name}`,
              prompt: 'Its variables fill in {{names}} in requests sent from VS Code.',
            },
          );
          if (picked) await useEnvironment(entry, picked.label);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.useEnvironment',
      (item?: SideItem<ListedEnvironment>) =>
        item?.type === 'value' ? useEnvironment(item.loaded, item.value.name) : undefined,
    ),
    vscode.commands.registerCommand('apiWorkbench.filterTags', async (item?: Item) => {
      const entry = await pickSource(item);
      if (!entry?.list) return;
      const all = tagsOf(entry.list);
      if (!all.length) {
        void vscode.window.showInformationMessage(`${entry.source.name} has no tagged requests.`);
        return;
      }
      const current = new Set(tagsFor(entry.source));
      const picked = await vscode.window.showQuickPick(
        all.map((tag) => ({ label: tag, picked: current.has(tag) })),
        {
          canPickMany: true,
          placeHolder: 'Run only requests with any of these tags (none: all requests)',
        },
      );
      if (!picked) return;
      await context.workspaceState.update(
        `tags:${sourceKey(entry.source)}`,
        picked.map((choice) => choice.label),
      );
      treeEvents.fire();
    }),
    vscode.commands.registerCommand('apiWorkbench.openRequestFile', async (item?: Item) => {
      if (!item || item.type !== 'request') return;
      const folder = item.loaded.source.folder;
      const file = folder ? await findRequestFile(folder, item.request.id) : undefined;
      if (!file) {
        void vscode.window.showInformationMessage(
          'This request is saved in the app, not in a folder here.',
        );
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    vscode.commands.registerCommand('apiWorkbench.copyAsCurl', async (item?: Item) => {
      if (!item || item.type !== 'request') return;
      try {
        const bench = await getWorkbench();
        const text = await bench.curl(
          item.loaded.source,
          item.request.id,
          environmentOf(item.loaded.source),
        );
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(
          `Copied ${item.request.name} as cURL (secrets redacted).`,
        );
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.generateCode', (target?: Item | HttpTarget) =>
      generateCode(target),
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.saveToCollection',
      async (target?: HttpTarget) => {
        try {
          const found = await httpRequestOf(target);
          if (!found) return;
          const entry = await pickSource(
            undefined,
            `Save “${found.request.name}” to which workspace?`,
          );
          if (!entry) return;
          const existing = entry.list?.collections.filter((name) => !name.includes('/')) ?? [];
          const NEW = 'New collection…';
          const picked = await vscode.window.showQuickPick([...existing, NEW], {
            placeHolder: 'Save it in which collection?',
          });
          if (!picked) return;
          const collection =
            picked === NEW
              ? (await vscode.window.showInputBox({ prompt: 'Name of the new collection' }))?.trim()
              : picked;
          if (!collection) return;
          const created = await (
            await getWorkbench()
          ).createRequest(entry.source, createArgs(found.request, collection));
          // A file body or a multipart form, kept as one rather than as its `< ./path` text.
          const body = savedBodyPlan(found.request);
          if (body)
            await (
              await getWorkbench()
            ).updateRequest(entry.source, created.id, body.args, { input: body.input });
          void refreshMockPages(entry.source);
          void vscode.window.showInformationMessage(
            `Saved “${created.name}” in ${collection} of ${entry.source.name}.`,
          );
          await refresh();
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.importCollection', async (item?: Item) => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import',
        title:
          'Import a collection: API Workbench, Postman, Insomnia, Bruno, OpenAPI, HAR, .http, cURL…',
      });
      if (!files?.[0]) return;
      const entry = await pickSource(item, 'Import into which workspace?');
      if (!entry) return;
      const into = await vscode.window.showInputBox({
        prompt: 'Import as a collection named (leave empty to keep the file’s own names)',
      });
      if (into === undefined) return;
      try {
        const message = await (
          await getWorkbench()
        ).importCollection(entry.source, files[0].fsPath, into.trim() || undefined);
        void vscode.window.showInformationMessage(message || 'Imported.');
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.generateFromSpec',
      async (arg?: SideItem<ListedSpec> | vscode.Uri) => {
        const target = specTarget(arg);
        if (!target) {
          void vscode.window.showInformationMessage('Open an OpenAPI or Swagger file first.');
          return;
        }
        const entry =
          target.entry ?? (await pickSource(undefined, 'Generate into which workspace?'));
        if (!entry) return;
        const collection = await vscode.window.showInputBox({
          prompt: 'Name of the collection to generate',
          value: target.name,
        });
        if (!collection?.trim()) return;
        const bench = await getWorkbench();
        const exists = entry.list?.collections.includes(collection.trim());
        if (exists) {
          const replace = 'Replace it';
          const answer = await vscode.window.showWarningMessage(
            `${entry.source.name} already has a collection “${collection.trim()}”.`,
            { modal: true, detail: 'Replacing it removes its requests and generates them again.' },
            replace,
          );
          if (answer !== replace) return;
        }
        try {
          const message = await bench.generateFromSpec(entry.source, target.spec, {
            collection: collection.trim(),
            replace: exists,
          });
          void vscode.window.showInformationMessage(message);
          await refresh();
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.lintSpec', async (arg?: vscode.Uri) => {
      const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty) await document.save();
      await lintDocument(document);
      const count = diagnostics.get(uri)?.length ?? 0;
      void vscode.window.setStatusBarMessage(
        count
          ? `${count} problem${count === 1 ? '' : 's'} in the specification`
          : 'The specification is valid',
        4000,
      );
      if (count) await vscode.commands.executeCommand('workbench.actions.view.problems');
    }),
    vscode.commands.registerCommand('apiWorkbench.importSpec', async (arg?: vscode.Uri) => {
      const uri = arg ?? vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme !== 'file') return;
      const entry = await pickSource(undefined, 'Add the specification to which workspace?');
      if (!entry) return;
      try {
        const message = await (await getWorkbench()).importSpec(entry.source, uri.fsPath);
        void vscode.window.showInformationMessage(message);
        specsView.refresh(entry.source);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.openMock', async (arg?: SideItem<ListedMock>) => {
      const found = await mockArg(arg);
      if (found) await openMock(found.entry, found.mock);
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.startMock',
      async (arg?: SideItem<ListedMock>) => {
        const found = await mockArg(arg);
        if (!found) return;
        await openMock(found.entry, found.mock);
        await startMock(found.entry, found.mock);
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.stopMock', async (arg?: SideItem<ListedMock>) => {
      if (arg?.type === 'value') return stopMock(arg.loaded, arg.value);
      const running = [...mocks.values()].filter((mock) => mock.process);
      const picked =
        running.length <= 1
          ? running[0]
          : (
              await vscode.window.showQuickPick(
                running.map((mock) => ({
                  label: mock.mock.name,
                  description: mock.view.url,
                  mock,
                })),
                { placeHolder: 'Stop which mock server?' },
              )
            )?.mock;
      if (picked) stopMock(picked.loaded, picked.mock);
    }),
    vscode.commands.registerCommand('apiWorkbench.unlockVault', async (arg?: SideItem<unknown>) => {
      const entry =
        arg && arg.type !== 'message'
          ? arg.loaded
          : await pickSource(undefined, 'Unlock the credentials of which workspace?');
      if (!entry || !hasVault(entry.source)) return;
      const password = await vscode.window.showInputBox({
        title: 'Unlock the API Workbench vault',
        prompt:
          'The vault password you set in the app. It is given only to the command line, never shown or logged.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return;
      // Checked before it is kept: a wrong password, or a vault only the app can open, says so.
      try {
        await (await getWorkbench()).secrets(entry.source, password);
      } catch (error) {
        const message = messageOf(error);
        if (/system’s credential store|only the (desktop )?app can open/i.test(message)) {
          void vscode.window.showInformationMessage(
            'Your credentials are in the system keychain, which only the API Workbench app opens. In the app, choose Credentials → Use the API Workbench vault, then unlock it here with its password.',
            { modal: true },
          );
          return;
        }
        return report(error);
      }
      const remember = await vscode.window.showQuickPick(
        [
          { label: 'Until this window closes', remember: false },
          {
            label: 'Remember in the system keychain',
            description: 'Unlocks on its own in new windows',
            remember: true,
          },
        ],
        { title: 'Keep the vault unlocked', placeHolder: 'For how long?' },
      );
      if (!remember) return;
      vaultPassword = password;
      vaultRemembered = remember.remember;
      if (remember.remember) await context.secrets.store(vaultSecretKey(), password);
      credentialsView.refresh();
      updateVaultStatus();
    }),
    vscode.commands.registerCommand('apiWorkbench.lockVault', () => {
      // Locks this window; a remembered password unlocks the next one, until it is forgotten.
      vaultPassword = undefined;
      credentialsView.refresh();
      updateVaultStatus();
    }),
    vscode.commands.registerCommand('apiWorkbench.forgetVaultPassword', async () => {
      await context.secrets.delete(vaultSecretKey());
      vaultRemembered = false;
      vaultPassword = undefined;
      credentialsView.refresh();
      updateVaultStatus();
      void vscode.window.setStatusBarMessage('Vault password forgotten', 3000);
    }),
    vscode.commands.registerCommand('apiWorkbench.refreshHistory', () => historyView.refresh()),
    vscode.commands.registerCommand('apiWorkbench.clearNetwork', () => clearPanel()),
    // Help and feedback: GitHub's issue forms, filled in, and the documentation.
    vscode.commands.registerCommand('apiWorkbench.reportIssue', async () => {
      const title = await vscode.window.showInputBox({
        title: 'Report a problem',
        prompt:
          'A short summary, such as “Mock server stops when its port changes”. GitHub’s form opens next, filled in with your versions; remove tokens and other secrets from anything you add.',
        placeHolder: 'What went wrong (optional)',
      });
      if (title === undefined) return;
      const include = settings().get<boolean>('reportDiagnostics', true);
      await openPage(
        bugReportUrl({
          version: `VS Code extension ${String(context.extension.packageJSON.version ?? '')}`,
          platform: process.platform,
          title: title.trim() || undefined,
          details: include ? await diagnosticText() : undefined,
        }),
      );
    }),
    vscode.commands.registerCommand('apiWorkbench.requestFeature', async () => {
      const problem = await vscode.window.showInputBox({
        title: 'Request a feature',
        prompt: 'What are you trying to do that is hard today? GitHub’s form opens next.',
        placeHolder: 'The problem it would solve (optional)',
      });
      if (problem === undefined) return;
      await openPage(
        featureRequestUrl({
          problem: problem.trim() ? `In VS Code: ${problem.trim()}` : undefined,
        }),
      );
    }),
    vscode.commands.registerCommand('apiWorkbench.searchIssues', async () => {
      const words = await vscode.window.showInputBox({
        title: 'Search known issues',
        prompt: 'Words from the problem, such as an error message',
      });
      if (words?.trim()) await openPage(issueSearchUrl(words.trim()));
    }),
    vscode.commands.registerCommand('apiWorkbench.reportVulnerability', () =>
      openPage(HELP_PAGES['apiWorkbench.reportVulnerability']),
    ),
    vscode.commands.registerCommand('apiWorkbench.forgetAllowedHosts', async () => {
      const count = approvedHosts().length;
      await context.workspaceState.update(ALLOWED_HOSTS, undefined);
      void vscode.window.showInformationMessage(
        count
          ? `Forgot ${count} approved host${count === 1 ? '' : 's'}: .http files in this workspace ask again before sending anywhere but this computer.`
          : 'No hosts were approved in this workspace.',
      );
    }),
    vscode.commands.registerCommand('apiWorkbench.openDocs', () =>
      openPage(HELP_PAGES['apiWorkbench.openDocs']),
    ),
    vscode.commands.registerCommand('apiWorkbench.openTroubleshooting', () =>
      openPage(HELP_PAGES['apiWorkbench.openTroubleshooting']),
    ),
    vscode.commands.registerCommand('apiWorkbench.openChangelog', () =>
      openPage(HELP_PAGES['apiWorkbench.openChangelog']),
    ),
    vscode.commands.registerCommand('apiWorkbench.openRepository', () =>
      openPage(HELP_PAGES['apiWorkbench.openRepository']),
    ),
    vscode.commands.registerCommand('apiWorkbench.copyDiagnostics', async () => {
      await vscode.env.clipboard.writeText(await diagnosticText());
      void vscode.window.setStatusBarMessage('Diagnostic information copied', 3000);
    }),
    vscode.commands.registerCommand('apiWorkbench.openApp', async () => {
      const opened = await vscode.env.openExternal(vscode.Uri.parse('apiworkbench://'));
      if (!opened)
        void vscode.window.showInformationMessage(
          'Install API Workbench to open it from here: https://github.com/techieutils/api-workbench/releases',
        );
    }),
    vscode.commands.registerCommand('apiWorkbench.showOutput', () => output.show()),
    vscode.commands.registerCommand('apiWorkbench.openRunner', (item?: Item) => openRunner(item)),
    vscode.commands.registerCommand('apiWorkbench.previewDocs', previewDocs),
    vscode.commands.registerCommand('apiWorkbench.mockFromSpec', mockFromSpec),
    vscode.commands.registerCommand('apiWorkbench.openHttpRequest', (target?: HttpTarget) =>
      openHttpRequest(target),
    ),
    vscode.commands.registerCommand('apiWorkbench.newRequest', (item?: Item) =>
      openNewRequest(item),
    ),
    vscode.commands.registerCommand('apiWorkbench.deleteRequest', async (item?: Item) => {
      if (item?.type !== 'request') return;
      if (
        !(await confirmed(
          `Delete “${item.request.name}”?`,
          'Delete',
          item.loaded.source.kind === 'team'
            ? 'Its file is removed from the team folder.'
            : 'This cannot be undone.',
        ))
      )
        return;
      try {
        await (await getWorkbench()).deleteRequest(item.loaded.source, item.request.id);
        Panel.get(requestPanelKey(item.loaded, item.request))?.dispose();
        log(`Deleted “${item.request.name}”.`);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.newCollection', async (item?: Item) => {
      const entry = await pickSource(item, 'Add the collection to which workspace?');
      if (!entry) return;
      const name = (
        await vscode.window.showInputBox({ prompt: 'Name of the new collection' })
      )?.trim();
      if (!name) return;
      try {
        await (await getWorkbench()).createCollection(entry.source, name);
        log(`Created collection “${name}”.`);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.renameCollection', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      const name = (
        await vscode.window.showInputBox({
          prompt: `Rename “${item.node.name}” to`,
          value: item.node.name,
        })
      )?.trim();
      if (!name || name === item.node.name) return;
      const parent = item.node.path.split('/').slice(0, -1);
      try {
        await (
          await getWorkbench()
        ).renameCollection(item.loaded.source, item.node.path, [...parent, name].join('/'));
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.deleteCollection', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      const count = requestsUnder(item.node).length;
      if (
        !(await confirmed(
          `Delete “${item.node.path}” and its ${count} request${count === 1 ? '' : 's'}?`,
          'Delete',
          'This cannot be undone.',
        ))
      )
        return;
      try {
        await (await getWorkbench()).deleteCollection(item.loaded.source, item.node.path);
        log(`Deleted “${item.node.path}”.`);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.exportCollection', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      const formats = [
        { label: 'API Workbench', id: 'workbench', extension: 'json' },
        { label: 'Postman Collection v2.1', id: 'postman', extension: 'json' },
        { label: 'Insomnia', id: 'insomnia', extension: 'yaml' },
        { label: 'Bruno', id: 'bruno', extension: 'json' },
        { label: 'OpenAPI 3 (YAML)', id: 'openapi-yaml', extension: 'yaml' },
        { label: 'OpenAPI 3 (JSON)', id: 'openapi-json', extension: 'json' },
        { label: 'HAR', id: 'har', extension: 'har' },
        { label: '.http file', id: 'http', extension: 'http' },
        { label: 'cURL commands', id: 'curl', extension: 'sh' },
      ];
      const format = await vscode.window.showQuickPick(formats, {
        placeHolder: `Export “${item.node.path}” as`,
      });
      if (!format) return;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const file = await vscode.window.showSaveDialog({
        defaultUri: folder
          ? vscode.Uri.joinPath(folder, `${item.node.name}.${format.extension}`)
          : undefined,
        saveLabel: 'Export',
      });
      if (!file) return;
      try {
        await (
          await getWorkbench()
        ).exportCollection(item.loaded.source, item.node.path, format.id, file.fsPath);
        void vscode.window
          .showInformationMessage(`Exported ${item.node.path}.`, 'Open')
          .then((open) => open && vscode.window.showTextDocument(file));
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.newEnvironment',
      async (arg?: SideItem<EnvItem>) => {
        const entry = await pickSource(arg, 'Add the environment to which workspace?');
        if (!entry) return;
        const name = (
          await vscode.window.showInputBox({ prompt: 'Name of the new environment' })
        )?.trim();
        if (!name) return;
        const copy =
          arg?.type === 'value' && !arg.value.variable
            ? arg.value.name
            : environmentOf(entry.source);
        const copyIt =
          copy &&
          (await vscode.window.showQuickPick([`Copy the variables of ${copy}`, 'Start empty'], {
            placeHolder: 'Its variables',
          }));
        if (copyIt === undefined && copy) return;
        try {
          await (
            await getWorkbench()
          ).createEnvironment(entry.source, name, copyIt?.startsWith('Copy') ? copy : undefined);
          environmentsView.refresh(entry.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.renameEnvironment',
      async (arg?: SideItem<EnvItem>) => {
        if (arg?.type !== 'value' || arg.value.variable) return;
        const name = (
          await vscode.window.showInputBox({
            prompt: `Rename “${arg.value.name}” to`,
            value: arg.value.name,
          })
        )?.trim();
        if (!name || name === arg.value.name) return;
        try {
          await (await getWorkbench()).renameEnvironment(arg.loaded.source, arg.value.name, name);
          if (environmentOf(arg.loaded.source) === arg.value.name)
            await useEnvironment(arg.loaded, name);
          environmentsView.refresh(arg.loaded.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.deleteEnvironment',
      async (arg?: SideItem<EnvItem>) => {
        if (arg?.type !== 'value' || arg.value.variable) return;
        if (!(await confirmed(`Delete the environment “${arg.value.name}”?`, 'Delete'))) return;
        try {
          await (await getWorkbench()).deleteEnvironment(arg.loaded.source, arg.value.name);
          if (environmentOf(arg.loaded.source) === arg.value.name)
            await context.workspaceState.update(
              `environment:${sourceKey(arg.loaded.source)}`,
              undefined,
            );
          environmentsView.refresh(arg.loaded.source);
          updateStatus();
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.openEnvironments',
      async (arg?: SideItem<EnvItem>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Open the environments of which workspace?');
        if (entry)
          await openEnvironments(entry, arg?.type === 'value' ? arg.value.name : undefined);
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.addVariable', (arg?: SideItem<EnvItem>) =>
      arg?.type === 'value'
        ? vscode.commands.executeCommand('apiWorkbench.setVariable', {
            ...arg,
            value: { ...arg.value, variable: undefined },
          })
        : undefined,
    ),
    vscode.commands.registerCommand('apiWorkbench.setVariable', async (arg?: SideItem<EnvItem>) => {
      if (arg?.type !== 'value') return;
      const existing = arg.value.variable;
      const name =
        existing?.key ??
        (
          await vscode.window.showInputBox({
            prompt: `A variable of ${arg.value.name}`,
            placeHolder: 'base_url',
            validateInput: (text) =>
              /^[^\s={}]+$/.test(text.trim())
                ? undefined
                : 'A name without spaces, “=”, or braces.',
          })
        )?.trim();
      if (!name) return;
      const hidden = existing?.value === '<hidden>';
      const value = await vscode.window.showInputBox({
        prompt: `${name} in ${arg.value.name}`,
        value: hidden ? '' : (existing?.value ?? ''),
        placeHolder: hidden ? 'Its value is hidden; type a new one to replace it' : undefined,
        // A value whose name looks secret is typed unseen, as it is listed hidden.
        password: hidden,
      });
      if (value === undefined) return;
      try {
        await (await getWorkbench()).setVariable(arg.loaded.source, arg.value.name, name, value);
        environmentsView.refresh(arg.loaded.source);
        void refreshEnvironmentsPage(arg.loaded.source);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.unsetVariable',
      async (arg?: SideItem<EnvItem>) => {
        if (arg?.type !== 'value' || !arg.value.variable) return;
        try {
          await (
            await getWorkbench()
          ).unsetVariable(arg.loaded.source, arg.value.name, arg.value.variable.key);
          environmentsView.refresh(arg.loaded.source);
          void refreshEnvironmentsPage(arg.loaded.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.deleteCookie',
      async (arg?: SideItem<JarCookie>) => {
        if (arg?.type !== 'value') return;
        try {
          await (
            await getWorkbench()
          ).deleteCookie(arg.loaded.source, arg.value.name, arg.value.domain);
          cookiesView.refresh(arg.loaded.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.clearCookies',
      async (arg?: SideItem<unknown>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Clear the cookies of which workspace?');
        if (!entry || entry.source.kind !== 'app') return;
        if (!(await confirmed(`Clear every cookie of ${entry.source.name}?`, 'Clear'))) return;
        try {
          await (await getWorkbench()).clearCookies(entry.source);
          cookiesView.refresh(entry.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.refreshCookies', () => cookiesView.refresh()),
    vscode.commands.registerCommand(
      'apiWorkbench.resendHistory',
      (arg?: SideItem<HistoryEntry>) => {
        if (arg?.type !== 'value') return;
        const request = arg.loaded.list?.requests.find((r) => r.name === arg.value.request);
        if (request) return sendSaved({ type: 'request', loaded: arg.loaded, request });
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.newRequestFromCurl', async (item?: Item) => {
      const entry = await pickSource(item, 'Add the request to which workspace?');
      if (!entry) return;
      const clipboard = await vscode.env.clipboard.readText();
      const curl = await vscode.window.showInputBox({
        title: 'New Request from cURL',
        prompt: 'A cURL command, such as one copied from a browser’s developer tools',
        value: /^\s*curl\s/i.test(clipboard) ? clipboard.trim() : '',
        placeHolder: "curl https://api.example.com/orders -H 'Accept: application/json'",
        ignoreFocusOut: true,
      });
      if (!curl?.trim()) return;
      try {
        const created = await (
          await getWorkbench()
        ).createRequestFromCurl(
          entry.source,
          curl,
          item?.type === 'folder' ? item.node.path : undefined,
        );
        log(`Created “${created.name}” in ${created.folder} from cURL.`);
        void refreshMockPages(entry.source);
        await refresh();
        const fresh = findLoaded(entry.source);
        const request = fresh?.list?.requests.find((r) => r.id === created.id);
        if (fresh && request) await openRequest({ type: 'request', loaded: fresh, request });
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.teamStatus', (item?: Item) =>
      teamAction(item, 'status'),
    ),
    vscode.commands.registerCommand('apiWorkbench.teamCommit', (item?: Item) =>
      teamAction(item, 'commit'),
    ),
    vscode.commands.registerCommand('apiWorkbench.teamPull', (item?: Item) =>
      teamAction(item, 'pull'),
    ),
    vscode.commands.registerCommand('apiWorkbench.teamPush', (item?: Item) =>
      teamAction(item, 'push'),
    ),
    vscode.commands.registerCommand('apiWorkbench.teamSync', (item?: Item) =>
      teamAction(item, 'sync'),
    ),
    vscode.commands.registerCommand('apiWorkbench.newWorkspace', async () => {
      const name = (
        await vscode.window.showInputBox({
          title: 'New Workspace',
          prompt: 'A workspace of the API Workbench app, on this computer',
        })
      )?.trim();
      if (!name) return;
      try {
        const created = await (await getWorkbench()).createWorkspace(name);
        log(`Created workspace “${created.name}”.`);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.renameWorkspace', async (item?: Item) => {
      if (item?.type !== 'source' || item.loaded.source.kind !== 'app') return;
      const source = item.loaded.source;
      const name = (
        await vscode.window.showInputBox({
          prompt: `Rename “${source.name}” to`,
          value: source.name,
        })
      )?.trim();
      if (!name || name === source.name) return;
      try {
        await (await getWorkbench()).renameWorkspace(source.id, name);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.deleteWorkspace', async (item?: Item) => {
      if (item?.type !== 'source' || item.loaded.source.kind !== 'app') return;
      const source = item.loaded.source;
      if (
        !(await confirmed(
          `Delete the workspace “${source.name}”?`,
          'Delete',
          source.folder
            ? 'Its shared team folder is kept.'
            : 'Its collections, environments, and history are removed from this computer.',
        ))
      )
        return;
      try {
        await (await getWorkbench()).deleteWorkspace(source.id);
        await refresh();
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.addCredential',
      async (arg?: SideItem<unknown>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Save the credential in which workspace?');
        if (entry && hasVault(entry.source)) await openCredentials(entry, 'new');
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.openCredentials',
      async (arg?: SideItem<unknown>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Open the credentials of which workspace?');
        if (entry && hasVault(entry.source)) await openCredentials(entry);
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.chooseHttpEnvironment', async () => {
      type Pick = vscode.QuickPickItem & { choice?: HttpEnvironmentChoice | 'automatic' };
      const items: Pick[] = [
        {
          label: 'Automatic',
          description: 'the environment in use of the team folder a file is in',
          choice: 'automatic',
        },
        { label: 'None', description: "only a file's own @variables", choice: 'none' },
      ];
      const bench = await getWorkbench();
      for (const entry of loaded.filter((item) => !item.error)) {
        let names: string[];
        try {
          names = (await bench.environments(entry.source)).map((item) => item.name);
        } catch {
          continue;
        }
        if (!names.length) continue;
        items.push({ label: entry.source.name, kind: vscode.QuickPickItemKind.Separator });
        for (const name of names)
          items.push({
            label: name,
            description: entry.source.name,
            choice: { key: sourceKey(entry.source), environment: name },
          });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Environment for .http files',
        placeHolder: "Where {{variables}} come from, under each file's own @variables",
      });
      if (!picked?.choice) return;
      await context.workspaceState.update(
        HTTP_ENVIRONMENT,
        picked.choice === 'automatic' ? undefined : picked.choice,
      );
      updateHttpStatus();
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.openCertificates',
      async (arg?: SideItem<unknown>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Open the certificates of which workspace?');
        if (entry) await openCertificates(entry);
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.editCredential',
      async (arg?: SideItem<ListedSecret>) => {
        if (arg?.type === 'value') await openCredentials(arg.loaded, arg.value.id);
      },
    ),
    vscode.commands.registerCommand(
      'apiWorkbench.deleteCredential',
      async (arg?: SideItem<ListedSecret>) => {
        if (arg?.type !== 'value') return;
        if (!(await confirmed(`Delete the credential “${arg.value.name}”?`, 'Delete'))) return;
        try {
          await (await getWorkbench()).deleteSecret(arg.loaded.source, arg.value.id, vaultPassword);
          credentialsView.refresh(arg.loaded.source);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand('apiWorkbench.collectionDocs', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      try {
        const content = await (
          await getWorkbench()
        ).collectionDocs(item.loaded.source, item.node.path);
        const document = await vscode.workspace.openTextDocument({ content, language: 'yaml' });
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.specFromCollection', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      const name = (
        await vscode.window.showInputBox({
          prompt: 'Name of the specification',
          value: `${item.node.name} API`,
        })
      )?.trim();
      if (!name) return;
      try {
        const message = await (
          await getWorkbench()
        ).specFromCollection(item.loaded.source, item.node.path, name);
        log(message || `Created the specification “${name}”.`);
        specsView.refresh(item.loaded.source);
        void vscode.window.showInformationMessage(message || `Created “${name}” in API Specs.`);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand('apiWorkbench.mockFromCollection', async (item?: Item) => {
      if (item?.type !== 'folder') return;
      try {
        const bench = await getWorkbench();
        const existing = (await bench.mocks(item.loaded.source)).map((m) => m.name.toLowerCase());
        let name = `${item.node.name} mock`;
        for (let n = 2; existing.includes(name.toLowerCase()); n++)
          name = `${item.node.name} mock ${n}`;
        const created = await bench.createMock(item.loaded.source, name, {
          collection: item.node.path,
        });
        log(
          `Created mock “${created.name}” with ${created.routes} routes on port ${created.port}.`,
        );
        mocksView.refresh(item.loaded.source);
        const mock: ListedMock = { ...created, https: false };
        await openMock(item.loaded, mock);
        await startMock(item.loaded, mock);
      } catch (error) {
        report(error);
      }
    }),
    vscode.commands.registerCommand(
      'apiWorkbench.clearHistory',
      async (arg?: SideItem<unknown>) => {
        const entry =
          arg && arg.type !== 'message'
            ? arg.loaded
            : await pickSource(undefined, 'Clear the history of which workspace?');
        if (!entry || entry.source.kind !== 'app') return;
        if (
          !(await confirmed(
            `Clear your history in ${entry.source.name}?`,
            'Clear',
            'Teammates’ history stays theirs.',
          ))
        )
          return;
        try {
          await (await getWorkbench()).clearHistory(entry.source);
          historyView.refresh(entry.source);
        } catch (error) {
          report(error);
        }
      },
    ),
  );

  // Request scripts in VS Code's editors, with the app's suggestions and syntax check.
  context.subscriptions.push(
    ...registerScripts({
      source: (key) => loaded.find((entry) => sourceKey(entry.source) === key)?.source,
      workbench: getWorkbench,
      environmentOf,
      lastSend: (source, id) => lastSends.get(`request:${sourceKey(source)}#${id}`),
      saved: (source, id) => {
        const panel = Panel.get<RequestView>(`request:${sourceKey(source)}#${id}`);
        if (!panel) return;
        void getWorkbench()
          .then((bench) => bench.showRequest({ source }, id))
          .then((details) =>
            panel.update({ ...panel.current, scripts: details.scripts ?? { pre: '', post: '' } }),
          )
          .catch(() => undefined);
      },
      log,
    }),
  );

  // Tools for language models in VS Code, such as Copilot's agent mode.
  context.subscriptions.push(
    ...registerTools({
      ready: async () => {
        if (loading) await loading;
      },
      sources: () => loaded,
      workbench: getWorkbench,
      environmentOf,
      scriptsAllowed: () => settings().get<string>('scripts', 'ask') === 'allow',
      vaultPassword: () => vaultPassword,
      credentialsAllowed: () => settings().get<boolean>('toolsUseSavedCredentials', true),
      logSend,
      log,
    }),
  );

  void refresh();
  return {
    ready: async () => {
      await (loading ?? refresh());
    },
    sources: () =>
      loaded.map((entry) => ({
        name: entry.source.name,
        kind: entry.source.kind,
        requests: entry.list?.requests.length ?? 0,
        error: entry.error,
      })),
    item: (sourceName, requestId) => {
      const entry = loaded.find((l) => l.source.name === sourceName);
      if (!entry) return undefined;
      if (!requestId) return { type: 'source', loaded: entry } satisfies Item;
      const request = entry.list?.requests.find((r) => r.id === requestId);
      return request && ({ type: 'request', loaded: entry, request } satisfies Item);
    },
    results: () => ({ ...lastResults }),
    lastResponse: () => lastResponse,
    network: () => networkView(network, consoleLog),
    engine: async () => (await getWorkbench()).engineDescription,
    live: (sourceName, requestId) => {
      const entry = loaded.find((l) => l.source.name === sourceName);
      return entry
        ? Panel.get<LiveView>(`live:${sourceKey(entry.source)}#${requestId}`)?.current
        : undefined;
    },
    scriptUri: (sourceName, requestId, phase) => {
      const entry = loaded.find((l) => l.source.name === sourceName);
      const request = entry?.list?.requests.find((r) => r.id === requestId);
      return entry && request
        ? scriptUri(sourceKey(entry.source), request.id, phase, request.name)
        : undefined;
    },
  };
}

export function deactivate(): void {
  // Everything is disposed through the extension context, which stops running mock servers.
}
