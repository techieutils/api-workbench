import type { ApiRequest, HttpResponse, KeyValue, ScriptModule, WorkspaceState } from './types';
import { folderChain, folderEntry, folderLabel } from './folders';
import type { AssertionResult } from './assertions';

/**
 * Request scripts: JavaScript a request runs before it is sent (`pre`) and after its response
 * arrives (`post`), with the `aw` API. They run in a separate QuickJS engine (script-engine.ts),
 * in the desktop app's main process or the command line, never in the window. This module holds
 * only the shapes and plain helpers, so the window can use it too.
 */
export type ScriptPhase = 'pre' | 'post';
export const SCRIPT_PHASES: readonly ScriptPhase[] = ['pre', 'post'];
export const PHASE_LABELS: Record<ScriptPhase, string> = {
  pre: 'Pre-request',
  post: 'Post-response',
};

/** The parts of a request a script sees, as written: variables are still `{{names}}`. */
export interface ScriptRequest {
  name: string;
  method: string;
  url: string;
  headers: KeyValue[];
  /** The raw body; empty for other body types, which scripts cannot change. */
  body: string;
}
/** The response a post-response script reads. */
export interface ScriptResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  time: number;
  size: number;
  url: string;
}
/**
 * A library module as a script receives it: its source when it may run, or `paused` when it came
 * from outside the app and has not been allowed, so requiring it pauses the script.
 */
export interface ScriptLibraryEntry {
  name: string;
  source?: string;
  paused?: boolean;
}
export interface ScriptInput {
  phase: ScriptPhase;
  source: string;
  /** The workspace's library, for `aw.require`. */
  libraries?: ScriptLibraryEntry[];
  request: ScriptRequest;
  response?: ScriptResponse;
  /** The variables a script can read with `aw.vars.get`: the environment, then a data row's. */
  variables: Record<string, string>;
}
export interface ScriptLog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}
export interface ScriptTest {
  name: string;
  pass: boolean;
  message?: string;
}
export interface ScriptOutput {
  /** False when the script threw, ran too long, used too much memory, or was paused. */
  ok: boolean;
  /** The script did not run: it came from outside the app and its collection is not allowed. */
  paused?: boolean;
  error?: string;
  /** A pre-request script's request, when it changed anything. */
  request?: ScriptRequest;
  /** Variables set (a string) or removed (null), in the order the script changed them. */
  variables: Record<string, string | null>;
  tests: ScriptTest[];
  logs: ScriptLog[];
  durationMs: number;
}

/** Limits that keep a script from stalling a run or exhausting memory. */
export const SCRIPT_LIMITS = {
  timeoutMs: 2000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sourceChars: 256 * 1024,
  modules: 100,
  logs: 200,
  logChars: 10_000,
  tests: 1000,
  variables: 1000,
  valueChars: 1024 * 1024,
  bodyChars: 25 * 1024 * 1024,
};

/** A request's scripts as read from a file or an import: strings only, blank ones dropped. */
export function normalizedScripts(value: unknown): ApiRequest['scripts'] {
  if (!value || typeof value !== 'object') return undefined;
  const scripts: NonNullable<ApiRequest['scripts']> = {};
  for (const phase of SCRIPT_PHASES) {
    const source = (value as Record<string, unknown>)[phase];
    if (typeof source === 'string' && source.trim()) scripts[phase] = source;
  }
  return Object.keys(scripts).length ? scripts : undefined;
}

/**
 * A library module's name: a letter, then letters, digits, `-`, or `_`. It is also its file
 * name (`scripts/<name>.js`), so it is the same on every system.
 */
export const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export function moduleNameProblem(name: string, taken: string[] = []): string | undefined {
  if (!MODULE_NAME.test(name))
    return 'Start with a letter, then use letters, digits, - or _ (up to 64 characters).';
  if (taken.some((other) => other.toLowerCase() === name.toLowerCase()))
    return `There is already a module named ${name}.`;
  return undefined;
}
/** A library as read from a file or an import: valid names, text sources, no duplicates. */
export function normalizedLibrary(value: unknown): ScriptModule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modules: ScriptModule[] = [];
  for (const item of value as Partial<ScriptModule>[]) {
    if (!item || typeof item.name !== 'string' || typeof item.source !== 'string') continue;
    if (
      moduleNameProblem(
        item.name,
        modules.map((module) => module.name),
      )
    )
      continue;
    if (item.source.length > SCRIPT_LIMITS.sourceChars) continue;
    modules.push({ name: item.name, source: item.source });
    if (modules.length >= SCRIPT_LIMITS.modules) break;
  }
  return modules.length ? modules : undefined;
}

/** The message shown for a script that is waiting for its collection to be allowed. */
export const PAUSED_LIBRARY_MESSAGE = (name: string) =>
  `The library module ${name} came from outside API Workbench and is paused. Review it, then choose Allow scripts.`;
export const PAUSED_MESSAGE =
  'Scripts in this collection came from outside API Workbench and are paused. Review them, then choose Allow scripts.';

