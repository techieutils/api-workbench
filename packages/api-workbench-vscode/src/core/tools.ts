import type { ListedRequest } from './model';
import { formatBytes, statusLine, type RunReport, type SendResult } from './report';

/**
 * The language model tools (Copilot's agent mode and other chat clients in VS Code): what they
 * accept, and the text they answer with. A model's input is untrusted like a webview's, so every
 * field is checked here, and answers carry only what the command line already prints — header
 * values whose names look secret stay `<hidden>`, and credentials never appear.
 */

/** The tools, by name, as `package.json` `languageModelTools` declares them. */
export const TOOLS = {
  listRequests: 'apiWorkbench_listRequests',
  sendRequest: 'apiWorkbench_sendRequest',
  runTests: 'apiWorkbench_runTests',
  checkSpec: 'apiWorkbench_checkSpec',
} as const;

/** The most of a response body given to a model, so one large response cannot crowd out the rest. */
export const BODY_LIMIT = 16 * 1024;

/** A string field of a tool's input: trimmed, at most `max` long, and on one line. */
export function field(
  input: unknown,
  name: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  const value =
    input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new Error(`Give “${name}”.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`“${name}” must be text.`);
  const text = value.trim();
  if (!text && options.required) throw new Error(`Give “${name}”.`);
  if (text.length > (options.max ?? 500) || /[\r\n\0]/.test(text))
    throw new Error(`“${name}” is not valid.`);
  return text || undefined;
}

/** The one item of `items` named `wanted` (by id, exact name, or name in any case), or why not. */
export function pick<T>(
  items: readonly T[],
  wanted: string | undefined,
  options: { what: string; id?: (item: T) => string; name: (item: T) => string },
): T {
  if (!wanted) {
    if (items.length === 1) return items[0];
    throw new Error(
      items.length
        ? `Say which ${options.what}: ${items.map(options.name).join(', ')}.`
        : `There is no ${options.what}.`,
    );
  }
  const lower = wanted.toLowerCase();
  const found =
    items.find((item) => options.id?.(item) === wanted || options.name(item) === wanted) ??
    items.find((item) => options.name(item).toLowerCase() === lower);
  if (found) return found;
  throw new Error(
    `No ${options.what} “${wanted}”. ${options.what[0].toUpperCase()}${options.what.slice(1)}s: ${
      items.map(options.name).join(', ') || 'none'
    }.`,
  );
}

/** A workspace's requests as a model reads them: one line each, with what to call it by. */
export function requestsText(
  workspace: string,
  environment: string | undefined,
  requests: readonly ListedRequest[],
): string {
  const lines = [
    `Workspace “${workspace}”${environment ? `, environment “${environment}”` : ''}: ${requests.length} request${requests.length === 1 ? '' : 's'}.`,
  ];
  for (const request of requests)
    lines.push(
      `- ${request.protocol === 'http' ? request.method : request.protocol} ${request.folder}/${request.name} (id ${request.id})${
        request.runnable ? '' : ' — a live connection, opened by the person in its editor'
      }${request.tags?.length ? ` #${request.tags.join(' #')}` : ''}`,
    );
  return lines.join('\n');
}

/**
 * Whether tools apply saved credentials: `unlocked` with the vault open, `locked` until the person
 * unlocks it, `off` when the person's settings keep credentials away from tools altogether.
 */
export type ToolCredentials = 'unlocked' | 'locked' | 'off';

/**
 * What a confirmation says about saved credentials: with the vault unlocked they are applied, as
 * the person's own sends apply them, and their secrets never reach the model.
 */
export function credentialNote(credentials: ToolCredentials): string {
  if (credentials === 'unlocked')
    return ' Saved credentials it uses are applied from your unlocked vault; their secrets are never given to the model, though a response that repeats one would be.';
  if (credentials === 'off')
    return ' Saved credentials are kept away from tools by your settings, so a request with one is not sent.';
  return ' The credential vault is locked, so a request with a saved credential is not sent.';
}

/** What a model is told when a request needed the locked vault: only the person can unlock it. */
export const VAULT_LOCKED_HINT =
  'The request uses a saved credential and the credential vault is locked. Ask the person to run “API Workbench: Unlock Credential Vault…” in VS Code, then try again. Never ask for the vault password.';
/** What a model is told when the person keeps saved credentials away from tools. */
export const CREDENTIALS_OFF_HINT =
  'The request uses a saved credential, and the person’s settings keep saved credentials away from language model tools. Tell the person they can send it themselves from the API Workbench view. Do not try to work around this, and never ask for a password, token, or credential.';
const lockedHint = (error: string | undefined, credentials: ToolCredentials) =>
  error && /vault is locked/i.test(error)
    ? [credentials === 'off' ? CREDENTIALS_OFF_HINT : VAULT_LOCKED_HINT]
    : [];

/** A send as a model reads it: status, timing, tests, headers, and the start of the body. */
export function sendText(result: SendResult, credentials: ToolCredentials = 'locked'): string {
  const lines = [
    `${result.request.method} ${result.url ?? ''}`.trim(),
    `Result: ${statusLine(result)}${result.passed ? '' : ' (did not pass)'}`,
    ...lockedHint(result.error, credentials),
  ];
  for (const test of result.tests)
    lines.push(
      `Test ${test.pass ? 'passed' : 'failed'}: ${test.label}${test.message ? ` — ${test.message}` : ''}`,
    );
  for (const capture of result.captures)
    lines.push(
      `Captured ${capture.variable ?? capture.name ?? ''}${capture.error ? `: ${capture.error}` : ''}`,
    );
  const headers = Object.entries(result.headers ?? {});
  if (headers.length) {
    lines.push('Headers:');
    for (const [key, value] of headers) lines.push(`  ${key}: ${value}`);
  }
  if (result.body) {
    const body =
      result.body.length > BODY_LIMIT
        ? `${result.body.slice(0, BODY_LIMIT)}\n… (${formatBytes(result.body.length - BODY_LIMIT)} more not shown)`
        : result.body;
    lines.push('Body:', body);
  }
  return lines.join('\n');
}

/** A run as a model reads it: the summary, then each request that did not pass and why. */
export function runText(report: RunReport, credentials: ToolCredentials = 'locked'): string {
  const { summary } = report;
  const lines = [
    `${report.passed ? 'Passed' : 'Failed'}: ${summary.requests} request${summary.requests === 1 ? '' : 's'}, ${summary.failed} failed, ${summary.tests - summary.testsFailed}/${summary.tests} tests passed, ${Math.round(summary.elapsedMs)} ms${report.interrupted ? ' (stopped early)' : ''}.`,
  ];
  const hint = report.results
    .map((result) => lockedHint(result.error, credentials))
    .find((found) => found.length);
  if (hint) lines.push(...hint);
  for (const result of report.results)
    if (!result.passed) {
      lines.push(`- ${result.request.folder}/${result.request.name}: ${statusLine(result)}`);
      for (const test of result.tests)
        if (!test.pass)
          lines.push(`  failed: ${test.label}${test.message ? ` — ${test.message}` : ''}`);
    }
  return lines.join('\n');
}
