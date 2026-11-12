import { authorizeProtocol } from './protocol-auth';
import { startProtocol, inspectProto } from './protocols';
import type { ProtocolSession } from './protocols';
import { mqttOriginURL } from '@techieutils/api-workbench-common/protocol-config';
import { TeamPresenceService } from './team-presence';
import { CloseGuard } from './close-guard';
import { WorkbenchVault, isWorkbenchVaultData } from './workbench-vault';
import { moveVaultFiles, readBackendChoice, writeBackendChoice } from './vault-backend';
import { TeamGit, findTeamFolders } from './team-git';
import { importLink } from './link-import';
import { checkedGistInput, publishGist } from './gist-share';
import { gitRemoteProblem, repositoryName } from '@techieutils/api-workbench-common/share-links';
import type {
  MockServer,
  ProtocolPayload,
  ProtocolSendOptions,
} from '@techieutils/api-workbench-common/types';
import { payloadSettings } from '@techieutils/api-workbench-common/http-settings';
import { resolveCredential, resolveExternalSecret } from './secret-providers';
import { codegenTargets, generateCode } from './codegen';
import { generateLiveCode, isLiveProtocol, liveTargets } from './codegen-live';
import { parseDocument } from 'yaml';
import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
  webContents,
  WebContentsView,
} from 'electron';
import { ScriptHost, ScriptTrust, type ScriptProcess } from './scripts';
import { fromAppWindow, guardWebContents, restrictPermissions } from './web-security';
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { AuthorityStore, Interceptor } from './interceptor';
import { MockServers, type MockCertificate } from './mock-servers';
import { isLongLived, issueCertificate, normalizeDomains, sameDomains } from './interceptor-ca';
import { Confirmations } from './confirmations';
import {
  TrustedAuthorities,
  trustCommands,
  untrustCommands,
  type TrustCommand,
} from './interceptor-trust';
import { X509Certificate } from 'node:crypto';
import {
  checkedCertificatePayload,
  sanitizeClientCertificates,
  type FileCertificatePayload,
} from '@techieutils/api-workbench-common/client-certificates';
import { loadClientCertificate, type LoadedClientCertificate } from './client-certificates';
import { prepareCertificateCredential, vaultCertificate } from './vault-certificates';
import { vaultLocked } from '@techieutils/api-workbench-common/vault-messages';
import { isExternalLink } from '@techieutils/api-workbench-common/external-links';
import type {
  CredentialInput,
  RequestPayload,
  RequestResponse,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceStore } from './workspaces';
import { CredentialVault, withCredential, type SecretStorage } from './credentials';
import { browserAuthorization, exchangeToken, requestOAuthToken } from './oauth';
import { discoverOAuth } from './oauth-discovery';
import { sendHttpRequest } from './http';
import { TerminalSessions } from './terminal';
import {
  dockBounds,
  stagedCommand,
  terminalPreferences,
  type DockBounds,
  type TerminalPreferences,
} from './terminal-window';
import { UpdateService, type Updater } from './updates';
import { APP_USER_MODEL_ID, protocolExecutable, URL_SCHEME } from './app-links';
let window: BrowserWindow | null = null;
/**
 * Registers an IPC handler that answers only the app window's top frame, where the preload and so
 * the bridge run; a call from any other window or frame is refused. Every handler goes through it.
 */
function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each channel has its own arguments
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  // eslint-disable-next-line no-restricted-syntax -- the one place handlers are registered
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppWindow(event, window?.webContents))
      throw new Error('This request is only accepted from the app window.');
    return listener(event, ...args);
  });
}
let vault: CredentialVault;
let vaultUnlocked = false;
let oauthController: AbortController | undefined;
let workspaceStore: WorkspaceStore;
let workspaceSwitching = false;
let vaultOperations = 0;
/**
 * The API Workbench vault, API Workbench's own encryption with a vault password, used when the
 * system has no credential store. One for the app, kept beside the workspaces.
 */
let workbenchVaultInstance: WorkbenchVault | undefined;
function workbenchVault(): WorkbenchVault {
  workbenchVaultInstance ??= new WorkbenchVault(
    path.join(app.getPath('userData'), 'vault-key.json'),
    {
      // Locked on its own after going unused: the app forgets what it had read.
      onLock: () => {
        vaultUnlocked = false;
        if (window && !window.webContents.isDestroyed()) window.webContents.send('vault:locked');
      },
    },
  );
  return workbenchVaultInstance;
}
/** The OS's store name, as Electron reports it; `basic_text` on Linux means there is none. */
const osBackend = () =>
  process.platform === 'linux'
    ? safeStorage.getSelectedStorageBackend()
    : process.platform === 'darwin'
      ? 'macOS Keychain'
      : 'Windows DPAPI';
/** Whether the OS can encrypt secrets: available, and not Linux's plain-text fallback. */
let osUsable = true;
async function osStoreAvailable(): Promise<boolean> {
  return (
    (await safeStorage.isAsyncEncryptionAvailable()) &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  );
}
/**
 * The API Workbench vault chosen over the system's store (Credentials → Use the API Workbench
 * vault), so the command line and the VS Code extension can read credentials with its password.
 */
const backendFile = () => path.join(app.getPath('userData'), 'vault-backend.json');
let workbenchChosen: boolean | undefined;
const chosenWorkbench = () =>
  (workbenchChosen ??= readBackendChoice(backendFile()) === 'workbench');
async function osEncryptionUsable(): Promise<boolean> {
  osUsable = !chosenWorkbench() && (await osStoreAvailable());
  return osUsable;
}
/**
 * Moves every workspace's credentials to the store in use: into the API Workbench vault once it is
 * chosen and open, or back to the system's store. Nothing is moved while the vault is locked.
 */
async function moveCredentials(toWorkbench: boolean): Promise<number> {
  const keeper = workbenchVault();
  if (!keeper.unlocked) return 0;
  const index = await workspaceStore.list();
  const files = index.workspaces.map((item) => workspaceStore.vaultPath(item.id));
  return withVault(() =>
    moveVaultFiles(
      files,
      toWorkbench
        ? {
            needs: (data) => !isWorkbenchVaultData(data),
            decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
            encrypt: async (text) => keeper.encrypt(text),
          }
        : {
            needs: isWorkbenchVaultData,
            decrypt: async (data) => keeper.decrypt(data),
            encrypt: (text) => safeStorage.encryptStringAsync(text),
          },
    ),
  );
}
/**
 * Encryption for secrets at rest: the OS's credential store when it has one, otherwise the API
 * Workbench vault. Each file is read by whichever encrypted it (the vault's files are tagged), and
 * read when called so tests can stand in for safeStorage.
 */
