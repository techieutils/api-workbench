import * as vscode from 'vscode';
import type { SendResult } from './core/report';
import {
  SCRIPT_SCHEME,
  completionsAt,
  scriptPath,
  scriptRef,
  syntaxProblem,
  type ScriptPhase,
  type ScriptRef,
} from './core/scripts';
import type { Source } from './core/model';
import type { Workbench } from './core/workbench';

/**
 * Request scripts in VS Code's own editors: each is an `apiworkbench-script:` document read from
 * and saved to its request through the command line. Editing has the app's `aw` suggestions and
 * syntax check, which only read the text. Saving never runs a script: in VS Code a script runs
 * only as `apiWorkbench.scripts` allows, and in the app an edited one waits for **Allow scripts**.
 */

export interface ScriptHost {
  source(key: string): Source | undefined;
  workbench(): Promise<Workbench>;
  environmentOf(source: Source): string | undefined;
  /** The last send of the request this window, for its response's headers and JSON. */
  lastSend(source: Source, requestId: string): SendResult | undefined;
  /** A script was saved: the request editor shows it. */
  saved(source: Source, requestId: string): void;
  log(text: string, level?: 'info' | 'error'): void;
}

export function scriptUri(source: string, request: string, phase: ScriptPhase, name: string) {
  return vscode.Uri.from({
    scheme: SCRIPT_SCHEME,
    path: scriptPath({ source, request, phase }, name),
  });
}

export function registerScripts(host: ScriptHost): vscode.Disposable[] {
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const times = new Map<string, number>();
  const sizes = new Map<string, number>();
  const refOf = (uri: vscode.Uri): ScriptRef & { at: Source } => {
    const ref = scriptRef(uri.path);
    const at = ref && host.source(ref.source);
    if (!ref || !at) throw vscode.FileSystemError.FileNotFound(uri);
    return { ...ref, at };
  };

  const files: vscode.FileSystemProvider = {
    onDidChangeFile: changes.event,
    watch: () => new vscode.Disposable(() => undefined),
    stat(uri) {
      // `/source/request/phase` are folders, as VS Code checks a file's folders before writing.
      const depth = uri.path.split('/').filter(Boolean).length;
      if (depth < 4) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      refOf(uri);
      const now = times.get(uri.toString()) ?? Date.now();
      times.set(uri.toString(), now);
      return {
        type: vscode.FileType.File,
        ctime: now,
        mtime: now,
        size: sizes.get(uri.toString()) ?? 0,
      };
    },
    async readFile(uri) {
      if (uri.path.split('/').filter(Boolean).length < 4)
        throw vscode.FileSystemError.FileIsADirectory(uri);
      const ref = refOf(uri);
      const details = await (await host.workbench()).showRequest({ source: ref.at }, ref.request);
      const bytes = new TextEncoder().encode(details.scripts?.[ref.phase] ?? '');
      sizes.set(uri.toString(), bytes.length);
      return bytes;
    },
    async writeFile(uri, content) {
      if (uri.path.split('/').filter(Boolean).length < 4)
        throw vscode.FileSystemError.FileIsADirectory(uri);
      const ref = refOf(uri);
      const text = new TextDecoder().decode(content);
      await (await host.workbench()).saveScript(ref.at, ref.request, ref.phase, text);
      times.set(uri.toString(), Date.now());
      sizes.set(uri.toString(), content.length);
      changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      host.saved(ref.at, ref.request);
      host.log(`Saved the ${ref.phase === 'pre' ? 'pre-request' : 'post-response'} script.`);
    },
    readDirectory: () => [],
    // The folders are the script's place, which always exists.
    createDirectory: () => undefined,
    delete: () => {
      throw vscode.FileSystemError.NoPermissions('Clear the script and save it to remove it.');
    },
    rename: () => {
      throw vscode.FileSystemError.NoPermissions('Scripts belong to requests.');
    },
  };

  // The app's suggestions: `aw` members, variable and header names, the last response's keys.
  const variables = new Map<string, Promise<string[]>>();
  const variablesOf = (source: Source) => {
    const environment = host.environmentOf(source);
    const key = `${source.name}#${environment ?? ''}`;
    let found = variables.get(key);
    if (!found) {
      found = environment
        ? host
            .workbench()
            .then((bench) => bench.environment(source, environment))
            .then((details) => details.variables.map((variable) => variable.key))
            .catch(() => [])
        : Promise.resolve([]);
      variables.set(key, found);
      setTimeout(() => variables.delete(key), 30_000);
    }
    return found;
  };
  const kinds: Record<string, vscode.CompletionItemKind> = {
    namespace: vscode.CompletionItemKind.Module,
    property: vscode.CompletionItemKind.Property,
    function: vscode.CompletionItemKind.Method,
    variable: vscode.CompletionItemKind.Variable,
    text: vscode.CompletionItemKind.Value,
  };
  const completions: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position, _token, context) {
      const ref = scriptRef(document.uri.path);
      const source = ref && host.source(ref.source);
      if (!ref || !source) return undefined;
      const details = await (
        await host.workbench()
      )
        .showRequest({ source }, ref.request)
        .catch(() => undefined);
      const last = host.lastSend(source, ref.request);
      let responseJson: unknown;
      if (last?.body && last.body.length < 2 * 1024 * 1024)
        try {
          responseJson = JSON.parse(last.body);
        } catch {
          responseJson = undefined;
        }
      const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const found = completionsAt(
        before,
        {
          phase: ref.phase,
          variables: await variablesOf(source),
          modules: [],
          requestHeaders: (details?.headers ?? []).map((header) => header.key),
          responseHeaders: Object.keys(last?.headers ?? {}),
          responseJson,
        },
        context.triggerKind === vscode.CompletionTriggerKind.Invoke,
      );
      if (!found) return undefined;
      const range = new vscode.Range(document.positionAt(found.from), position);
      return found.items.map((option) => {
        const item = new vscode.CompletionItem(option.label, kinds[option.kind]);
        item.range = range;
        item.detail = option.detail;
        if (option.doc) item.documentation = new vscode.MarkdownString().appendText(option.doc);
        item.sortText = option.sortText;
        if (option.call) {
          item.insertText = new vscode.SnippetString(`${option.label}($0)`);
          item.command = { command: 'editor.action.triggerParameterHints', title: '' };
        }
        return item;
      });
    },
  };

  // The app's syntax check, underlined as the app's script editor does.
  const diagnostics = vscode.languages.createDiagnosticCollection('API Workbench scripts');
  const check = (document: vscode.TextDocument) => {
    if (document.uri.scheme !== SCRIPT_SCHEME) return;
    const problem = syntaxProblem(document.getText());
    diagnostics.set(
      document.uri,
      problem
        ? [
            Object.assign(
              new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(problem.from),
                  document.positionAt(Math.max(problem.to, problem.from + 1)),
                ),
                problem.message,
                vscode.DiagnosticSeverity.Error,
              ),
              { source: 'API Workbench' },
            ),
          ]
        : [],
    );
  };
  for (const document of vscode.workspace.textDocuments) check(document);

  return [
    changes,
    diagnostics,
    vscode.workspace.registerFileSystemProvider(SCRIPT_SCHEME, files, { isCaseSensitive: true }),
    vscode.languages.registerCompletionItemProvider(
      { scheme: SCRIPT_SCHEME },
      completions,
      '.',
      "'",
      '"',
      '`',
    ),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((event) => check(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  ];
}
