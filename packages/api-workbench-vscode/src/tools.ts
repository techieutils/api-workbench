import path from 'node:path';
import * as vscode from 'vscode';
import type { ListOutput, Source } from './core/model';
import type { SendResult } from './core/report';
import {
  TOOLS,
  type ToolCredentials,
  credentialNote,
  field,
  pick,
  requestsText,
  runText,
  sendText,
} from './core/tools';
import type { Workbench } from './core/workbench';

/**
 * API Workbench as tools for language models in VS Code, such as Copilot's agent mode: list a
 * workspace's requests, send one, run tests, and check a specification. They go through the same
 * command line as everything else, so its redaction applies. Sending and running always ask first
 * (VS Code shows the confirmation), never run the requests' scripts unless the person's own
 * `apiWorkbench.scripts` setting is `allow`, and never save into the workspace: a send from a model
 * leaves History and environments as they were. Saved credentials apply only while the person has
 * the vault unlocked, as in their own sends; the password goes to the command line alone.
 */

export interface ToolHost {
  ready(): Promise<void>;
  sources(): { source: Source; list?: ListOutput; error?: string }[];
  workbench(): Promise<Workbench>;
  environmentOf(source: Source): string | undefined;
  /** Whether the person allowed scripts for good; anything else skips them. */
  scriptsAllowed(): boolean;
  /** The credential vault's password when the person unlocked it, for saved credentials. */
  vaultPassword(): string | undefined;
  /** Whether the person lets tools apply saved credentials (`apiWorkbench.toolsUseSavedCredentials`). */
  credentialsAllowed(): boolean;
  logSend(result: SendResult, startedAt: number): void;
  log(text: string): void;
}

const text = (value: string) =>
  new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
/** Text from a workspace, which may hold Markdown, shown as plain text in a confirmation. */
const plain = (value: string) => new vscode.MarkdownString().appendText(value);