const secretStorage: SecretStorage = {
  isAsyncEncryptionAvailable: async () => (await osEncryptionUsable()) || workbenchVault().unlocked,
  encryptStringAsync: async (value) =>
    (await osEncryptionUsable())
      ? safeStorage.encryptStringAsync(value)
      : workbenchVault().encrypt(value),
  decryptStringAsync: async (value) =>
    isWorkbenchVaultData(value)
      ? { result: workbenchVault().decrypt(value), shouldReEncrypt: false }
      : safeStorage.decryptStringAsync(value),
  getSelectedStorageBackend: () => (osUsable ? osBackend() : 'API Workbench vault'),
  vaultState: async () => {
    if (await osEncryptionUsable()) return { kind: 'os', setUp: true, locked: false };
    const state = await workbenchVault().state();
    // Chosen over the system's store, which it can go back to.
    const chosen = chosenWorkbench() && (await osStoreAvailable());
    return {
      kind: 'workbench',
      ...(chosen ? { chosen: true, system: osBackend() } : {}),
      setUp: state.setUp,
      locked: !state.unlocked,
      ...(state.locksAt ? { locksAt: state.locksAt } : {}),
      ...(state.retryAfterSeconds ? { retryAfterSeconds: state.retryAfterSeconds } : {}),
    };
  },
};
function initializeVault(id: string): void {
  vaultUnlocked = false;
  vault = new CredentialVault(workspaceStore.vaultPath(id), secretStorage);
}
async function withVault<T>(operation: () => Promise<T>): Promise<T> {
  if (workspaceSwitching) throw new Error('Wait for workspace switching to finish.');
  vaultOperations++;
  try {
    return await operation();
  } finally {
    vaultOperations--;
  }
}
const active = new Map<string, AbortController>();
const iconDirectory = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.dirname(require.resolve('@techieutils/api-workbench-assets/icons/icon.png'));
let iconTheme: 'light' | 'dark' = 'dark';
handle('appearance:theme', (event, theme: unknown) => {
  if (
    event.sender !== window?.webContents ||
    (theme !== 'light' && theme !== 'dark') ||
    iconTheme === theme
  )
    return;
  iconTheme = theme;
  // The terminal window follows the app's theme; it cannot read the app's settings itself.
  if (terminalView && !terminalView.webContents.isDestroyed())
    terminalView.webContents.send('terminal:theme', theme);
  const directory = path.join(iconDirectory(), theme);
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(directory, 'icon-mac.png'));
  else
    window?.setIcon(path.join(directory, process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
});
/**
 * The only way the app opens anything outside itself. The operating system would also open
 * `file:`, `smb:`, and other apps' schemes — which can start a program — so only web and mail
 * links are passed on, whoever asked: the renderer, or an OAuth sign-in page from a collection.
 */
async function openWebLink(url: unknown): Promise<void> {
  if (typeof url !== 'string' || !isExternalLink(url))
    throw new Error('Only web and mail links can be opened.');
  await shell.openExternal(url);
}
// Opens a link from the renderer, such as one in a Markdown response, after the person confirmed it
// there.
handle('shell:open-external', async (event, url: unknown) => {
  if (event.sender !== window?.webContents) return;
  await openWebLink(url);
});
const protocolSessions = new Map<
  string,
  { owner: number; handle?: ProtocolSession; ended: boolean }
>();
function stopProtocolSessions(): void {
  for (const entry of [...protocolSessions.values()]) entry.handle?.stop();
  protocolSessions.clear();
}
handle('protocol:start', async (event, input: ProtocolPayload) => {
  if (event.sender !== window?.webContents || workspaceSwitching)
    throw new Error('Protocol session unavailable.');
  if (!input || protocolSessions.has(input.sessionId))
    throw new Error('Invalid or duplicate session ID.');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 3600000)
    throw new Error('Timeout must be 100–3600000 ms.');
  if (protocolSessions.size >= 10)
    throw new Error('Disconnect a session before opening more than ten connections.');
  const entry: { owner: number; handle?: ProtocolSession; ended: boolean } = {
    owner: event.sender.id,
    ended: false,
  };
  const controller = new AbortController();
  const publish = (update: import('@techieutils/api-workbench-common/types').ProtocolEvent) => {
    if (entry.ended) return;
    if (!event.sender.isDestroyed()) event.sender.send('protocol:event', update);
    if (update.type === 'closed') {
      entry.ended = true;
      protocolSessions.delete(input.sessionId);
    }
  };
  const abort = (reason: string) => {
    controller.abort();
    publish({ sessionId: input.sessionId, type: 'closed', at: Date.now(), data: reason });
  };
  entry.handle = {
    send: () => {
      throw new Error('Wait for authentication to finish.');
    },
    finish: () => {
      throw new Error('Wait for authentication to finish.');
    },
    stop: () => abort('Disconnected'),
  };
  protocolSessions.set(input.sessionId, entry);
  const started = Date.now();
  const timer = setTimeout(() => abort('Authentication timed out'), input.timeoutMs);
  try {
    const authorized = await authorizeProtocol(
      input,
      { unlocked: vaultUnlocked, get: (id) => vault.get(id), resolve: resolveCredential },
      controller.signal,
    );
    if (entry.ended) return;
    const remaining = input.timeoutMs - (Date.now() - started);
    if (remaining < 100) {
      abort('Session timeout reached');
      return;
    }
    // gRPC targets are host:port; TLS ones are matched like HTTPS.
    const certificate = await requestCertificate(
      input.clientCertificate,
      input.protocol === 'grpc'
        ? `https://${input.url}`
        : input.protocol === 'mqtt'
          ? mqttOriginURL(input.url).toString()
          : input.url,
    );
    if (entry.ended) return;
    const handle = startProtocol({ ...authorized, timeoutMs: remaining }, publish, certificate);
    if (!entry.ended) entry.handle = handle;
  } catch (error) {
    if (!entry.ended) {
      protocolSessions.delete(input.sessionId);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
});
function ownedProtocol(owner: number, id: string): ProtocolSession {
  const entry = protocolSessions.get(id);
  if (!entry?.handle || entry.owner !== owner)
    throw new Error('This connection is no longer active.');
  return entry.handle;
}
handle(
  'protocol:send',
  (event, id: string, message: string, binary: boolean, options?: ProtocolSendOptions) =>
    // Each session checks the options against its own protocol.
    ownedProtocol(event.sender.id, id).send(message, binary === true, options),
);
handle('protocol:finish', (event, id: string) => ownedProtocol(event.sender.id, id).finish());
handle('protocol:stop', (event, id: string) => {
  if (protocolSessions.has(id)) ownedProtocol(event.sender.id, id).stop();
});
handle('protocol:inspect', (event, proto: string) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  return inspectProto(proto);
});
/** Questions the main process asks in a native dialog, which no page can answer (`confirmations.ts`). */
const confirmations = new Confirmations(async (question) => {
  if (!window || window.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: question.title,
    message: question.message,
    detail: question.detail,
    buttons: [question.confirm, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
});
/**
 * Registers a channel for the terminal window (`terminal-window.ts`): it answers only that
 * window's top frame, never the app's window, which shows content from anywhere.
 */
function handleTerminal(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each channel has its own arguments
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  // eslint-disable-next-line no-restricted-syntax -- the terminal window's handlers, checked as handle() checks the app's
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromAppWindow(event, terminalView?.webContents))
      throw new Error('This request is only accepted from the terminal.');
    return listener(event, ...args);
  });
}
// Shells run for the terminal window only; the app's window hears how many are running.
const terminals = new TerminalSessions((owner, event) => {
  const contents = webContents.fromId(owner);
  if (contents && !contents.isDestroyed()) contents.send('terminal:event', event);
  sendTerminalCount();
});
function sendTerminalCount(): void {
  if (window && !window.isDestroyed()) window.webContents.send('terminal:live', terminals.size);
}
/**
 * The terminal: its own page in a view (WebContentsView) that sits over the dev tools panel of
 * the app's window, where the app's window says, or in a window of its own once expanded. Either
 * way it is its own process with its own bridge (terminal-preload.ts) and session; the app's
 * window can place it, but never type into it.
 */
let terminalView: WebContentsView | undefined;
/** The window the terminal is expanded into, if it is. */
let terminalPopout: BaseWindow | undefined;
/** Where the app's window last asked for the docked terminal; hidden when undefined. */
let dockedAt: DockBounds | undefined;
/** Commands staged before the terminal was ready to show them. */
let stagedCommands: string[] = [];
const TERMINAL_PARTITION = 'terminal';
type Placement = 'panel' | 'window';
const placement = (): Placement => (terminalPopout ? 'window' : 'panel');
function announcePlacement(): void {
  if (window && !window.isDestroyed()) window.webContents.send('terminal:placement', placement());
  if (terminalView && !terminalView.webContents.isDestroyed())
    terminalView.webContents.send('terminal:placement', placement());
}
const terminalPreferencesPath = () => path.join(app.getPath('userData'), 'terminal.json');
async function readTerminalPreferences(): Promise<TerminalPreferences> {
  try {
    const saved = JSON.parse(await readFile(terminalPreferencesPath(), 'utf8')) as unknown;
    return terminalPreferences(
      saved,
      terminals.shells().map((shell) => shell.id),
    );
  } catch {
    return {};
  }
}
/** Shows the docked terminal where the app's window asked, or hides it. */
function placeDocked(): void {
  if (!terminalView || terminalPopout) return;
  if (dockedAt) terminalView.setBounds(dockedAt);
  terminalView.setVisible(Boolean(dockedAt));
}
/**
 * The terminal's view, made the first time it is shown. It needs no question: nothing in the
 * app's window can type into it, only place it or stage a command for the person to run.
 */