/** Why a value is not a script input the engine accepts, checked where scripts are run. */
export function scriptInputProblem(value: unknown): string | undefined {
  const input = value as Partial<ScriptInput> | null;
  if (!input || typeof input !== 'object') return 'A script input is required.';
  if (!SCRIPT_PHASES.includes(input.phase as ScriptPhase)) return 'Unknown script phase.';
  if (typeof input.source !== 'string') return 'The script must be text.';
  const strings = (record: unknown) =>
    Boolean(record) &&
    typeof record === 'object' &&
    Object.values(record as object).every((item) => typeof item === 'string');
  const request = input.request as Partial<ScriptRequest> | undefined;
  if (
    !request ||
    typeof request.name !== 'string' ||
    typeof request.method !== 'string' ||
    typeof request.url !== 'string' ||
    typeof request.body !== 'string' ||
    !Array.isArray(request.headers) ||
    request.headers.some(
      (header) => !header || typeof header.key !== 'string' || typeof header.value !== 'string',
    )
  )
    return 'The script request is not valid.';
  if (!strings(input.variables)) return 'Script variables must be text.';
  if (input.libraries !== undefined) {
    const libraries = input.libraries as Partial<ScriptLibraryEntry>[];
    if (
      !Array.isArray(libraries) ||
      libraries.length > SCRIPT_LIMITS.modules ||
      libraries.some(
        (entry) =>
          !entry ||
          typeof entry.name !== 'string' ||
          !MODULE_NAME.test(entry.name) ||
          (entry.source !== undefined &&
            (typeof entry.source !== 'string' || entry.source.length > SCRIPT_LIMITS.sourceChars)),
      )
    )
      return 'The script library is not valid.';
  }
  if (input.phase === 'post') {
    const response = input.response as Partial<ScriptResponse> | undefined;
    if (
      !response ||
      typeof response.status !== 'number' ||
      typeof response.statusText !== 'string' ||
      typeof response.body !== 'string' ||
      typeof response.time !== 'number' ||
      typeof response.size !== 'number' ||
      typeof response.url !== 'string' ||
      !strings(response.headers)
    )
      return 'The script response is not valid.';
  } else if (input.response !== undefined) return 'A pre-request script has no response.';
  return undefined;
}

/** A request's script for a phase, when it has one that is not blank. */
export function scriptOf(request: ApiRequest, phase: ScriptPhase): string | undefined {
  const source = request.scripts?.[phase];
  return source && source.trim() ? source : undefined;
}
export const hasScripts = (request: ApiRequest): boolean =>
  SCRIPT_PHASES.some((phase) => scriptOf(request, phase) !== undefined);

/** What a script sees of a request. */
export function scriptRequestOf(request: ApiRequest): ScriptRequest {
  return {
    name: request.name,
    method: request.method,
    url: request.url,
    headers: request.headers.map((header) => ({
      enabled: header.enabled,
      key: header.key,
      value: header.value,
    })),
    body: (request.bodyType ?? 'raw') === 'raw' ? request.body : '',
  };
}
/** What a script sees of a response. */
export function scriptResponseOf(response: HttpResponse): ScriptResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { ...response.headers },
    body: response.body,
    time: response.time,
    size: response.size,
    url: response.url,
  };
}
/** Where a URL sends a request (scheme, host, and port), or undefined when it has no host yet. */
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    // An unresolved {{variable}} is not a host yet.
    return parsed.host && !/[{}]|%7B|%7D/i.test(parsed.host) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Why a request whose pre-request scripts ran must not be sent: they changed where it goes. Its
 * URL is compared resolved, before the scripts and after, so a host set through a variable such as
 * `{{base_url}}` counts too. Scripts may change the path, query, headers, and body; keeping the host
 * means an allowed script cannot send the request, with its credentials and cookies, elsewhere.
 */
export function scriptHostProblem(before: string, after: string): string | undefined {
  const from = originOf(before);
  const to = originOf(after);
  if (!to || from === to) return undefined;
  return `A pre-request script changed where this request is sent${from ? `, from ${from}` : ''} to ${to}. Scripts can change the path, query, headers, and body, but not the host: set the host in the request's URL or in its environment instead.`;
}
/**
 * The request to send after a pre-request script changed it: a copy, so the saved request is
 * untouched. The URL's query is the Params table's, so the copy's table is read from its URL.
 */
export function withScriptRequest(request: ApiRequest, edited: ScriptRequest): ApiRequest {
  const copy: ApiRequest = {
    ...request,
    method: edited.method,
    url: edited.url,
    headers: edited.headers.map((header) => ({ ...header })),
  };
  if (edited.url !== request.url) copy.params = paramsOf(edited.url);
  if ((request.bodyType ?? 'raw') === 'raw') copy.body = edited.body;
  return copy;
}
function paramsOf(url: string): KeyValue[] {
  const hash = url.indexOf('#');
  const withoutHash = hash >= 0 ? url.slice(0, hash) : url;
  const query = withoutHash.indexOf('?');
  if (query < 0) return [];
  return withoutHash
    .slice(query + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const equals = pair.indexOf('=');
      return {
        enabled: true,
        key: equals >= 0 ? pair.slice(0, equals) : pair,
        value: equals >= 0 ? pair.slice(equals + 1) : '',
      };
    });
}