export function registerTools(host: ToolHost): vscode.Disposable[] {
  const workspaceOf = async (input: unknown) => {
    await host.ready();
    const usable = host.sources().filter((entry) => entry.list && !entry.error);
    return pick(usable, field(input, 'workspace'), {
      what: 'workspace',
      name: (entry) => entry.source.name,
    });
  };
  const requestOf = async (input: unknown) => {
    const entry = await workspaceOf(input);
    const request = pick(entry.list!.requests, field(input, 'request', { required: true }), {
      what: 'request',
      id: (item) => item.id,
      name: (item) => item.name,
    });
    if (!request.runnable)
      throw new Error(
        `${request.name} keeps a live connection, which the person opens in its editor.`,
      );
    const environment = field(input, 'environment') ?? host.environmentOf(entry.source);
    if (environment)
      pick(entry.list!.environments, environment, { what: 'environment', name: (name) => name });
    return { entry, request, environment };
  };
  const scripts = () => (host.scriptsAllowed() ? ('allow' as const) : ('skip' as const));
  const credentials = (): ToolCredentials =>
    !host.credentialsAllowed() ? 'off' : host.vaultPassword() === undefined ? 'locked' : 'unlocked';
  // The vault password only when the person lets tools use saved credentials.
  const toolPassword = () => (host.credentialsAllowed() ? host.vaultPassword() : undefined);

  return [
    vscode.lm.registerTool(TOOLS.listRequests, {
      prepareInvocation: () => ({ invocationMessage: 'Listing API Workbench requests' }),
      async invoke(options) {
        await host.ready();
        const wanted = field(options.input, 'workspace');
        const entries = host.sources().filter((entry) => entry.list && !entry.error);
        const chosen = wanted
          ? [pick(entries, wanted, { what: 'workspace', name: (entry) => entry.source.name })]
          : entries;
        if (!chosen.length) return text('No API Workbench workspaces are open.');
        return text(
          chosen
            .map((entry) =>
              requestsText(
                entry.source.name,
                host.environmentOf(entry.source),
                entry.list!.requests,
              ),
            )
            .join('\n\n'),
        );
      },
    }),

    vscode.lm.registerTool(TOOLS.sendRequest, {
      async prepareInvocation(options) {
        const { entry, request, environment } = await requestOf(options.input);
        return {
          invocationMessage: `Sending ${request.name}`,
          confirmationMessages: {
            title: 'Send an API request?',
            message: plain(
              `${request.method} ${request.folder}/${request.name} in “${entry.source.name}”${
                environment ? ` with the environment “${environment}”` : ''
              }. Its response, with secret-looking header values hidden, is given to the model. Scripts ${
                host.scriptsAllowed() ? 'run' : 'do not run'
              }, and nothing is saved to the workspace.${credentialNote(credentials())}`,
            ),
          },
        };
      },
      async invoke(options, token) {
        const { entry, request, environment } = await requestOf(options.input);
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const startedAt = Date.now();
        const result = await (
          await host.workbench()
        ).send(entry.source, request.id, {
          environment,
          scripts: scripts(),
          save: false,
          signal: abort.signal,
          // Saved credentials apply as in the person's own sends, unless their settings keep them
          // away from tools; the model never sees the password.
          password: toolPassword(),
        });
        host.logSend(result, startedAt);
        host.log(`A language model sent ${request.name}.`);
        return text(sendText(result, credentials()));
      },
    }),

    vscode.lm.registerTool(TOOLS.runTests, {
      async prepareInvocation(options) {
        const entry = await workspaceOf(options.input);
        const collection = collectionOf(entry, options.input);
        return {
          invocationMessage: `Running ${collection || 'every request'} in ${entry.source.name}`,
          confirmationMessages: {
            title: 'Run API tests?',
            message: plain(
              `Send ${collection ? `the requests of “${collection}”` : 'every request'} in “${entry.source.name}” and run their tests. Scripts ${
                host.scriptsAllowed() ? 'run' : 'do not run'
              }.${credentialNote(credentials())}`,
            ),
          },
        };
      },
      async invoke(options, token) {
        const entry = await workspaceOf(options.input);
        const collection = collectionOf(entry, options.input);
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const startedAt = Date.now();
        const { report } = await (
          await host.workbench()
        ).runner(entry.source, {
          collection,
          mode: 'collection',
          iterations: 1,
          delayMs: 0,
          bail: false,
          concurrency: 1,
          durationSeconds: 1,
          environment: host.environmentOf(entry.source),
          scripts: scripts(),
          signal: abort.signal,
          password: toolPassword(),
        });
        let at = startedAt;
        for (const sent of report.results ?? []) {
          host.logSend(sent, at);
          at += sent.durationMs ?? 0;
        }
        host.log(`A language model ran ${collection || 'every request'} in ${entry.source.name}.`);
        return text(runText({ ...report, results: report.results ?? [] }, credentials()));
      },
    }),

    vscode.lm.registerTool(TOOLS.checkSpec, {
      prepareInvocation: () => ({ invocationMessage: 'Checking the specification' }),
      async invoke(options) {
        const file = specFile(field(options.input, 'path', { required: true, max: 4096 })!);
        const analysis = await (await host.workbench()).lintSpec({ file });
        const lines = [
          `${analysis.title ?? analysis.name}${analysis.version ? ` ${analysis.version}` : ''}: ${analysis.problems.length} problem${analysis.problems.length === 1 ? '' : 's'}, ${analysis.endpoints.length} operation${analysis.endpoints.length === 1 ? '' : 's'}.`,
          ...analysis.problems.map(
            (problem) =>
              `- ${problem.severity}${problem.line ? ` (line ${problem.line})` : ''}: ${problem.message}`,
          ),
        ];
        return text(lines.join('\n'));
      },
    }),
  ];
}

/** The collection or folder a run is limited to, checked against the workspace's. */
function collectionOf(entry: { list?: ListOutput }, input: unknown): string {
  const wanted = field(input, 'collection');
  if (!wanted) return '';
  const folders = [
    ...new Set(
      entry.list!.requests.flatMap((request) =>
        request.folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')),
      ),
    ),
  ];
  return pick(folders, wanted, { what: 'collection', name: (folder) => folder });
}

/** A YAML or JSON file inside one of the open workspace's folders, never one elsewhere. */
function specFile(given: string): string {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const candidates = path.isAbsolute(given)
    ? [path.resolve(given)]
    : folders.map((folder) => path.resolve(folder, given));
  const inside = candidates.find((file) =>
    folders.some((folder) => {
      const relative = path.relative(folder, file);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }),
  );
  if (!inside) throw new Error('Give a file inside the open workspace’s folders.');
  if (!/\.(ya?ml|json)$/i.test(inside)) throw new Error('Give a .yaml, .yml, or .json file.');
  return inside;
}
