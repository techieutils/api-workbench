import { formatBytes, type RunReport, type SendResult } from './report';
import type { NetworkEntry } from './views';
import { AUTH_FORMS, OPTION_FIELDS, SECRET_FIELDS } from './auth';

/**
 * What the request editor, the runner, and the panel's Console and Performance tabs work with:
 * an edited request and the `request update` arguments that save it, cookies and a timeline of a
 * response, a run's results, and statistics of the requests sent. Everything a webview sends back
 * is checked here before the extension uses it, since a webview is only trusted to render.
 */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** A request as the editor has it: what can be changed from VS Code. */
export interface RequestDraft {
  method: string;
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  body: string;
  /** Assertions, one per line, such as `status 200` or `body.id exists`. */
  tests: string;
  /** The request's own tags; its collection's and folders' are shown, not edited, here. */
  tags: string[];
  /** Values saved into variables after a send: `orderId` from `body.id`. */
  captures: { key: string; value: string }[];
  /** `none`, `raw`, `form-data`, `x-www-form-urlencoded`, or `binary` (a file). */
  bodyType: string;
  /**
   * A form's fields; a value still `<hidden>` keeps the saved one. A file field has no value, only
   * the name of its file: the file itself is chosen for each session and given with each send.
   */
  form: FormRow[];
  /** The name of the file a file body sends. */
  binaryName?: string;
  auth: AuthDraft;
}

/**
 * A request's auth as the editor has it. `secret` is a new token or password typed here, empty to
 * keep the saved one: the saved one is never sent to VS Code.
 */
export interface AuthDraft {
  type: string;
  username: string;
  secret: string;
  apiKeyIn: 'header' | 'query';
  credentialId: string;
  /** The settings of the types with a form of their own (`core/auth.ts`), as saved or changed. */
  options: Record<string, string | boolean>;
  /** New values for their secrets, by field (`password`, `awsSessionToken`, …); empty keeps one. */
  secrets: Record<string, string>;
}

/** The auth types the editor sets, by the name `request update --auth` takes. */
export const EDITABLE_AUTH: Record<string, string> = {
  None: 'none',
  'Inherit from collection': 'inherit',
  'Bearer token': 'bearer',
  'Basic auth': 'basic',
  'API key': 'api-key',
  'Digest auth': 'digest',
  'JWT bearer': 'jwt',
  'AWS Signature': 'aws',
  'OAuth 1.0': 'oauth1',
  'OAuth 2.0 (request)': 'oauth2',
  NTLM: 'ntlm',
  WSSE: 'wsse',
  'Akamai EdgeGrid': 'edgegrid',
  Hawk: 'hawk',
  'Saved credential': 'credential',
};
export const FORM_TYPES = ['form-data', 'x-www-form-urlencoded'];
const BODY_TYPES = ['none', 'raw', ...FORM_TYPES, 'binary'];

/** A form field: text, or (`kind: 'file'`) a file field with the name of its file. */
export interface FormRow {
  key: string;
  value: string;
  enabled: boolean;
  kind?: 'file';
  fileName?: string;
}

/** A file's name as a form or file body keeps it: no folders, no line breaks. */
export const fileNameProblem = (name: string) =>
  name.length > 255 || /[\r\n/\\]/.test(name) ? 'not a file name' : undefined;
/** The environment variable a new token or password reaches the command line in. */
export const SECRET_VARIABLE = 'API_WORKBENCH_AUTH_SECRET';
/** The environment variable a form's settings and new secrets reach the command line in, as JSON. */
export const FIELDS_VARIABLE = 'API_WORKBENCH_AUTH_FIELDS';

/** What the command line prints for a header value it hides (`request show`). */
export const HIDDEN = '<hidden>';

const MAX_TEXT = 1024 * 1024;
const text = (value: unknown, max = MAX_TEXT): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined;

/**
 * A draft posted by a webview, or `undefined` when it is not one: every field checked, text kept
 * to sane sizes, and line breaks refused where the command line takes one line.
 */