/**
 * Applies a script's variable changes to an environment's list, as captures do: a set value is
 * switched on, and a removed one is deleted.
 */
export function applyScriptVariables(
  variables: KeyValue[],
  changes: Record<string, string | null>,
): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const index = variables.findIndex((variable) => variable.key === key);
    if (value === null) {
      if (index >= 0) variables.splice(index, 1);
    } else if (index >= 0) Object.assign(variables[index], { value, enabled: true });
    else variables.push({ enabled: true, key, value });
    changed.push(key);
  }
  return changed;
}

/**
 * A script's tests and failure as test results, after the request's assertions. `scope` names
 * where a collection or folder script comes from, such as "Shop / Orders".
 */
export function scriptAssertions(
  phase: ScriptPhase,
  output: ScriptOutput,
  scope?: string,
): AssertionResult[] {
  const label = `${scope ? `${scope} · ` : ''}${PHASE_LABELS[phase]} script`;
  const results: AssertionResult[] = output.tests.map((test) => ({
    label,
    name: test.name,
    pass: test.pass,
    message: test.pass ? 'Passed' : test.message || 'Failed',
    line: 0,
  }));
  if (!output.ok)
    results.push({
      label,
      name: output.paused ? `${label} paused` : `${label} error`,
      pass: false,
      message: output.error || 'The script failed.',
      line: 0,
    });
  return results;
}

/**
 * One script that runs for a request: the workspace's (`workspace`), a collection's or folder's
 * (`folder`), or the request's own (neither).
 */
export interface ScriptStep {
  phase: ScriptPhase;
  source: string;
  /** The collection or folder path whose script this is. */
  folder?: string;
  /** The workspace's own script. */
  workspace?: true;
}
/** Where a step's script lives, as people read it: "Workspace", "Shop / Orders", or none. */
export const stepScope = (step: ScriptStep): string | undefined =>
  step.workspace ? 'Workspace' : step.folder === undefined ? undefined : folderLabel(step.folder);
/** The parts of a workspace that hold scripts above its requests. */
export type ScriptLevels = Pick<WorkspaceState, 'workspaceScripts' | 'collectionScripts'>;

/**
 * The scripts that run for a request in a phase, in order: the workspace's, the collection's,
 * then each folder's down to the request's own folder, then the request's. Both phases run from
 * the outside in, so an outer level can set up what the inner ones rely on, and check every
 * response.
 */
export function scriptSteps(
  workspace: ScriptLevels,
  request: ApiRequest,
  phase: ScriptPhase,
): ScriptStep[] {
  const steps: ScriptStep[] = [];
  const everywhere = normalizedScripts(workspace.workspaceScripts)?.[phase];
  if (everywhere) steps.push({ phase, source: everywhere, workspace: true });
  for (const folder of folderChain(request.folder)) {
    const source = normalizedScripts(folderEntry(workspace.collectionScripts, folder))?.[phase];
    if (source) steps.push({ phase, source, folder });
  }
  const own = scriptOf(request, phase);
  if (own) steps.push({ phase, source: own });
  return steps;
}
/** Every script that would run for a request, in either phase. */
export const allScriptSteps = (workspace: ScriptLevels, request: ApiRequest): ScriptStep[] =>
  SCRIPT_PHASES.flatMap((phase) => scriptSteps(workspace, request, phase));

export interface StepResult {
  step: ScriptStep;
  output: ScriptOutput;
}
/**
 * Runs a phase's scripts in order. Each sees the variables as the one before left them (the
 * caller applies each output's variables in `applied`) and, before sending, the request as the
 * one before changed it. Before sending, the first failure stops the chain; after a response,
 * every script runs, so one failing check does not hide the others.
 */
export async function runScriptSteps(
  steps: ScriptStep[],
  context: {
    request: ScriptRequest;
    response?: ScriptResponse;
    variables: () => Record<string, string>;
    run: (input: ScriptInput) => Promise<ScriptOutput>;
    applied: (result: StepResult) => void;
  },
): Promise<{ results: StepResult[]; request?: ScriptRequest; failed?: StepResult }> {
  const results: StepResult[] = [];
  let request: ScriptRequest | undefined;
  for (const step of steps) {
    const output = await context.run({
      phase: step.phase,
      source: step.source,
      request: request ?? context.request,
      ...(context.response ? { response: context.response } : {}),
      variables: context.variables(),
    });
    const result = { step, output };
    results.push(result);
    context.applied(result);
    if (output.request) request = output.request;
    if (!output.ok && step.phase === 'pre') return { results, request, failed: result };
  }
  return { results, request, failed: results.find((result) => !result.output.ok) };
}

/** A blank output, for a phase that had no script or did not run. */
export const emptyScriptOutput = (): ScriptOutput => ({
  ok: true,
  variables: {},
  tests: [],
  logs: [],
  durationMs: 0,
});