async function useTerminal(): Promise<WebContentsView> {
  if (terminalView && !terminalView.webContents.isDestroyed()) return terminalView;
  if (!window || window.isDestroyed()) throw new Error('Unavailable.');
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'terminal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Its own in-memory session: no storage shared with the app's window, which loads pages
      // from the same folder.
      partition: TERMINAL_PARTITION,
    },
  });
  view.setBackgroundColor(iconTheme === 'light' ? '#ffffff' : '#090f20');
  view.setVisible(false);
  terminalView = view;
  window.contentView.addChildView(view);
  const stopShells = () => void terminals.stopAll().finally(sendTerminalCount);
  view.webContents.on('did-start-loading', stopShells);
  view.webContents.on('render-process-gone', stopShells);
  view.webContents.on('destroyed', () => {
    if (terminalView === view) terminalView = undefined;
    stopShells();
  });
  await view.webContents.loadFile(
    path.join(__dirname, '../../api-workbench-app/dist/terminal.html'),
    { query: { theme: iconTheme, placement: placement() } },
  );
  placeDocked();
  return view;
}
/** Moves the terminal, shells and all, into a window of its own. */
async function expandTerminal(): Promise<void> {
  const view = await useTerminal();
  if (terminalPopout && !terminalPopout.isDestroyed()) {
    terminalPopout.show();
    terminalPopout.focus();
    return;
  }
  const popout = new BaseWindow({
    width: 960,
    height: 600,
    minWidth: 480,
    minHeight: 280,
    title: 'Terminal — API Workbench',
    backgroundColor: iconTheme === 'light' ? '#ffffff' : '#090f20',
  });
  terminalPopout = popout;
  window?.contentView.removeChildView(view);
  popout.contentView.addChildView(view);
  const fill = () => {
    const { width, height } = popout.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fill();
  view.setVisible(true);
  popout.on('resize', fill);
  // Closing the window puts the terminal back in the panel, still running.
  popout.on('close', () => {
    popout.contentView.removeChildView(view);
    terminalPopout = undefined;
    if (window && !window.isDestroyed() && !view.webContents.isDestroyed()) {
      window.contentView.addChildView(view);
      placeDocked();
    }
    announcePlacement();
  });
  announcePlacement();
  view.webContents.focus();
}
function returnTerminal(): void {
  if (terminalPopout && !terminalPopout.isDestroyed()) terminalPopout.close();
}
// The app's window: start the terminal, place it in the dev tools panel, expand it into a window
// of its own and back, or stage a command at a new terminal's prompt.
handle('terminal:open', async (event) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  await useTerminal();
  return placement();
});
handle('terminal:dock', (event, bounds: unknown) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  // The page measures in CSS pixels; a zoomed page's are larger than the window's.
  const zoom = window.webContents.getZoomFactor();
  const scaled =
    bounds && typeof bounds === 'object'
      ? Object.fromEntries(
          Object.entries(bounds as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === 'number' ? value * zoom : value,
          ]),
        )
      : bounds;
  dockedAt = dockBounds(scaled, window.getContentBounds());
  placeDocked();
});
handle('terminal:focus', (event) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  if (terminalPopout) terminalPopout.focus();
  else if (dockedAt) terminalView?.webContents.focus();
});
handle('terminal:expand', async (event) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  await expandTerminal();
});
handle('terminal:return', (event) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  returnTerminal();
});
handle('terminal:type', async (event, text: unknown) => {
  if (event.sender !== window?.webContents) throw new Error('Unavailable.');
  const command = stagedCommand(text);
  if (!command) return;
  stagedCommands.push(command);
  const view = await useTerminal();
  // Docked, the app's window shows its Terminal tab so the panel gives the terminal room.
  if (terminalPopout) terminalPopout.focus();
  else window?.webContents.send('terminal:reveal');
  view.webContents.send('terminal:staged');
});
// The terminal window: its shells, its saved default shell, and the commands staged for it.
handleTerminal(
  'terminal:start',
  (event, size: { cols?: unknown; rows?: unknown }, shell?: unknown) =>
    terminals.start(event.sender.id, size, shell),
);
handleTerminal('terminal:shells', () => terminals.shells());
handleTerminal('terminal:write', (event, id: unknown, data: unknown) =>
  terminals.write(event.sender.id, id, data),
);
handleTerminal('terminal:resize', (event, id: unknown, cols: unknown, rows: unknown) =>
  terminals.resize(event.sender.id, id, cols, rows),
);
handleTerminal('terminal:stop', (event, id: unknown) => terminals.stop(event.sender.id, id));
handleTerminal('terminal:preferences', () => readTerminalPreferences());
handleTerminal('terminal:set-default-shell', async (_event, shell: unknown) => {
  const preferences = terminalPreferences(
    { defaultShell: shell },
    terminals.shells().map((item) => item.id),
  );
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(terminalPreferencesPath(), JSON.stringify(preferences), { mode: 0o600 });
});
// The terminal's own toolbar buttons, on channels of their own: one channel has one handler.
handleTerminal('terminal:expand-self', () => expandTerminal());
handleTerminal('terminal:return-self', () => returnTerminal());
handleTerminal('terminal:take-staged', () => {
  const taken = stagedCommands;
  stagedCommands = [];
  return taken;
});
// Quitting waits for every shell to exit; node-pty aborts the app if one exits during shutdown.
let terminalsStopped = false;
app.on('before-quit', (event) => {
  if (terminalsStopped || !terminals.size) return;
  event.preventDefault();
  void terminals.stopAll().finally(() => {
    terminalsStopped = true;
    app.quit();
  });
});
function createWindow(): void {
  window = new BrowserWindow({
    show: false,
    width: 1510,
    height: 980,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: '#090f20',
    title: 'API Workbench',
    icon: path.join(
      iconDirectory(),
      iconTheme,
      process.platform === 'darwin'
        ? 'icon-mac.png'
        : process.platform === 'win32'
          ? 'icon.ico'
          : 'icon.png',
    ),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const created = window;
  // Shells belong to the terminal window, so reloading this one leaves them running.
  const stopSessions = () => stopProtocolSessions();
  created.webContents.on('did-start-loading', stopSessions);
  created.webContents.on('render-process-gone', stopSessions);
  created.once('ready-to-show', () => {
    if (!created.isDestroyed()) created.show();
  });
  void window.loadFile(path.join(__dirname, '../../api-workbench-app/dist/index.html'));
  // Pop-ups, navigation, and <webview> are refused for every web content; see guardWebContents.
  created.on('close', (event) => {
    if (!created.webContents.isDestroyed() && closeGuard.onClose()) event.preventDefault();
  });
  window.on('closed', () => {
    // The terminal belongs to the app: it closes with the app's window.
    if (terminalPopout && !terminalPopout.isDestroyed()) terminalPopout.destroy();
    if (terminalView && !terminalView.webContents.isDestroyed()) terminalView.webContents.close();
    closeGuard.reset();
    stopProtocolSessions();
    void terminals.stopAll();
    window = null;
    vaultUnlocked = false;
    oauthController?.abort();
    for (const controller of active.values()) controller.abort();
  });
}
/** Unsaved changes when the window closes: saved first, or asked about when auto save is off. */
const closeGuard = new CloseGuard({
  ask: () =>
    window && !window.isDestroyed()
      ? dialog.showMessageBoxSync(window, {
          type: 'warning',
          buttons: ['Save', 'Don’t save', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          message: 'Save your changes before closing?',
          detail: 'Auto save is off for this workspace, and it has changes that are not saved.',
        })
      : 1,
  requestSave: () => window?.webContents.send('app:save-before-close'),
  close: () => {
    if (window && !window.isDestroyed()) window.close();
  },
  quit: () => app.quit(),
});
app.on('before-quit', () => closeGuard.quitRequested());
/**
 * One instance per data folder. A second launch — or an `apiworkbench://` link, which Windows and
 * Linux open by starting the app again — brings this window forward instead, so two copies never
 * write the same workspace files.
 */
const primaryInstance = app.requestSingleInstanceLock();
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
if (!primaryInstance) app.quit();
/** Shows the window: restored if minimized, created again on macOS after it was closed. */
function showWindow(): void {
  if (!app.isReady()) return; // The window is created once the app is ready.
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', showWindow);
// macOS delivers a clicked link to the running app.
app.on('open-url', (event) => {
  event.preventDefault();
  showWindow();
});
/** Registers the link scheme on Windows; macOS and Linux packages register it when installed. */
function registerLinkScheme(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const executable = protocolExecutable(process.env, process.execPath);
  if (!app.isDefaultProtocolClient(URL_SCHEME, executable))
    app.setAsDefaultProtocolClient(URL_SCHEME, executable);
}
// Every web content the app creates — the window, its frames, anything later — refuses pop-ups,
// navigation, and <webview>.
app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  // Electron grants every permission by default; the interface only needs the clipboard.
  restrictPermissions(session.defaultSession, (contents) => contents === window?.webContents);
  // The terminal window's own session: the clipboard, for copy and paste, and nothing else.
  restrictPermissions(
    session.fromPartition(TERMINAL_PARTITION),
    (contents) => contents === terminalView?.webContents,
  );
  registerLinkScheme();
  workspaceStore = new WorkspaceStore(app.getPath('userData'));
  try {
    await workspaceStore.list();
  } catch {
    /* The renderer reports storage errors and preserves existing data. */
  }
  initializeVault(workspaceStore.activeId);
  // Workspace and collection files edited outside the app (an editor, git) reload in the window.
  workspaceStore.onWorkspaceChange((change) =>
    window?.webContents.send('workspace:changed', change),
  );
  workspaceStore.onIndexChange((change) => window?.webContents.send('workspaces:changed', change));
  void syncPresence();
  startUpdates();
  createWindow();
  app.on('activate', () => {
    if (!window) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  // The vault's key leaves memory with the app.
  workbenchVaultInstance?.lock();
  try {
    presence.stopNow();
  } catch {
    /* The team folder is unavailable; the file goes stale and teammates stop seeing you. */
  }
  stopProtocolSessions();
  workspaceStore?.close();
  oauthController?.abort();
  void interceptor?.stop();
  void mockServers.stopAll();
  scriptHost.dispose();
});
/** The certificate the local CA issued for HTTPS mocks, reused until the CA changes. */
let issuedMockCertificate: MockCertificate | undefined;
/**
 * The certificate an HTTPS mock serves with: the person's own files, or one the local CA issues
 * for localhost, which browsers accept once the CA is trusted (as for the Interceptor).
 */
async function mockCertificate(mock: MockServer): Promise<MockCertificate> {
  const { certFile, keyFile } = mock.https ?? {};
  if (certFile && keyFile)
    try {
      return { cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8') };
    } catch (error) {
      throw new Error(`Could not read the certificate files: ${(error as Error).message}`, {
        cause: error,
      });
    }
  const store = useAuthorities();
  const authority = await store.load();
  if (!authority)
    throw new Error(
      `${(await store.unavailable()) ?? 'The API Workbench CA is unavailable.'} Choose your own certificate and key files for HTTPS instead.`,
    );
  issuedMockCertificate ??= issueCertificate(authority, ['localhost', '127.0.0.1', '::1']);
  return issuedMockCertificate;
}
/** Local mock servers; what they answer goes to the window that is open. */
const mockServers = new MockServers((entry) => {
  if (window && !window.webContents.isDestroyed()) window.webContents.send('mock:log', entry);
}, mockCertificate);
function fromMockWindow(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== window?.webContents) throw new Error('Mock servers unavailable.');
}
handle('mock:status', (event) => {
  fromMockWindow(event);
  return mockServers.status();
});
handle('mock:start', (event, mock: unknown) => {
  fromMockWindow(event);
  return mockServers.start(mock);
});
handle('mock:stop', (event, id: unknown) => {
  fromMockWindow(event);
  return mockServers.stop(id);
});
let authorities: AuthorityStore | undefined;
/** API Workbench's local CA, shared by the Interceptor and HTTPS mock servers. */
function useAuthorities(): AuthorityStore {
  authorities ??= new AuthorityStore(
    path.join(app.getPath('userData'), 'interceptor'),
    secretStorage,
  );
  return authorities;
}
let interceptor: Interceptor | undefined;
/** The capture proxy, created on first use; captures go to the window that is open. */
function useInterceptor(): Interceptor {
  interceptor ??= new Interceptor({
    authorities: useAuthorities(),
    publish: (capture) => {
      if (window && !window.webContents.isDestroyed())
        window.webContents.send('interceptor:capture', capture);
    },
  });
  return interceptor;
}
function fromWindow(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== window?.webContents) throw new Error('Interceptor unavailable.');
}
handle('interceptor:status', (event) => {
  fromWindow(event);
  return useInterceptor().status();
});
handle(
  'interceptor:start',
  async (event, options: { port?: unknown; decryptHttps?: unknown; domains?: unknown }) => {
    fromWindow(event);
    const decryptHttps = options?.decryptHttps === true;
    const given = options?.domains ?? [];
    if (
      !Array.isArray(given) ||
      given.length > 100 ||
      !given.every((item) => typeof item === 'string')
    )
      throw new Error('Domains to decrypt are a list of up to 100 domain names.');
    const domains = normalizeDomains(given as string[]);
    // Decrypting needs a CA, and a CA limited to the sites under test is all it should need:
    // one that can vouch for any site is never made (`nameConstraints` in interceptor-ca.ts).
    if (decryptHttps && !domains.length)
      throw new Error(
        'List the domains to decrypt, such as example.com: the Interceptor’s certificate vouches only for them.',
      );
    if (decryptHttps) {
      const allowed = await confirmations.allow('decrypt-https', {
        title: 'Decrypt HTTPS',
        message: 'Let the Interceptor decrypt HTTPS traffic?',
        detail:
          'Apps that send traffic through it and trust its certificate have their HTTPS requests and responses read and shown here, including passwords and tokens. API Workbench asks once each time it starts.',
        confirm: 'Decrypt HTTPS',
      });
      if (!allowed) throw new Error('HTTPS decryption was not started.');
      // A ten-year CA from an older version, or one limited to other domains, is replaced, and
      // stops being trusted first if this app trusted it.
      const current = await useAuthorities().existing();
      if (current && (isLongLived(current.certPem) || !sameDomains(current.domains, domains)))
        await replaceAuthority(domains);
    }
    return useInterceptor().start(Number(options?.port), decryptHttps, domains);
  },
);
handle('interceptor:stop', (event) => {
  fromWindow(event);
  return useInterceptor().stop();
});
handle('interceptor:recording', (event, recording: unknown) => {
  fromWindow(event);
  return useInterceptor().setRecording(recording === true);
});
/** The CAs this app added to the system's trusted certificates. */
const trustedAuthorities = () =>
  new TrustedAuthorities(path.join(app.getPath('userData'), 'interceptor', 'trusted.json'));
const loginKeychain = () => path.join(app.getPath('home'), 'Library/Keychains/login.keychain-db');
/** Runs fixed trust-store commands in order, without a shell; the first failure stops them. */
async function runTrustCommands(commands: TrustCommand[]): Promise<void> {
  for (const { command, args } of commands)
    await new Promise<void>((resolve, reject) =>
      execFile(command, args, { timeout: 120_000 }, (error, _stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
      ),
    );
}
/**
 * A new CA in place of the current one. The old CA stops being trusted before it is replaced, if
 * this app trusted it: otherwise its key, were it ever copied, could still be used to read this
 * computer's HTTPS traffic. If the person declines, nothing is replaced.
 */
async function replaceAuthority(domains?: readonly string[]) {
  const old = (await useInterceptor().status()).authority;
  if (old) {
    const pem = await readFile(old.path, 'utf8');
    const trusted = trustedAuthorities();
    const commands = untrustCommands(process.platform, old.path, pem, loginKeychain());
    if (commands && (await trusted.has(pem))) {
      try {
        await runTrustCommands(commands);
      } catch (error) {
        throw new Error(
          `The current certificate is still trusted, so it was not replaced: ${(error as Error).message}`,
          { cause: error },
        );
      }
      await trusted.remove(pem);
    }
  }
  // A new CA: HTTPS mocks get a certificate from it the next time they start.
  issuedMockCertificate = undefined;
  return useInterceptor().resetAuthority(domains);
}
handle('interceptor:resetAuthority', async (event) => {
  fromWindow(event);
  return replaceAuthority();
});
handle('interceptor:exportAuthority', async (event) => {
  fromWindow(event);
  const status = await useInterceptor().status();
  if (!status.authority)
    throw new Error(
      status.authorityError ||
        'Start the Interceptor with HTTPS decryption on to create its certificate.',
    );
  const result = await dialog.showSaveDialog(window!, {
    title: 'Save Interceptor CA certificate',
    defaultPath: path.basename(status.authority.path),
    filters: [{ name: 'Certificate', extensions: ['crt', 'pem'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await copyFile(status.authority.path, result.filePath);
  return true;
});
/** Adds the CA to the current user's trusted roots; the operating system asks the user to confirm. */
handle('interceptor:trustAuthority', async (event) => {
  fromWindow(event);
  const status = await useInterceptor().status();
  if (!status.authority)
    throw new Error(
      status.authorityError ||
        'Start the Interceptor with HTTPS decryption on to create its certificate.',
    );
  const commands = trustCommands(process.platform, status.authority.path, loginKeychain());
  if (!commands)
    throw new Error(
      "Linux has no single trust store. Save the certificate and add it to your browser, or to the system with your distribution's tool, such as update-ca-certificates.",
    );
  const pem = await readFile(status.authority.path, 'utf8');
  const expires = new Date(new X509Certificate(pem).validTo).toLocaleDateString();
  const limited = status.authority.domains;
  const reach = limited.length
    ? `certificates it signs for ${limited.join(', ')} (and their subdomains) and this computer, and for no other site`
    : 'certificates it signs for any website';
  const limit = limited.length
    ? ''
    : ' Set “Domains to decrypt” to limit it to the sites you test.';
  const allowed = await confirmations.allow(
    'trust-authority',
    {
      title: 'Trust certificate',
      message: 'Trust the Interceptor’s certificate?',
      detail: `Until it expires on ${expires}, apps and browsers on this computer accept ${reach}, so the Interceptor can read their HTTPS traffic.${limit} API Workbench makes a new one before then, which you trust again; “New certificate” removes this one’s trust.`,
      confirm: 'Trust Certificate',
    },
    true,
  );
  if (!allowed) throw new Error('The certificate was not trusted.');
  await runTrustCommands(commands);
  // Remembered, so replacing this CA later also removes it from the trusted certificates.
  await trustedAuthorities().add(pem);
});
/**
 * Why this installation cannot update itself, if it cannot: a build run from source, or a Linux
 * archive (.tar.gz), which has neither an AppImage to replace nor a package manager to ask.
 */
function updatesUnsupported(): string | undefined {
  if (!app.isPackaged)
    return 'Updates are installed by released builds; this one was run from source.';
  if (
    process.platform === 'linux' &&
    !process.env.APPIMAGE &&
    !existsSync(path.join(process.resourcesPath, 'package-type'))
  )
    return 'This Linux archive cannot update itself. Download new versions from GitHub Releases, or install the AppImage, .deb, or .rpm.';
  // The installer leaves an uninstaller beside the app. The portable .zip has none, and the
  // portable .exe runs from a temporary folder (its launcher sets PORTABLE_EXECUTABLE_FILE).
  if (
    process.platform === 'win32' &&
    (Boolean(process.env.PORTABLE_EXECUTABLE_FILE) ||
      !existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)))
  )
    return 'The portable Windows build cannot update itself. Download new versions from GitHub Releases, or use the installer.';
  return undefined;
}
/** The app's version; run from source, Electron reports its own, so read the repository's. */
function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
}
let updates: UpdateService | undefined;
/** Checks GitHub releases for new versions, as the person chose in Settings → Updates. */
function startUpdates(): void {
  const unsupported = updatesUnsupported();
  // electron-updater reads the packaged app's update configuration, so it loads only when used.
  const updater: Updater = unsupported
    ? {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: false,
        on: () => undefined,
        checkForUpdates: async () => undefined,
        downloadUpdate: async () => undefined,
        quitAndInstall: () => undefined,
      }
    : // eslint-disable-next-line @typescript-eslint/no-require-imports -- Loaded only in packaged builds.
      (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
  updates = new UpdateService({
    updater,
    file: path.join(app.getPath('userData'), 'updates.json'),
    currentVersion: appVersion(),
    unsupported,
    publish: (info) => window?.webContents.send('updates:changed', info),
  });
  void updates.start();
}
const updateOwner = (event: Electron.IpcMainInvokeEvent) => {
  if (event.sender !== window?.webContents || !updates) throw new Error('Updates unavailable.');
  return updates;
};
handle('updates:info', (event) => updateOwner(event).info());
handle('updates:preferences', (event, preferences: unknown) =>
  updateOwner(event).setPreferences(preferences),
);
handle('updates:check', (event) => updateOwner(event).check());
handle('updates:download', (event) => updateOwner(event).download());
handle('updates:install', (event) => updateOwner(event).install());
/**
 * Restarts API Workbench, e.g. after the system keychain was unlocked so OS encryption can be
 * detected again. The renderer saves the workspace before asking; quitting runs the usual cleanup.
 */
handle('app:restart', (event) => {
  if (event.sender !== window?.webContents) return;
  app.relaunch();
  app.quit();
});
handle('runner:resources', () => {
  const metrics = app.getAppMetrics();
  return {
    timestampMs: performance.now(),
    cpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
    memoryBytes: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0),
    processCount: metrics.length,
  };
});
// Request scripts run in QuickJS in a utility process: its own OS process, with nothing of the
// app's but the script and its data. Which scripts may run is kept in the app's data folder.
const scriptTrust = new ScriptTrust(path.join(app.getPath('userData'), 'script-trust.json'));
const scriptHost = new ScriptHost((): ScriptProcess => {
  const child = utilityProcess.fork(path.join(__dirname, 'script-worker.js'), [], {
    serviceName: 'API Workbench scripts',
    stdio: 'ignore',
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', listener),
    kill: () => child.kill(),
  };
}, scriptTrust);
/** A list of script texts from the window, checked before the trust list reads it. */
function scriptSources(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 10_000 ||
    value.some((item) => typeof item !== 'string' || item.length > 256 * 1024)
  )
    throw new Error('Scripts must be a list of text.');
  return value as string[];
}
handle('scripts:run', (_, input: unknown) => scriptHost.run(input));
handle('scripts:trusted', (_, sources: unknown) => scriptTrust.trustedList(scriptSources(sources)));
handle('scripts:allow', (_, sources: unknown) => scriptTrust.allow(scriptSources(sources)));
handle('scripts:edited', (_, previous: unknown, next: unknown) => {
  const [before, after] = scriptSources([previous, next]);
  return scriptTrust.edited(before, after);
});
handle('codegen:targets', (_, protocol?: unknown) =>
  isLiveProtocol(protocol) ? liveTargets(protocol) : codegenTargets(),
);
handle(
  'codegen:generate',
  (
    _,
    input: import('@techieutils/api-workbench-common/types').CodegenInput,
    target: string,
    client: string,
  ) =>
    input?.protocol !== undefined
      ? generateLiveCode(input, target, client)
      : generateCode(input, target, client),
);
// A collection behind a link; the files are parsed in the app like chosen files.
handle('import:link', (_, url: unknown) => importLink(url));
handle('import:parse', (_, text: unknown) => {
  if (typeof text !== 'string' || text.length > 10_000_000)
    throw new Error('Choose a specification smaller than 10 MB.');
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(document.errors[0].message);
  return document.toJS({ maxAliasCount: 100 });
});
handle('state:load', (_, id?: string) => workspaceStore.load(id || workspaceStore.activeId));
handle('state:save', (_, state: WorkspaceState, id?: string) =>
  workspaceStore.save(state, id || workspaceStore.activeId),
);
handle('workspaces:list', () => workspaceStore.list());
handle('workspaces:create', async (event, name: string, state: WorkspaceState, where: unknown) => {
  if (where === 'choose') {
    const folder = await chooseWorkspaceFolder(
      event,
      'Choose where to save the workspace',
      (await workspaceStore.storage()).storageFolder,
    );
    return folder ? workspaceStore.create(name, state, folder) : null;
  }
  return workspaceStore.create(name, state, where === 'app-data' ? null : undefined);
});
handle('workspaces:storage', () => workspaceStore.storage());
handle('workspaces:choose-storage-folder', async (event) => {
  const current = await workspaceStore.storage();
  const folder = await chooseWorkspaceFolder(
    event,
    'Choose where new workspaces are saved',
    current.storageFolder ?? app.getPath('documents'),
  );
  return folder ? workspaceStore.setStorageFolder(folder) : current;
});
handle('workspaces:reset-storage-folder', () => workspaceStore.setStorageFolder(undefined));
handle('app:unsaved', (_, changes: unknown, ask: unknown) => closeGuard.report(changes, ask));
// A failed save keeps the window open, so nothing is lost without the person knowing.
handle('app:close-ready', (_, saved: unknown) => closeGuard.ready(saved));
/** The system folder picker, for where workspaces are saved; undefined when cancelled. */
async function chooseWorkspaceFolder(
  event: Electron.IpcMainInvokeEvent,
  title: string,
  defaultPath?: string,
): Promise<string | undefined> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title,
    buttonLabel: 'Save here',
    properties: ['openDirectory', 'createDirectory'],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}
handle('workspaces:rename', (_, id: string, name: string) => workspaceStore.rename(id, name));
handle('workspaces:delete', (_, id: string) => workspaceStore.delete(id));
handle('workspace:change-applied', (event, sequence: unknown) => {
  if (event.sender === window?.webContents && typeof sequence === 'number')
    workspaceStore.workspaceChangeApplied(sequence);
});
// Shows a collection's or folder's directory in the file manager (a folder path from the
// renderer, looked up among the saved directories, never used as a path itself).
handle('workspaces:reveal', async (event, folder: unknown) => {
  if (event.sender !== window?.webContents) return;
  const target = await workspaceStore.revealPath(typeof folder === 'string' ? folder : undefined);
  try {
    await access(target);
    shell.showItemInFolder(target);
  } catch {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const error = await shell.openPath(path.dirname(target));
    if (error) throw new Error(error);
  }
});
// Team workspaces: who else has the open one, written to and read from its shared folder.
const presence = new TeamPresenceService((change) => {
  if (window && !window.isDestroyed()) window.webContents.send('team:presence', change);
});
/** Shows you in the active team workspace, or stops when the active workspace is not one. */
async function syncPresence(): Promise<void> {
  const team = workspaceStore.activeTeam();
  if (!team) await presence.stop();
  else if (presence.active !== team.id) await presence.start(team.id, team.folder, team.member);
}
/** Asks where a team folder is; the path comes from the system dialog, never from the renderer. */
async function chooseTeamFolder(title: string, buttonLabel: string): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(window!, {
    title,
    buttonLabel,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}
handle('workspaces:open-folder', async (_, initial: WorkspaceState, memberName: unknown) => {
  const folder = await chooseTeamFolder('Open a team folder', 'Open team folder');
  if (!folder) return null;
  return workspaceStore.openFolder(folder, initial, String(memberName ?? ''), 'open');
});
handle('workspaces:share-folder', async (_, state: WorkspaceState, memberName: unknown) => {
  const folder = await chooseTeamFolder('Share this workspace in a folder', 'Share here');
  if (!folder) return null;
  return workspaceStore.openFolder(
    folder,
    state,
    String(memberName ?? ''),
    'share',
    workspaceStore.activeId,
  );
});
handle('team:member', () => workspaceStore.member());
handle('team:set-member', async (_, name: unknown) => {
  const member = await workspaceStore.setMemberName(name);
  await presence.update(undefined, undefined, member);
  return member;
});
handle('team:set-presence', async (_, requestId: unknown, requestName: unknown) => {
  const text = (value: unknown) =>
    typeof value === 'string' && value.length <= 200 ? value : undefined;
  await presence.update(text(requestId), text(requestName));
});
// Git sync for the active team workspace. The folder is the workspace's own, never a path from
// the renderer; git runs with fixed arguments and signs in with this computer's git setup.
const teamGit = new TeamGit();
let gitOperations = 0;
async function withTeamGit<T>(
  operation: (team: NonNullable<ReturnType<WorkspaceStore['activeTeam']>>) => Promise<T>,
  reload = false,
): Promise<T> {
  if (workspaceSwitching) throw new Error('Wait for workspace switching to finish.');
  const team = workspaceStore.activeTeam();
  if (!team) throw new Error('Open a team workspace first.');
  gitOperations++;
  try {
    return await operation(team);
  } finally {
    gitOperations--;
    // Pulled files reach the app the way teammates' saves do.
    if (reload) await workspaceStore.checkNow().catch(() => {});
  }
}
handle('git:status', () => {
  const team = workspaceStore.activeTeam();
  return team ? teamGit.status(team.folder) : null;
});
handle('git:connect', (_, url: unknown) =>
  withTeamGit((team) => teamGit.connect(team.folder, url, team.member), true),
);
handle('git:commit', (_, message: unknown) =>
  withTeamGit((team) => teamGit.commit(team.folder, message, team.member)),
);
handle('git:pull', (_, choice: unknown) =>
  withTeamGit((team) => teamGit.pull(team.folder, team.member, choice), true),
);
handle('git:push', () => withTeamGit((team) => teamGit.push(team.folder)));
handle('git:sync', (_, message: unknown, choice: unknown) =>
  withTeamGit((team) => teamGit.sync(team.folder, message, team.member, choice), true),
);
/**
 * Clones a repository into a folder chosen in the system dialog and opens the team workspace in
 * it. A clone with no team workspace gets this one, shared into it (into `api-workbench/` when the
 * repository already has other files), ready to commit and push.
 */
handle(
  'workspaces:clone-git',
  async (_, url: unknown, state: WorkspaceState, memberName: unknown) => {
    const remote = typeof url === 'string' ? url.trim() : '';
    const problem = gitRemoteProblem(remote);
    if (problem) throw new Error(problem);
    const parent = await chooseTeamFolder('Choose where to put the clone', 'Clone here');
    if (!parent) return null;
    gitOperations++;
    try {
      const folder = await teamGit.clone(remote, parent, repositoryName(remote));
      const found = await findTeamFolders(folder);
      const member = String(memberName ?? '');
      if (found.length > 1)
        throw new Error(
          `Cloned to ${folder}. It holds several team workspaces (${found
            .map((item) => path.relative(folder, item) || '.')
            .join(', ')}); use Open team folder to choose one.`,
        );
      if (found.length === 1)
        return {
          workspace: await workspaceStore.openFolder(found[0], state, member, 'open'),
          shared: false,
        };
      const others = (await readdir(folder)).filter((name) => name !== '.git');
      // Named after the repository, so it is not mistaken for the workspace it was copied from.
      const shared = {
        ...state,
        settings: { ...state?.settings, workspaceName: repositoryName(remote) },
      } as WorkspaceState;
      return {
        workspace: await workspaceStore.openFolder(
          others.length ? path.join(folder, 'api-workbench') : folder,
          shared,
          member,
          'share',
          workspaceStore.activeId,
        ),
        shared: true,
      };
    } finally {
      gitOperations--;
    }
  },
);
handle('workspaces:switch', async (_, id: string) => {
  if (
    workspaceSwitching ||
    active.size ||
    protocolSessions.size ||
    oauthController ||
    vaultOperations ||
    gitOperations
  )
    throw new Error(
      'Finish active requests, Git sync, and credential operations before switching workspaces.',
    );
  workspaceSwitching = true;
  try {
    const state = await workspaceStore.activate(id);
    initializeVault(id);
    await syncPresence();
    return state;
  } finally {
    workspaceSwitching = false;
  }
});
handle('credentials:status', () => vault.status());
// The API Workbench vault. Each change answers with the vault's status; passwords and the recovery
// key are checked and used here, and never sent back.
async function workbenchOnly(): Promise<WorkbenchVault> {
  if (await osEncryptionUsable())
    throw new Error(`Secrets are kept in ${osBackend()}; the API Workbench vault is not needed.`);
  return workbenchVault();
}
// Once the chosen vault opens, credentials still in the system's store move into it.
const afterOpening = async () => {
  if (chosenWorkbench()) await moveCredentials(true);
  return vault.status();
};
handle('vault:setup', async (_, password: unknown) => {
  await (await workbenchOnly()).setup(password);
  return afterOpening();
});
handle('vault:unlock', async (_, password: unknown) => {
  await (await workbenchOnly()).unlock(password);
  return afterOpening();
});
handle('vault:recover', async (_, recoveryKey: unknown, password: unknown) => {
  await (await workbenchOnly()).recover(recoveryKey, password);
  return afterOpening();
});
/**
 * Chooses the API Workbench vault over the system's store, or goes back. Choosing it takes effect
 * at once: the vault is set up or unlocked as usual, and credentials move into it when it opens.
 * Going back moves them to the system's store first, so the vault must be open.
 */
handle('vault:use-workbench', async (_, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('Choose on or off.');
  if (!(await osStoreAvailable()))
    throw new Error('This computer has no system credential store, so the vault is always used.');
  if (enabled === chosenWorkbench()) return vault.status();
  if (enabled) {
    await writeBackendChoice(backendFile(), 'workbench');
    workbenchChosen = true;
    vaultUnlocked = false;
    await moveCredentials(true);
    return vault.status();
  }
  const keeper = workbenchVault();
  if ((await keeper.state()).setUp && !keeper.unlocked)
    throw new Error(
      'Unlock the API Workbench vault first, so its credentials can move to the system store.',
    );
  await moveCredentials(false);
  await writeBackendChoice(backendFile(), 'system');
  workbenchChosen = false;
  keeper.lock();
  vaultUnlocked = false;
  return vault.status();
});
handle('vault:change-password', async (_, current: unknown, next: unknown) => {
  await (await workbenchOnly()).changePassword(current, next);
  return vault.status();
});
handle('vault:lock', async () => {
  workbenchVault().lock();
  vaultUnlocked = false;
  return vault.status();
});
/**
 * Forgets the API Workbench vault. What it encrypted can no longer be read, so those files go
 * too: each workspace's credentials and the Interceptor CA's key, if the vault encrypted them.
 */
handle('vault:reset', async () => {
  const keeper = await workbenchOnly();
  const index = await workspaceStore.list();
  const files = [...index.workspaces.map((item) => workspaceStore.vaultPath(item.id))];
  for (const file of files) {
    const data = await readFile(file).catch(() => undefined);
    if (data && isWorkbenchVaultData(data)) await rm(file, { force: true });
  }
  const authorityFile = path.join(app.getPath('userData'), 'interceptor', 'authority.json');
  try {
    const saved = JSON.parse(await readFile(authorityFile, 'utf8')) as { key?: string };
    if (saved.key && isWorkbenchVaultData(Buffer.from(saved.key, 'base64')))
      await rm(authorityFile, { force: true });
  } catch {
    /* No CA yet. */
  }
  authorities = undefined;
  await keeper.reset();
  vaultUnlocked = false;
  return vault.status();
});
const RECOVERY_NOTE = (key: string) =>
  `API Workbench vault recovery key\n\n${key}\n\nKeep this somewhere safe, such as a password manager. With it you can set a new vault password if you forget yours. Anyone with this key and your vault files can read your saved credentials.\n`;
handle('vault:save-recovery', async (event) => {
  const key = workbenchVault().pendingRecoveryKey();
  if (!key) throw new Error('The recovery key has already been put away.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Save your recovery key',
    defaultPath: path.join(app.getPath('documents'), 'api-workbench-recovery-key.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  };
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, RECOVERY_NOTE(key), { mode: 0o600 });
  return true;
});
handle('vault:copy-recovery', async () => {
  const key = workbenchVault().pendingRecoveryKey();
  if (!key) throw new Error('The recovery key has already been put away.');
  clipboard.writeText(key);
  // Cleared after a minute, unless something else has been copied since.
  setTimeout(() => {
    void Promise.resolve(clipboard.readText()).then((text) => {
      if (text === key) clipboard.clear();
    });
  }, 60_000).unref();
});
handle('vault:finish-setup', async () => workbenchVault().finishSetup());
handle('credentials:list', () =>
  withVault(async () => {
    vaultUnlocked = false;
    const credentials = await vault.list();
    vaultUnlocked = true;
    return credentials;
  }),
);
handle('credentials:test', (_, id: string) =>
  withVault(async () => {
    if (!vaultUnlocked) throw new Error(vaultLocked('test its access'));
    const record = await vault.get(id);
    if (!record.external) throw new Error('Choose an external credential profile.');
    await resolveExternalSecret(record);
    return { checkedAt: new Date().toISOString() };
  }),
);
handle('credentials:save', (_, input: CredentialInput) => {
  if (oauthController)
    throw new Error('Cancel the active OAuth operation before editing a credential.');
  return withVault(async () => vault.save(await certificateCredential(input)));
});
// Publishing an export as a gist: the token is read from the vault here and sent only to GitHub.
handle('gist:publish', (_, input: unknown) =>
  withVault(async () => {
    if (!vaultUnlocked) throw new Error(vaultLocked('publish to GitHub with a saved token'));
    const checked = checkedGistInput(input);
    const record = await resolveCredential(await vault.get(checked.credentialId));
    return publishGist(checked, record);
  }),
);
/** Moves a client certificate saved in workspace settings (by file path) into the vault. */
handle('credentials:importCertificate', (_, entry: unknown, name: unknown) =>
  withVault(async () => {
    if (!vaultUnlocked) throw new Error(vaultLocked('move client certificates into it'));
    const [certificate] = sanitizeClientCertificates([entry]);
    if (!certificate || certificate.credentialId)
      throw new Error('Choose a certificate saved in workspace settings.');
    const files = await revealPassphrase(
      checkedCertificatePayload(certificate) as FileCertificatePayload,
    );
    return vault.save(
      await certificateCredential({
        name:
          typeof name === 'string' && name.trim()
            ? name.trim().slice(0, 100)
            : `Client certificate · ${certificate.host}`,
        kind: 'client-certificate',
        allowedOrigin: '',
        clientCertificate: {
          type: certificate.type,
          host: certificate.host,
          ...(certificate.port ? { port: certificate.port } : {}),
        },
        certificateFiles: {
          certPath: files.certPath,
          keyPath: files.keyPath,
          pfxPath: files.pfxPath,
        },
        extraSecret: files.passphrase,
      }),
    );
  }),
);
handle('credentials:delete', (_, id: string) => {
  if (oauthController)
    throw new Error('Cancel the active OAuth operation before deleting a credential.');
  return withVault(() => vault.delete(id));
});
handle('oauth:cancel', () => oauthController?.abort());
handle('oauth:disconnect', (_, id: string) => {
  if (oauthController) throw new Error('Cancel the active OAuth operation first.');
  return withVault(() => vault.setTokens(id, undefined));
});
async function oauthOperation(id: string, refresh: boolean) {
  if (workspaceSwitching) throw new Error('Wait for workspace switching to finish.');
  if (oauthController) throw new Error('Another OAuth operation is active. Cancel it first.');
  const controller = new AbortController();
  oauthController = controller;
  try {
    if (!vaultUnlocked) throw new Error(vaultLocked('connect this OAuth profile'));
    const saved = await vault.get(id);
    if (saved.kind !== 'oauth2') throw new Error('Choose an OAuth 2.0 credential.');
    const record = await resolveCredential(saved, controller.signal);
    if (record.kind !== 'oauth2' || !record.oauth)
      throw new Error('Choose an OAuth 2.0 credential.');
    let tokens;
    if (refresh) {
      if (!record.tokens?.refreshToken)
        throw new Error('No refresh token available. Connect again.');
      tokens = await exchangeToken(
        record.oauth,
        { grant_type: 'refresh_token', refresh_token: record.tokens.refreshToken },
        controller.signal,
      );
      tokens.refreshToken ||= record.tokens.refreshToken;
    } else if (record.oauth.grantType === 'client_credentials') {
      tokens = await exchangeToken(
        record.oauth,
        { grant_type: 'client_credentials' },
        controller.signal,
      );
    } else {
      tokens = await browserAuthorization(record.oauth, openWebLink, controller.signal);
    }
    return await vault.setTokens(id, tokens);
  } finally {
    oauthController = undefined;
  }
}
/** Inline request OAuth 2.0: tokens are returned to the request instead of the vault. */
handle('oauth:token', async (_, input: unknown) => {
  if (oauthController) throw new Error('Another OAuth operation is active. Cancel it first.');
  const controller = new AbortController();
  oauthController = controller;
  try {
    return await requestOAuthToken(input, openWebLink, controller.signal);
  } finally {
    oauthController = undefined;
  }
});
/** Reads OAuth metadata for the forms; only public discovery documents are fetched. */
handle('oauth:discover', (event, url: unknown) => {
  if (event.sender !== window?.webContents) throw new Error('OAuth discovery unavailable.');
  return discoverOAuth(String(url ?? ''), AbortSignal.timeout(30_000));
});
handle('oauth:authorize', (_, id: string) => oauthOperation(id, false));
handle('oauth:refresh', (_, id: string) => oauthOperation(id, true));
handle('request:cancel', (_, id: string) => active.get(id)?.abort());
/** Passphrases of file-based certificates are stored as `enc:` ciphertext when OS encryption is available. */
async function revealPassphrase(payload: FileCertificatePayload): Promise<FileCertificatePayload> {
  if (!payload.passphrase?.startsWith('enc:')) return payload;
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error(
      'The certificate passphrase is encrypted, but OS encryption is unavailable. Enter it again in Settings → Certificates.',
    );
  try {
    return {
      ...payload,
      passphrase: (
        await safeStorage.decryptStringAsync(Buffer.from(payload.passphrase.slice(4), 'base64'))
      ).result,
    };
  } catch {
    throw new Error(
      'The certificate passphrase could not be decrypted on this device. Enter it again in Settings → Certificates.',
    );
  }
}
/**
 * The certificate a request presents: loaded from the unlocked vault and checked against the
 * request's host, or read from files for entries saved before certificates moved to the vault.
 */
async function requestCertificate(
  value: unknown,
  url: string,
): Promise<LoadedClientCertificate | undefined> {
  const payload = checkedCertificatePayload(value);
  if (!payload) return undefined;
  if (!('credentialId' in payload)) return loadClientCertificate(await revealPassphrase(payload));
  if (!vaultUnlocked) throw new Error(vaultLocked("present this request's client certificate"));
  return vaultCertificate(await vault.get(payload.credentialId), url);
}
/** Reads a client certificate's files into the credential, keeping stored material when editing. */
async function certificateCredential(input: CredentialInput): Promise<CredentialInput> {
  const previous =
    input?.kind === 'client-certificate' && input.id ? await vault.get(input.id) : undefined;
  return prepareCertificateCredential(input, previous);
}
const certificateFilters: Record<string, Electron.FileFilter[]> = {
  cert: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }],
  key: [{ name: 'Private keys', extensions: ['pem', 'key'] }],
  pfx: [{ name: 'PKCS#12 bundles', extensions: ['pfx', 'p12'] }],
  ca: [{ name: 'CA certificates', extensions: ['pem', 'crt', 'cer'] }],
};
handle('certificates:choose', async (event, kind: string) => {
  if (!Object.hasOwn(certificateFilters, kind))
    throw new Error('Unsupported certificate file type.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [...certificateFilters[kind], { name: 'All files', extensions: ['*'] }],
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const file = result.filePaths[0];
  if (result.canceled || !file) return null;
  if (kind !== 'ca') return { path: file, name: path.basename(file) };
  const pem = (await readFile(file, 'utf8')).trim();
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  try {
    if (!blocks?.length) throw new Error();
    blocks.forEach((block) => new X509Certificate(block));
  } catch {
    throw new Error('The file does not contain PEM CA certificates.');
  }
  return { path: file, name: path.basename(file), pem: blocks.join('\n') };
});
handle('certificates:inspect', async (_, payload: unknown) => {
  const checked = checkedCertificatePayload(payload);
  if (!checked || 'credentialId' in checked)
    throw new Error('Choose certificate files to inspect.');
  const loaded = await loadClientCertificate(await revealPassphrase(checked));
  return { subject: loaded.subject, issuer: loaded.issuer, validTo: loaded.validTo };
});
handle('request:send', async (_, request: RequestPayload): Promise<RequestResponse> => {
  if (workspaceSwitching) return { error: 'Wait for workspace switching to finish.' };
  let httpSettings;
  try {
    httpSettings = payloadSettings(request);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid HTTP settings.' };
  }
  request = {
    ...request,
    httpSettings,
    timeoutMs: httpSettings.timeoutMs,
    followRedirects: httpSettings.followRedirects,
  };
  let certificate: LoadedClientCertificate | undefined;
  if (request.clientCertificate) {
    try {
      certificate = await requestCertificate(request.clientCertificate, request.url);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid client certificate.' };
    }
  }
  const controller = new AbortController();
  if (active.has(request.id)) return { error: 'This request is already running.' };
  active.set(request.id, controller);
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs || 60000);
  try {
    if (request.credentialId) {
      if (!vaultUnlocked)
        return { error: vaultLocked('send this request with its saved credential') };
      const saved = await vault.get(request.credentialId);
      if (new URL(request.url).origin !== new URL(saved.allowedOrigin).origin)
        throw new Error(`Credential is restricted to ${saved.allowedOrigin}.`);
      const credential =
        saved.kind === 'oauth2' ? saved : await resolveCredential(saved, controller.signal);
      request = withCredential(request, credential);
    }
    return await sendHttpRequest(request, controller, undefined, certificate);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    active.delete(request.id);
  }
});