export function draftFrom(value: unknown): RequestDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const given = value as Record<string, unknown>;
  const method = text(given.method, 20)?.trim().toUpperCase();
  const url = text(given.url, 64 * 1024);
  const body = text(given.body);
  if (!method || !/^[A-Z]+$/.test(method) || url === undefined || /[\r\n]/.test(url)) return;
  if (body === undefined || !Array.isArray(given.headers) || given.headers.length > 500) return;
  const headers: RequestDraft['headers'] = [];
  for (const header of given.headers as unknown[]) {
    if (!header || typeof header !== 'object') return;
    const { key, value: headerValue, enabled } = header as Record<string, unknown>;
    const name = text(key, 1000);
    const content = text(headerValue, 64 * 1024);
    if (name === undefined || content === undefined || /[\r\n]/.test(name + content)) return;
    // A header's name cannot hold a colon: the command line splits "Name: value" at the first.
    if (name.includes(':')) return;
    headers.push({ key: name, value: content, enabled: enabled !== false });
  }
  const tests = text(given.tests, 64 * 1024) ?? (given.tests === undefined ? '' : undefined);
  if (tests === undefined) return;
  const tags: string[] = [];
  for (const tag of Array.isArray(given.tags) ? given.tags : given.tags === undefined ? [] : [0]) {
    // A tag is one word; the command line checks the rest (length, characters, repeats).
    const value = text(tag, 100)?.trim();
    if (value === undefined || /[\s,#]/.test(value)) return;
    if (value) tags.push(value);
  }
  const captures: RequestDraft['captures'] = [];
  for (const capture of Array.isArray(given.captures)
    ? given.captures
    : given.captures === undefined
      ? []
      : [0]) {
    if (!capture || typeof capture !== 'object') return;
    const { key, value: from } = capture as Record<string, unknown>;
    const name = text(key, 200)?.trim();
    const source = text(from, 2000)?.trim();
    if (name === undefined || source === undefined || /[\r\n]/.test(source)) return;
    if (!name && !source) continue;
    if (!name || !source || /[{}\s=]/.test(name)) return;
    captures.push({ key: name, value: source });
  }
  const bodyType = text(given.bodyType, 40) ?? 'none';
  if (!BODY_TYPES.includes(bodyType)) return;
  if (!Array.isArray(given.form) || given.form.length > 500) return;
  const form: RequestDraft['form'] = [];
  for (const item of given.form as unknown[]) {
    if (!item || typeof item !== 'object') return;
    const { key, value: fieldValue, enabled, kind, fileName } = item as Record<string, unknown>;
    const name = text(key, 1000);
    if (name === undefined || /[\r\n]/.test(name)) return;
    if (kind === 'file') {
      const file = fileName === undefined ? '' : text(fileName, 255);
      if (file === undefined || fileNameProblem(file)) return;
      form.push({
        key: name,
        value: '',
        enabled: enabled !== false,
        kind: 'file',
        ...(file ? { fileName: file } : {}),
      });
      continue;
    }
    if (kind !== undefined && kind !== 'text') return;
    const content = text(fieldValue, MAX_TEXT);
    if (content === undefined) return;
    if (!name && !content) continue;
    form.push({ key: name, value: content, enabled: enabled !== false });
  }
  const binaryName = given.binaryName === undefined ? '' : text(given.binaryName, 255);
  if (binaryName === undefined || fileNameProblem(binaryName)) return;
  const auth = given.auth as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== 'object') return;
  const type = text(auth.type, 60);
  const username = text(auth.username, 1000);
  const secret = text(auth.secret, 64 * 1024);
  const credentialId = text(auth.credentialId, 200) ?? '';
  if (type === undefined || username === undefined || secret === undefined) return;
  if (/[\r\n]/.test(username + secret) || !/^[\w.-]*$/.test(credentialId)) return;
  const apiKeyIn = auth.apiKeyIn === 'query' ? 'query' : 'header';
  const options = authOptionsFrom(auth.options);
  const secrets = authSecretsFrom(auth.secrets);
  if (!options || !secrets) return;
  return {
    method,
    url,
    headers,
    body,
    tests,
    tags,
    captures,
    bodyType,
    form,
    ...(binaryName ? { binaryName } : {}),
    auth: { type, username, secret, apiKeyIn, credentialId, options, secrets },
  };
}

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** A form's settings from a webview: only the fields `core/auth.ts` names, with values they take. */
function authOptionsFrom(value: unknown): AuthDraft['options'] | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const options: AuthDraft['options'] = {};
  for (const [key, given] of Object.entries(value)) {
    const field = OPTION_FIELDS.get(key);
    if (!field) return;
    if (field.kind === 'check') {
      if (typeof given !== 'boolean') return;
    } else if (typeof given !== 'string' || given.length > 64 * 1024) return;
    else if (
      field.kind === 'choice' &&
      given &&
      !field.choices?.some((item) => item.value === given)
    )
      return;
    else if (field.kind === 'text' && /[\r\n]/.test(given)) return;
    options[key] = given;
  }
  return options;
}

