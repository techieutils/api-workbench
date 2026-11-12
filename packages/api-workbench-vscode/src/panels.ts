import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { guideUrl, isGuideName } from '@techieutils/api-workbench-common/support-links';

/**
 * The extension's webviews: editor tabs (the request editor, responses, mock servers) and the
 * network log in the panel. Each runs dist/webview.js under a content security policy that allows
 * only that script and dist/webview.css (built with Tailwind CSS), and no network; it renders what is posted to it as text
 * and answers with the names of fixed actions, which are checked here before anything is done.
 * An action may carry a value (an edited request, the runner's settings), which is only data: the
 * extension checks it (`core/editing.ts`) before using any of it.
 */

export const ACTIONS = [
  'send',
  'save',
  'code',
  'curl',
  'environment',
  'openFile',
  'copyBody',
  'openText',
  'saveToCollection',
  'copyUrl',
  'start',
  'stop',
  'clear',
  'run',
  'cancel',
  'pickData',
  'clearData',
  'generate',
  'mockFromSpec',
  'editPre',
  'editPost',
  'connect',
  'disconnect',
  'sendMessage',
  'finish',
  'getToken',
  'refreshToken',
  'create',
  'fromCurl',
  'fetchSchema',
  'saveMock',
  'restart',
  'unlock',
  'saveCredential',
  'deleteCredential',
  'refresh',
  'syncMock',
  'chooseEnvironment',
  'saveVariables',
  'useEnvironment',
  'newEnvironment',
  'renameEnvironment',
  'deleteEnvironment',
  'rerun',
  'showOutput',
  'openRequest',
  'addCertificate',
  'toggleCertificate',
  'removeCertificate',
  'trustCertificates',
  'untrustCertificates',
  'chooseUpload',
  'openGuide',
] as const;
export type Action = (typeof ACTIONS)[number];
const KNOWN = new Set<string>(ACTIONS);

function html(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const policy = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const escaped = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped}</title>
<link rel="stylesheet" href="${style}">
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

const options = (extensionUri: vscode.Uri): vscode.WebviewOptions => ({
  enableScripts: true,
  enableCommandUris: false,
  localResourceRoots: [
    vscode.Uri.joinPath(extensionUri, 'dist'),
    vscode.Uri.joinPath(extensionUri, 'media'),
  ],
});

/** Wires a webview to a view model: renders it when ready, and passes on known actions. */
function connect(
  webview: vscode.Webview,
  current: () => unknown,
  onAction: (action: Action, value: unknown) => void,
): vscode.Disposable {
  return webview.onDidReceiveMessage((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, action, value } = message as {
      type?: unknown;
      action?: unknown;
      value?: unknown;
    };
    if (type === 'ready') void webview.postMessage({ type: 'render', view: current() });
    // Every page may link to its guide: only a known guide's name is accepted, never an address.
    else if (type === 'action' && action === 'openGuide') {
      if (isGuideName(value)) void vscode.env.openExternal(vscode.Uri.parse(guideUrl(value), true));
    } else if (type === 'action' && typeof action === 'string' && KNOWN.has(action))
      onAction(action as Action, value);
  });
}

/** An editor tab showing one view, kept by a key so opening the same thing again reuses it. */
export class Panel<View> {
  private static open = new Map<string, Panel<unknown>>();
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static get<View>(key: string): Panel<View> | undefined {
    return Panel.open.get(key) as Panel<View> | undefined;
  }

  /** Every open panel whose key starts with `prefix`, such as the requests of one source. */
  static all<View>(prefix: string): Panel<View>[] {
    return [...Panel.open.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, panel]) => panel as Panel<View>);
  }

  constructor(
    readonly key: string,
    extensionUri: vscode.Uri,
    title: string,
    private view: View,
    onAction: (action: Action, panel: Panel<View>, value: unknown) => void,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
    icon?: { light: vscode.Uri; dark: vscode.Uri },
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'apiWorkbench.panel',
      title,
      { viewColumn: column, preserveFocus: column === vscode.ViewColumn.Beside },
      { ...options(extensionUri), retainContextWhenHidden: false },
    );
    // The app's mark in its light or dark colours, as the theme is: an editor tab draws its icon as
    // an image, so the activity bar's one-colour mark would be black on a dark theme.
    this.panel.iconPath = icon ?? {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg'),
    };
    this.panel.webview.html = html(this.panel.webview, extensionUri, title);
    this.disposables.push(
      connect(
        this.panel.webview,
        () => this.view,
        (action, value) => onAction(action, this, value),
      ),
    );
    this.panel.onDidDispose(() => {
      Panel.open.delete(key);
      for (const listener of this.closing) listener();
      for (const disposable of this.disposables) disposable.dispose();
    });
    Panel.open.set(key, this as Panel<unknown>);
  }

  private closing: (() => void)[] = [];
  /** Runs `listener` when the tab closes, such as to stop its live connection. */
  onClose(listener: () => void): void {
    this.closing.push(listener);
  }

  get current(): View {
    return this.view;
  }

  update(view: View, title?: string, icon?: { light: vscode.Uri; dark: vscode.Uri }): void {
    this.view = view;
    if (title) this.panel.title = title;
    if (icon) this.panel.iconPath = icon;
    void this.panel.webview.postMessage({ type: 'render', view });
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column, column === vscode.ViewColumn.Beside);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

/** The network log, a webview in the panel beside the terminal. */
export class NetworkView<View> implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly current: () => View,
    private readonly onAction: (action: Action, value: unknown) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = options(this.extensionUri);
    view.webview.html = html(view.webview, this.extensionUri, 'Network');
    const listener = connect(view.webview, this.current, this.onAction);
    view.onDidDispose(() => {
      listener.dispose();
      this.view = undefined;
    });
  }

  refresh(): void {
    void this.view?.webview.postMessage({ type: 'render', view: this.current() });
  }
}