/** New secrets from a webview: only the secret fields of the forms, as text; empty ones dropped. */
function authSecretsFrom(value: unknown): AuthDraft['secrets'] | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const secrets: AuthDraft['secrets'] = {};
  for (const [key, given] of Object.entries(value)) {
    if (!SECRET_FIELDS.has(key) || typeof given !== 'string' || given.length > 64 * 1024) return;
    if (given) secrets[key] = given;
  }
  return secrets;
}

/**
 * The `request update` options that turn `saved` into `draft`, or none when nothing changed.
 * Headers are matched by name, as the command line matches them: a changed or new one is set, a
 * removed one unset, and a value still hidden (`<hidden>`) is left alone so it is never written
 * back as that text. Options are `--name=value`, so a value starting with a dash stays a value.
 */
export function updateArgs(saved: RequestDraft, draft: RequestDraft): string[] {
  return updatePlan(saved, draft).args;
}

/**
 * What saving `draft` takes: the `request update` options, and what goes to the command line other
 * than as arguments — a form's fields on standard input, and a new token or password in its
 * environment — since either may be a secret.
 */
export function updatePlan(
  saved: RequestDraft,
  draft: RequestDraft,
): { args: string[]; input?: string; env?: Record<string, string> } {
  const args = baseArgs(saved, draft);
  const plan: { args: string[]; input?: string; env?: Record<string, string> } = { args };
  if (draft.bodyType !== saved.bodyType) args.push(`--body-type=${draft.bodyType}`);
  if ((draft.binaryName ?? '') !== (saved.binaryName ?? ''))
    args.push(`--binary-name=${draft.binaryName ?? ''}`);
  if (JSON.stringify(draft.form) !== JSON.stringify(saved.form)) {
    args.push('--form-fields=-');
    // Each field's kind, so the list is the whole form, its file fields with it.
    plan.input = JSON.stringify(
      draft.form.map((row) =>
        row.kind === 'file'
          ? {
              key: row.key,
              value: '',
              enabled: row.enabled,
              kind: 'file',
              ...(row.fileName ? { fileName: row.fileName } : {}),
            }
          : { key: row.key, value: row.value, enabled: row.enabled, kind: 'text' },
      ),
    );
  }
  const auth = draft.auth;
  const name = EDITABLE_AUTH[auth.type];
  if (name) {
    if (auth.type !== saved.auth.type) args.push(`--auth=${name}`);
    if (auth.username !== saved.auth.username) args.push(`--auth-username=${auth.username}`);
    if (auth.apiKeyIn !== saved.auth.apiKeyIn) args.push(`--api-key-in=${auth.apiKeyIn}`);
    if (auth.credentialId && auth.credentialId !== saved.auth.credentialId)
      args.push(`--credential=${auth.credentialId}`);
    // The types with a form give each secret by its field instead (`secrets`).
    if (auth.secret && !own(AUTH_FORMS, auth.type)) {
      args.push(`--auth-secret-from-env=${SECRET_VARIABLE}`);
      plan.env = { [SECRET_VARIABLE]: auth.secret };
    }
    if (own(AUTH_FORMS, auth.type)) {
      // Settings that changed (an emptied one removed), and new secrets, as one JSON value in the
      // environment: secrets are never arguments.
      const fields: { password?: string; token?: string; options?: Record<string, unknown> } = {};
      const options: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(auth.secrets))
        if (key === 'password' || key === 'token') fields[key] = value;
        else options[key] = value;
      const before = saved.auth.options ?? {};
      for (const key of new Set([...Object.keys(auth.options), ...Object.keys(before)])) {
        const now = own(auth.options, key) ? auth.options[key] : undefined;
        const was = own(before, key) ? before[key] : undefined;
        if (now === was) continue;
        options[key] = now === undefined || now === '' ? null : now;
      }
      if (Object.keys(options).length) fields.options = options;
      if (Object.keys(fields).length) {
        args.push(`--auth-fields-from-env=${FIELDS_VARIABLE}`);
        plan.env = { ...plan.env, [FIELDS_VARIABLE]: JSON.stringify(fields) };
      }
    }
  }
  return plan;
}

function baseArgs(saved: RequestDraft, draft: RequestDraft): string[] {
  const args: string[] = [];
  if (draft.method !== saved.method) args.push(`--method=${draft.method}`);
  if (draft.url !== saved.url) args.push(`--url=${draft.url}`);
  const lower = (key: string) => key.trim().toLowerCase();
  const before = new Map(saved.headers.map((header) => [lower(header.key), header]));
  const kept = new Set<string>();
  for (const header of draft.headers) {
    const key = lower(header.key);
    if (!key) continue;
    kept.add(key);
    const old = before.get(key);
    const same =
      (header.value === HIDDEN && old?.value === HIDDEN) ||
      (old && old.key.trim() === header.key.trim() && old.value === header.value);
    if (!same) args.push(`--header=${header.key.trim()}: ${header.value}`);
    // Switched off or on, or added switched off: kept, and sent only when on.
    const wasOn = old ? old.enabled !== false : true;
    if ((header.enabled !== false) !== wasOn)
      args.push(`--${header.enabled === false ? 'disable' : 'enable'}-header=${header.key.trim()}`);
  }
  for (const [key, header] of before)
    if (!kept.has(key)) args.push(`--unset-header=${header.key.trim()}`);
  if (draft.body !== saved.body)
    args.push(...(draft.body ? [`--body=${draft.body}`] : ['--no-body']));
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  if (lines(draft.tests) !== lines(saved.tests)) args.push(`--tests=${lines(draft.tests)}`);
  if (draft.tags.join(',') !== saved.tags.join(','))
    args.push(...(draft.tags.length ? draft.tags.map((tag) => `--tag=${tag}`) : ['--no-tags']));
  const pairs = (list: RequestDraft['captures']) =>
    list.map((capture) => `${capture.key}=${capture.value}`);
  if (pairs(draft.captures).join('\n') !== pairs(saved.captures).join('\n'))
    args.push(
      ...(draft.captures.length
        ? pairs(draft.captures).map((pair) => `--capture=${pair}`)
        : ['--no-captures']),
    );
  return args;
}

/** The query parameters of a URL, `{{variables}}` and all, as the editor's Params tab lists them. */
export function paramsOf(url: string): { key: string; value: string }[] {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  if (!query) return [];
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return at < 0
        ? { key: pair, value: '' }
        : { key: pair.slice(0, at), value: pair.slice(at + 1) };
    });
}

/** The URL with its query replaced by `params`, written as typed (no encoding of `{{…}}`). */
export function withParams(url: string, params: { key: string; value: string }[]): string {
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  const base = url.split('#')[0].split('?')[0];
  const query = params
    .filter((param) => param.key || param.value)
    .map((param) =>
      param.value || param.key.endsWith('=') ? `${param.key}=${param.value}` : param.key,
    )
    .join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

/** A cookie a response sets, as its Cookies tab lists it. */
export interface ResponseCookie {
  name: string;
  value: string;
  /** Domain, path, expiry, and flags, as `Path=/ · HttpOnly`. */
  attributes: string;
}

/**
 * The cookies a response sets. The command line joins repeated headers with a comma, which an
 * expiry date also holds, so a new cookie starts only at a comma followed by `name=`.
 */
export function responseCookies(headers: Record<string, string> | undefined): ResponseCookie[] {
  const value = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === 'set-cookie',
  )?.[1];
  // The command line hides it, as cookies are often sessions; `cookiesHidden` says so.
  if (!value || value === HIDDEN) return [];
  return value
    .split(/\n|,(?=\s*[^;,=\s]+=)/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pair, ...rest] = line.split(';');
      const at = pair.indexOf('=');
      return {
        name: (at < 0 ? pair : pair.slice(0, at)).trim(),
        value: at < 0 ? '' : pair.slice(at + 1).trim(),
        attributes: rest
          .map((part) => part.trim())
          .filter(Boolean)
          .join(' · '),
      };
    });
}

/** Whether a response set cookies whose values the command line kept back. */
export const cookiesHidden = (headers: Record<string, string> | undefined) =>
  Object.entries(headers ?? {}).some(
    ([key, value]) => key.toLowerCase() === 'set-cookie' && value === HIDDEN,
  );

/** The steps of one send, as the response's Timeline tab shows them. */
export function timeline(
  result: SendResult,
  startedAt: number,
): { label: string; value: string }[] {
  const header = (name: string) =>
    Object.entries(result.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const rows = [
    { label: 'Started', value: new Date(startedAt).toLocaleTimeString() },
    { label: 'Request', value: `${result.request.method} ${result.url ?? ''}`.trim() },
  ];
  if (result.error) rows.push({ label: 'Error', value: result.error });
  else {
    rows.push({
      label: 'Response',
      value: [
        `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
        result.httpVersion ? `HTTP/${result.httpVersion}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
    const type = header('content-type');
    if (type) rows.push({ label: 'Content type', value: type });
    if (result.size !== undefined) rows.push({ label: 'Size', value: formatBytes(result.size) });
  }
  if (result.durationMs !== undefined)
    rows.push({ label: 'Total time', value: `${Math.round(result.durationMs)} ms` });
  if (result.tests.length)
    rows.push({
      label: 'Tests',
      value: `${result.tests.filter((test) => test.pass).length} of ${result.tests.length} passed`,
    });
  for (const capture of result.captures)
    rows.push({
      label: 'Captured',
      value: `${capture.variable ?? capture.name ?? ''}${capture.error ? ` — ${capture.error}` : ''}`,
    });
  return rows;
}

/** Each request's statistics over the sends in the network log, slowest first. */
export interface PerformanceRow {
  name: string;
  method: string;
  count: number;
  errors: number;
  average: string;
  min: string;
  p95: string;
  max: string;
}

/** The nearest-rank percentile of sorted values, as the app's runner reports them. */
export const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

export function performanceRows(entries: NetworkEntry[]): PerformanceRow[] {
  const groups = new Map<string, NetworkEntry[]>();
  for (const entry of entries) {
    const key = `${entry.method} ${entry.name}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const ms = (value: number) => `${Math.round(value)} ms`;
  return [...groups.values()]
    .map((group) => {
      const times = group.map((entry) => entry.durationMs).sort((a, b) => a - b);
      const average = times.reduce((sum, time) => sum + time, 0) / times.length;
      return {
        sortBy: average,
        row: {
          name: group[0].name,
          method: group[0].method,
          count: group.length,
          errors: group.filter((entry) => entry.error || (entry.status ?? 0) >= 400).length,
          average: ms(average),
          min: ms(times[0]),
          p95: ms(percentile(times, 95)),
          max: ms(times[times.length - 1]),
        },
      };
    })
    .sort((a, b) => b.sortBy - a.sortBy)
    .map((item) => item.row);
}

/** One line of the panel's Console: what the extension did, and what went wrong. */
export interface ConsoleEntry {
  time: string;
  level: 'info' | 'error';
  text: string;
}

/** The runner's settings, as its form posts them. */
export interface RunnerOptions {
  /** A collection or folder path; empty runs every request. */
  collection: string;
  mode: 'collection' | 'benchmark' | 'performance';
  iterations: number;
  delayMs: number;
  bail: boolean;
  concurrency: number;
  durationSeconds: number;
}

const whole = (value: unknown, min: number, max: number): number | undefined => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= min && number <= max
    ? number
    : undefined;
};

/** Runner options posted by a webview, checked against the collections there are. */
export function runnerOptionsFrom(
  value: unknown,
  collections: readonly string[],
): RunnerOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const given = value as Record<string, unknown>;
  const collection = typeof given.collection === 'string' ? given.collection : undefined;
  if (collection === undefined || (collection && !collections.includes(collection))) return;
  const mode = given.mode;
  if (mode !== 'collection' && mode !== 'benchmark' && mode !== 'performance') return;
  const iterations = whole(given.iterations, 1, 10_000);
  const delayMs = whole(given.delayMs, 0, 600_000);
  const concurrency = whole(given.concurrency, 1, 50);
  const durationSeconds = whole(given.durationSeconds, 1, 3600);
  if (
    iterations === undefined ||
    delayMs === undefined ||
    concurrency === undefined ||
    durationSeconds === undefined
  )
    return;
  return {
    collection,
    mode,
    iterations,
    delayMs,
    bail: given.bail === true,
    concurrency,
    durationSeconds,
  };
}

/** The `run` options for the runner's settings, after the source and selection. */
export function runnerArgs(options: RunnerOptions, data?: string): string[] {
  const args: string[] = [];
  if (options.collection) args.push(`--collection=${options.collection}`);
  if (options.mode === 'collection') {
    if (options.iterations > 1) args.push('--iterations', String(options.iterations));
    if (options.delayMs) args.push('--delay', String(options.delayMs));
    if (options.bail) args.push('--bail');
    if (data) args.push(`--data=${data}`);
    return args;
  }
  args.push('--mode', options.mode, '--concurrency', String(options.concurrency));
  if (options.mode === 'benchmark') args.push('--iterations', String(options.iterations));
  else args.push('--duration', String(options.durationSeconds));
  return args;
}

/** A load test's results, as `run --report-json` writes them for benchmark and performance runs. */
export interface LoadReport extends Omit<RunReport, 'results'> {
  results?: SendResult[];
  mode?: string;
  metrics?: {
    completed: number;
    failed: number;
    errorRate: number;
    rps: number;
    average: number;
    min: number;
    max: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  thresholds?: { name: string; actual: number | string; limit: number | string; passed: boolean }[];
}

export interface RunnerView {
  view: 'runner';
  workspace: string;
  environment?: string;
  collections: string[];
  options: RunnerOptions;
  /** The data file's name, for a collection run once per row. */
  data?: string;
  running: boolean;
  error?: string;
  summary?: { label: string; value: string; bad?: boolean }[];
  results: {
    iteration: string;
    name: string;
    method: string;
    status: string;
    ok: boolean;
    time: string;
    tests: string;
    messages: string[];
  }[];
  thresholds: { name: string; value: string; passed: boolean }[];
}

/** What the runner shows of a finished run: a summary, and each send or each threshold. */
export function runnerResults(
  report: LoadReport,
): Pick<RunnerView, 'summary' | 'results' | 'thresholds'> {
  const ms = (value: number) => `${Math.round(value)} ms`;
  const summary: NonNullable<RunnerView['summary']> = [
    { label: 'Result', value: report.passed ? 'Passed' : 'Failed', bad: !report.passed },
  ];
  if (report.metrics && report.mode && report.mode !== 'collection') {
    const metrics = report.metrics;
    summary.push(
      { label: 'Requests', value: String(metrics.completed) },
      { label: 'Throughput', value: `${metrics.rps.toFixed(1)}/s` },
      {
        label: 'Errors',
        value: `${(metrics.errorRate * 100).toFixed(1)}%`,
        bad: metrics.failed > 0,
      },
      { label: 'Average', value: ms(metrics.average) },
      { label: 'p50', value: ms(metrics.p50) },
      { label: 'p95', value: ms(metrics.p95) },
      { label: 'p99', value: ms(metrics.p99) },
      { label: 'Max', value: ms(metrics.max) },
    );
  } else
    summary.push(
      { label: 'Requests', value: String(report.summary.requests) },
      { label: 'Failed', value: String(report.summary.failed), bad: report.summary.failed > 0 },
      {
        label: 'Tests',
        value: `${report.summary.tests - report.summary.testsFailed}/${report.summary.tests} passed`,
        bad: report.summary.testsFailed > 0,
      },
      { label: 'Time', value: ms(report.summary.elapsedMs) },
    );
  if (report.interrupted) summary.push({ label: 'Stopped', value: 'before the end', bad: true });
  const results = (report.results ?? []).map((result) => {
    const passed = result.tests.filter((test) => test.pass).length;
    return {
      iteration: String(result.iteration ?? 1),
      name: result.request.name,
      method: result.request.method,
      status: result.error ? 'failed' : `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
      ok: result.passed,
      time: result.durationMs === undefined ? '' : ms(result.durationMs),
      tests: result.tests.length ? `${passed}/${result.tests.length}` : '',
      messages: [
        ...(result.error ? [result.error] : []),
        ...result.tests
          .filter((test) => !test.pass)
          .map((test) => `${test.label}${test.message ? ` — ${test.message}` : ''}`),
      ],
    };
  });
  const thresholds = (report.thresholds ?? []).map((check) => ({
    name: check.name,
    value: `${check.actual} (limit ${check.limit})`,
    passed: check.passed,
  }));
  return { summary, results, thresholds };
}

/** A specification's operations, as Preview docs shows them. */
export interface DocsView {
  view: 'docs';
  name: string;
  title?: string;
  version?: string;
  errors: number;
  warnings: number;
  operations: { method: string; path: string; summary: string; deprecated: boolean }[];
}

/**
 * A table's rows as text to edit in bulk, one a line: `Name: value` (or `name=value` for
 * params), with `# ` before one that is switched off.
 */
export function rowsToText(
  rows: readonly { key: string; value: string; enabled?: boolean }[],
  separator: ': ' | '=',
): string {
  return rows
    .map((row) => `${row.enabled === false ? '# ' : ''}${row.key}${separator}${row.value}`)
    .join('\n');
}

/**
 * Rows from bulk-edited text: blank lines skipped, `# ` switching a row off where rows can be
 * switched, each split at its first separator. A line without one is a name with no value.
 */
export function rowsFromText(
  text: string,
  separator: ': ' | '=',
  toggles: boolean,
): { key: string; value: string; enabled: boolean }[] {
  const split = separator.trim();
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const off = toggles && /^\s*#/.test(line);
      const rest = off ? line.replace(/^\s*#\s?/, '') : line;
      const at = rest.indexOf(split);
      const key = (at < 0 ? rest : rest.slice(0, at)).trim();
      const value = at < 0 ? '' : rest.slice(at + split.length).replace(/^ /, '');
      return { key, value, enabled: !off };
    })
    .filter((row) => row.key || row.value);
}

/**
 * A URL in the pieces the address bar colours: `{{variables}}`, the scheme, host, path, and
 * each query parameter's name and value. Joined, they are the URL exactly.
 */
export function urlTokens(url: string): { text: string; kind?: string }[] {
  const tokens: { text: string; kind?: string }[] = [];
  const add = (text: string, kind?: string) => {
    if (!text) return;
    // A variable is a variable wherever it is.
    for (const part of text.split(/(\{\{[^{}]*\}\})/))
      if (part)
        tokens.push(/^\{\{/.test(part) ? { text: part, kind: 'variable' } : { text: part, kind });
  };
  const hash = url.indexOf('#');
  const main = hash < 0 ? url : url.slice(0, hash);
  const query = main.indexOf('?');
  const base = query < 0 ? main : main.slice(0, query);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(base)?.[0] ?? '';
  const rest = base.slice(scheme.length);
  const slash = rest.search(/\/(?![^{]*\}\})/);
  add(scheme, 'scheme');
  add(slash < 0 ? rest : rest.slice(0, slash), 'host');
  add(slash < 0 ? '' : rest.slice(slash), 'path');
  if (query >= 0) {
    add('?', 'punctuation');
    main
      .slice(query + 1)
      .split(/(&)/)
      .forEach((pair) => {
        if (pair === '&') return add('&', 'punctuation');
        const at = pair.indexOf('=');
        if (at < 0) return add(pair, 'key');
        add(pair.slice(0, at), 'key');
        add('=', 'punctuation');
        add(pair.slice(at + 1), 'value');
      });
  }
  if (hash >= 0) add(url.slice(hash), 'scheme');
  return tokens;
}
