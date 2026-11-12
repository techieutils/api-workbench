import { parseTags, tagProblem } from '@techieutils/api-workbench-common/tags';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { folderNameProblem } from '@techieutils/api-workbench-common/folders';
import { curl } from '@techieutils/api-workbench-common/collection-formats/text-formats';
import { trimHistory } from '@techieutils/api-workbench-common/history';
import type {
  ApiRequest,
  HttpResponse,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import { SECRET_NAME } from '@techieutils/api-workbench-electron/team-files';
import { UsageError, allowedHost, type Uploads } from './args';
import { readUpload } from './uploads';
import {
  defaultMQTT,
  defaultSocketIO,
  mqttTopicProblem,
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import { REQUEST_PROTOCOLS } from '@techieutils/api-workbench-common/types';
import {
  findRequest,
  json,
  nameProblem,
  one,
  positionals,
  printable,
  protocolOf,
  variableAssignment,
  type CommandContext,
  type Parsed,
} from './command-kit';
import { painter } from './report';
import { AUTH_NAMES, teamSecretsProblem, updateAuthFields } from './auth-fields';
import { syncRequestToMocks } from '@techieutils/api-workbench-common/mock-sync';
import { terminalPassword, vaultAccess } from './vault';
import { runSource, type RunResult } from './run';
import { completeRequest, sourceFromTarget } from './source';
import type { RequestTarget, Target } from './target';

/**
 * Sending one request, as the Send button does: the response's status, timing, headers, and body,
 * then its tests and captures. In one of the app's workspaces, the send is kept in History and
 * captured values go into the environment, as in the app; `--no-save` leaves the workspace as it
 * was. A team folder given with --dir is never changed by a send.
 */

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The body as text to read: JSON indented, anything else as it came. */
function readableBody(response: HttpResponse): string {
  const type =
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ??
    '';
  if (response.bodyBase64 && !/json|text|xml|javascript|yaml|html/i.test(type))
    return `<${size(response.size)} of ${type || 'binary data'}; use --body-only to save it>`;
  if (/json/i.test(type) || /^\s*[[{]/.test(response.body))
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      /* Shown as it came. */
    }
  return response.body;
}

/** The files given for a send: `--binary-file <path>`, and `--form-file <field>=<path>` each. */
async function uploadsFrom(parsed: Parsed): Promise<Uploads | undefined> {
  const binary = one(parsed, '--binary-file');
  const forms = parsed.values.get('--form-file') ?? [];
  if (binary === undefined && !forms.length) return undefined;
  const uploads: Uploads = { fields: {} };
  if (binary !== undefined) uploads.binary = await readUpload(binary);
  for (const given of forms) {
    const at = given.indexOf('=');
    if (at < 1) throw new UsageError('--form-file is <field>=<path>, such as avatar=photo.png.');
    uploads.fields[given.slice(0, at)] = await readUpload(given.slice(at + 1));
  }
  return uploads;
}

/** --allow-scripts or --skip-scripts, as `run` takes them. */
function scriptChoice(parsed: Parsed): { scripts?: 'allow' | 'skip' } {
  const allow = parsed.flags.has('--allow-scripts');
  const skip = parsed.flags.has('--skip-scripts');
  if (allow && skip) throw new UsageError('Choose --allow-scripts or --skip-scripts, not both.');
  return allow ? { scripts: 'allow' } : skip ? { scripts: 'skip' } : {};
}

export async function sendRequest(
  parsed: Parsed,
  target: RequestTarget,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const paint = painter(context.color ?? false);
  const [wanted] = positionals(parsed, ['request']);
  const request = findRequest(target.state, wanted);
  if (protocolOf(request) !== 'http')
    throw new UsageError(
      `${protocolOf(request)} requests keep a live connection, which the app opens.`,
    );
  const { state } = target;
  const environment = one(parsed, '--environment') ?? state.environments[state.environment]?.name;
  const timeout = one(parsed, '--timeout');
  if (
    timeout !== undefined &&
    !(Number.isInteger(Number(timeout)) && Number(timeout) >= 100 && Number(timeout) <= 300000)
  )
    throw new UsageError('--timeout must be a whole number of milliseconds from 100 to 300000.');
  let response: RequestResponse | undefined;
  let result: RunResult | undefined;
  // The workspace's vault, opened only if the request uses a saved credential.
  const vault = vaultAccess(
    target as RequestTarget & { dataDir?: string },
    context.password ?? terminalPassword(context.env),
  );
  const outcome = await runSource(
    { ...sourceFromTarget(target), credentials: vault.credentials },
    {
      command: 'run',
      source: '',
      collections: [],
      requests: [request.id],
      environment,
      variables: (parsed.values.get('--var') ?? []).map((text) =>
        variableAssignment(text, context.env),
      ),
      bail: false,
      insecure: parsed.flags.has('--insecure'),
      ...scriptChoice(parsed),
      ...(parsed.values.get('--allow-host')
        ? { allowedHosts: parsed.values.get('--allow-host')!.map(allowedHost) }
        : {}),
      ...(timeout !== undefined ? { timeoutMs: Number(timeout) } : {}),
      reporters: new Set(),
      color: false,
      quiet: false,
      json: false,
      ...(await uploadsFrom(parsed).then((given) =>
        given ? { uploads: { [request.id]: given } } : {},
      )),
    },
    undefined,
    context.interrupt,
    (sent, received) => {
      result = sent;
      response = received;
    },
  ).finally(() => vault.close());
  if (!result || !response) {
    output.err('Stopped before a response came.');
    return 130;
  }
  // Not sent at all: a usage matter (exit 2), as with scripts, so a caller can ask and try again.
  if (result.error?.includes('which --allow-host does not list'))
    throw new UsageError(result.error);
  const failed = response.error !== undefined;
  const http = failed ? undefined : (response as HttpResponse);

  if (parsed.flags.has('--body-only')) {
    // Exactly what came back, for piping into another program or a file. At a terminal the
    // server's text could hold escape sequences that rewrite the screen, so those are removed.
    if (failed) output.err(`api-workbench: ${result.error}`);
    else if (context.terminal) output.out(printable(http!.body));
    else if (context.writeRaw && http!.bodyBase64)
      context.writeRaw(Buffer.from(http!.bodyBase64, 'base64'));
    else output.out(http!.body);
  } else if (parsed.flags.has('--json')) {
    json(output, {
      ...result,
      ...(http
        ? {
            statusText: http.statusText,
            httpVersion: http.httpVersion,
            size: http.size,
            headers: Object.fromEntries(
              Object.entries(http.headers).map(([key, value]) => [
                key,
                SECRET_NAME.test(key) ? '<hidden>' : value,
              ]),
            ),
            body: http.body,
          }
        : {}),
      // How the time was spent — DNS, connecting, TLS, waiting, downloading — for each hop, and
      // the server's TLS connection and certificates: public details, as the app shows them.
      ...(response.timings ? { timings: response.timings } : {}),
      ...(response.tls ? { tls: response.tls } : {}),
    });
  } else {
    const status = failed
      ? paint.fail('No response')
      : (http!.status < 400 ? paint.pass : paint.fail)(
          `${http!.status} ${http!.statusText}`.trim(),
        );
    output.out(
      `${status}  ${paint.dim(`${Math.round(result.durationMs)} ms${http ? ` · ${size(http.size)}${http.httpVersion ? ` · HTTP/${http.httpVersion}` : ''}` : ''}`)}`,
    );
    output.out(paint.dim(`${request.method} ${printable(result.url)}`));
    if (failed) output.out(paint.fail(printable(result.error ?? '')));
    if (http && parsed.flags.has('--include')) {
      output.out('');
      // Cookies and tokens a server sends back are secrets of their own.
      for (const [key, value] of Object.entries(http.headers))
        output.out(
          `${paint.bold(printable(key))}: ${SECRET_NAME.test(key) ? '<hidden>' : printable(value)}`,
        );
    }
    if (http && !parsed.flags.has('--no-body')) {
      const body = readableBody(http);
      if (body) {
        output.out('');
        output.out(printable(body));
      }
    }
    if (result.tests.length) {
      output.out('');
      for (const test of result.tests)
        output.out(
          test.pass
            ? `${paint.pass('✓')} ${printable(test.name || test.label)}`
            : `${paint.fail('✗')} ${printable(test.name || test.label)}: ${printable(test.message)}`,
        );
    }
    for (const capture of result.captures)
      output.out(
        paint.dim(
          capture.error
            ? `capture ${capture.variable}: ${printable(capture.error)}`
            : `captured ${capture.variable}`,
        ),
      );
  }

  // As the app does after a send: History, and captured values in the environment.
  if (target.vaultPath && !parsed.flags.has('--no-save')) {
    let changed = false;
    const live = state.environments.find((item) => item.name === outcome.environment);
    for (const capture of result.captures) {
      const value = outcome.finalEnvironment?.variables.find(
        (item) => item.key === capture.variable,
      )?.value;
      if (capture.error || value === undefined || !live) continue;
      const existing = live.variables.find((item) => item.key === capture.variable);
      if (existing) Object.assign(existing, { value, enabled: true });
      else live.variables.push({ enabled: true, key: capture.variable, value });
      changed = true;
    }
    const settings = state.settings as
      { historyEnabled?: boolean; historyLimit?: number } | undefined;
    const limit = settings?.historyLimit ?? 100;
    if (settings?.historyEnabled !== false && limit > 0) {
      state.history.unshift({
        requestId: request.id,
        method: request.method,
        // The URL as reports show it: without its user name, password, or secret query values.
        url: result.url,
        ...(http ? { status: http.status } : {}),
        date: new Date().toISOString(),
        time: Math.round(result.durationMs),
      });
      state.history = trimHistory(state.history, limit);
      changed = true;
    }
    if (changed) await target.save();
  }
  return result.passed ? 0 : 1;
}

/** "Name: value" for -H, as curl takes it. */
function header(text: string): ApiRequest['headers'][number] {
  const colon = text.indexOf(':');
  if (colon <= 0) throw new UsageError(`A header is "Name: value": ${text}`);
  return { enabled: true, key: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() };
}

export async function createRequest(
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { state } = target;
  const [givenName] = positionals(parsed, ['name'], 1);
  let request: ApiRequest;
  const curlText = one(parsed, '--curl');
  if (curlText !== undefined) {
    // "-" reads the command from standard input, for a long one copied from a browser.
    const source = curlText === '-' ? await context.stdin() : curlText;
    const warnings: string[] = [];
    let imported;
    try {
      imported = curl(source, warnings).requests[0];
    } catch (error) {
      throw new UsageError(`The cURL command could not be read: ${(error as Error).message}`);
    }
    if (!imported) throw new UsageError('The cURL command has no request.');
    for (const warning of warnings) context.output.err(`warning: ${warning}`);
    request = completeRequest(imported);
  } else {
    const url = one(parsed, '--url');
    if (!url) throw new UsageError('Give --url, or --curl with a cURL command.');
    const bodyFile = one(parsed, '--body-file');
    request = completeRequest({
      method: (one(parsed, '--method') ?? 'GET').toUpperCase(),
      url,
      headers: (parsed.values.get('--header') ?? []).map(header),
      body: bodyFile
        ? await fs.readFile(bodyFile, 'utf8').catch(() => {
            throw new UsageError(`${bodyFile} could not be read.`);
          })
        : (one(parsed, '--body') ?? ''),
    });
    if (request.body) {
      request.bodyType = 'raw';
      const type = request.headers.find((item) => item.key.toLowerCase() === 'content-type')?.value;
      request.rawContentType =
        type ?? (/^\s*[[{]/.test(request.body) ? 'application/json' : 'text/plain');
    }
  }
  if (!/^[A-Z]+$/.test(request.method))
    throw new UsageError(`“${request.method}” is not an HTTP method.`);
  const protocol = one(parsed, '--protocol');
  if (protocol !== undefined) {
    if (!(REQUEST_PROTOCOLS as readonly string[]).includes(protocol))
      throw new UsageError(`--protocol is ${REQUEST_PROTOCOLS.join(', ')}.`);
    if (curlText !== undefined && protocol !== 'http')
      throw new UsageError('A cURL command makes an HTTP request.');
    // A live request starts with its protocol's settings, as choosing its type in the app does;
    // a gRPC call gets its .proto schema and method in its settings.
    if (protocol !== 'http') request.protocol = protocol as ApiRequest['protocol'];
    if (protocol === 'socketio') request.socketio = defaultSocketIO();
    if (protocol === 'mqtt') request.mqtt = defaultMQTT();
    if (protocol === 'grpc') request.grpc = { proto: '', method: '', tls: false };
  }
  const folder = (one(parsed, '--collection') ?? (curlText !== undefined ? 'Imported' : '')).trim();
  if (!folder) throw new UsageError('Give the collection or folder for it with -c.');
  for (const part of folder.split('/')) {
    const problem = folderNameProblem(part);
    if (problem) throw new UsageError(problem);
  }
  request.folder = folder;
  if (givenName) request.name = givenName.trim();
  else if (curlText === undefined) request.name = 'Untitled request';
  else {
    // An import names it “cURL 1”; its method and path say more.
    let where = request.url;
    try {
      where = new URL(request.url).pathname;
    } catch {
      /* A URL with {{variables}} is named as written. */
    }
    request.name = `${request.method} ${where}`.slice(0, 100);
  }
  nameProblem(request.name, 'request');
  const tags: string[] = [];
  for (const tag of (parsed.values.get('--tag') ?? []).flatMap(parseTags)) {
    const problem = tagProblem(tag, tags);
    if (problem) throw new UsageError(`--tag ${tag}: ${problem}`);
    tags.push(tag);
  }
  if (tags.length) request.tags = tags;
  if (state.requests.some((item) => item.id === request.id)) request.id = randomUUID();
  state.requests.push(request);
  // A mock made from this collection answers the new request too.
  const mocks = syncRequestToMocks(state.mocks ?? [], request);
  await target.save();
  if (parsed.flags.has('--json'))
    json(context.output, {
      id: request.id,
      name: request.name,
      folder,
      ...(mocks.length ? { mocks: mocks.map((mock) => mock.name) } : {}),
    });
  else
    context.output.out(
      `Created “${printable(request.name)}” in “${printable(folder)}” (${request.id}).${
        mocks.length
          ? ` Added to the mock server${mocks.length === 1 ? '' : 's'} ${mocks.map((mock) => `“${printable(mock.name)}”`).join(', ')}.`
          : ''
      }`,
    );
  return 0;
}

/**
 * `request update`: changes a saved request's name, method, URL, headers, or body, as editing it
 * in the app does. `-H` adds a header or replaces the one of that name, keeping whether it is on;
 * headers not named stay as they are, so a value the command line hides is never written back.
 */
export async function updateRequest(
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { state } = target;
  const [wanted] = positionals(parsed, ['request']);
  const request = findRequest(state, wanted);
  // As it was, so a mock made from its collection can follow what changed.
  const before = structuredClone(request);
  const name = one(parsed, '--name');
  if (name !== undefined) {
    nameProblem(name.trim(), 'request');
    request.name = name.trim();
  }
  const method = one(parsed, '--method');
  if (method !== undefined) {
    if (!/^[A-Za-z]+$/.test(method)) throw new UsageError(`“${method}” is not an HTTP method.`);
    request.method = method.toUpperCase();
  }
  const url = one(parsed, '--url');
  if (url !== undefined) request.url = url;
  const unset = new Set(
    (parsed.values.get('--unset-header') ?? []).map((key) => key.trim().toLowerCase()),
  );
  if (unset.size)
    request.headers = request.headers.filter((item) => !unset.has(item.key.trim().toLowerCase()));
  for (const text of parsed.values.get('--header') ?? []) {
    const given = header(text);
    const existing = request.headers.find(
      (item) => item.key.trim().toLowerCase() === given.key.toLowerCase(),
    );
    if (existing) {
      existing.key = given.key;
      existing.value = given.value;
    } else request.headers.push(given);
  }
  // A header can be kept but not sent, as its check box in the app does.
  for (const [flag, enabled] of [
    ['--enable-header', true],
    ['--disable-header', false],
  ] as const)
    for (const name of parsed.values.get(flag) ?? []) {
      const found = request.headers.filter(
        (item) => item.key.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (!found.length)
        throw new UsageError(`${request.name} has no header “${printable(name)}”.`);
      for (const item of found) item.enabled = enabled;
    }
  const bodyFile = one(parsed, '--body-file');
  const body = one(parsed, '--body');
  const given = [bodyFile !== undefined, body !== undefined, parsed.flags.has('--no-body')];
  if (given.filter(Boolean).length > 1)
    throw new UsageError('Give one of --body, --body-file, and --no-body.');
  if (parsed.flags.has('--no-body')) {
    request.body = '';
    request.bodyType = 'none';
  } else if (bodyFile !== undefined || body !== undefined) {
    request.body =
      bodyFile !== undefined
        ? await fs.readFile(bodyFile, 'utf8').catch(() => {
            throw new UsageError(`${bodyFile} could not be read.`);
          })
        : (body ?? '');
    // Text replaces a form or file body as a raw body, as choosing Raw does in the app.
    request.bodyType = request.body ? 'raw' : 'none';
    if (request.bodyType === 'raw' && !request.rawContentType) {
      const type = request.headers.find((item) => item.key.toLowerCase() === 'content-type')?.value;
      request.rawContentType =
        type ?? (/^\s*[[{]/.test(request.body) ? 'application/json' : 'text/plain');
    }
  }
  for (const [flag, phase] of [
    ['--pre-script-file', 'pre'],
    ['--post-script-file', 'post'],
  ] as const) {
    const file = one(parsed, flag);
    if (file === undefined) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => {
      throw new UsageError(`${file} could not be read.`);
    });
    // Saving never runs a script: it is trusted only where it runs, as an edited one is anew.
    const scripts = { ...request.scripts, [phase]: text.trim() ? text : undefined };
    if (scripts.pre || scripts.post) request.scripts = scripts;
    else delete request.scripts;
  }
  await updateLiveSettings(request, parsed);
  updateAuth(request, parsed, context);
  await updateForm(request, parsed, context);
  const tests = one(parsed, '--tests');
  if (tests !== undefined) request.tests = tests.replace(/\r\n/g, '\n').trim();
  const tagList = parsed.values.get('--tag');
  if (tagList && parsed.flags.has('--no-tags'))
    throw new UsageError('Give --tag or --no-tags, not both.');
  if (parsed.flags.has('--no-tags')) delete request.tags;
  else if (tagList) {
    const tags: string[] = [];
    for (const tag of tagList.flatMap(parseTags)) {
      const problem = tagProblem(tag, tags);
      if (problem) throw new UsageError(`--tag ${tag}: ${problem}`);
      tags.push(tag);
    }
    if (tags.length) request.tags = tags;
    else delete request.tags;
  }
  const captures = parsed.values.get('--capture');
  if (captures && parsed.flags.has('--no-captures'))
    throw new UsageError('Give --capture or --no-captures, not both.');
  if (parsed.flags.has('--no-captures')) request.captures = [];
  else if (captures)
    // "name=from", such as "orderId=body.id": the variable, and where its value comes from.
    request.captures = captures.map((text) => {
      const at = text.indexOf('=');
      const key = (at < 0 ? '' : text.slice(0, at)).trim();
      const value = at < 0 ? '' : text.slice(at + 1).trim();
      if (!key || !value || /[{}\s]/.test(key))
        throw new UsageError(`A capture is "name=from", such as "orderId=body.id": ${text}`);
      return { enabled: true, key, value };
    });
  teamSecretsProblem(target, request);
  syncRequestToMocks(state.mocks ?? [], request, before);
  await target.save();
  await target.keepAuthSecrets?.(request);
  // A team folder open in the app keeps the choice with this device's secrets, never the folder.
  const credential = one(parsed, '--credential');
  if (credential !== undefined && target.keepCredential)
    await target.keepCredential({ request: request.id }, credential || undefined);
  if (parsed.flags.has('--json'))
    json(context.output, { id: request.id, name: request.name, folder: request.folder });
  else context.output.out(`Updated “${printable(request.name)}”.`);
  return 0;
}

/**
 * A request's auth from `request update`. Tokens, passwords, and other secrets come from
 * environment variables, so they are never arguments.
 */
function updateAuth(request: ApiRequest, parsed: Parsed, context: CommandContext): void {
  const given = one(parsed, '--auth');
  if (given !== undefined) {
    const type = AUTH_NAMES[given.toLowerCase()];
    if (!type) throw new UsageError(`--auth is ${Object.keys(AUTH_NAMES).join(', ')}.`);
    request.auth = type;
  }
  const username = one(parsed, '--auth-username');
  if (username !== undefined) request.username = username;
  const variable = one(parsed, '--auth-secret-from-env');
  if (variable !== undefined) {
    const secret = context.env[variable];
    if (secret === undefined)
      throw new UsageError(`The environment variable ${variable} is not set.`);
    // A bearer token, an API key's value, or an OAuth 2.0 access token is the token; the rest
    // (a password, a JWT's signing key, AWS's secret key, …) is the password.
    if (['Bearer token', 'API key', 'OAuth 2.0 (request)'].includes(request.auth))
      request.token = secret;
    else request.password = secret;
  }
  const fields = one(parsed, '--auth-fields-from-env');
  if (fields !== undefined) {
    if (context.env[fields] === undefined)
      throw new UsageError(`The environment variable ${fields} is not set.`);
    updateAuthFields(request, context.env[fields]);
  }
  const where = one(parsed, '--api-key-in');
  if (where !== undefined) {
    if (where !== 'header' && where !== 'query')
      throw new UsageError('--api-key-in is header or query.');
    request.authOptions = { ...request.authOptions, apiKeyIn: where };
  }
  const credential = one(parsed, '--credential');
  if (credential !== undefined) {
    if (!/^[\w.-]{1,200}$/.test(credential)) throw new UsageError('--credential is an id.');
    request.credentialId = credential;
  }
  if (request.auth === 'API key' && given !== undefined && !request.username)
    throw new UsageError('An API key needs its header or parameter name: --auth-username.');
}

const BODY_TYPES = ['none', 'raw', 'form-data', 'x-www-form-urlencoded', 'binary'] as const;

/**
 * A request's body type, and its form's text fields from standard input (`--form-fields -`), as
 * JSON, since their values can be secrets. A value still `<hidden>` keeps the field's own; file
 * fields are chosen in the app and kept as they are.
 */
async function updateForm(
  request: ApiRequest,
  parsed: Parsed,
  context: CommandContext,
): Promise<void> {
  const type = one(parsed, '--body-type');
  if (type !== undefined) {
    if (!(BODY_TYPES as readonly string[]).includes(type))
      throw new UsageError(`--body-type is ${BODY_TYPES.join(', ')}.`);
    request.bodyType = type as ApiRequest['bodyType'];
  }
  // The name of the file a file body sends, chosen with each send (`request send --binary-file`).
  const binaryName = one(parsed, '--binary-name');
  if (binaryName !== undefined) {
    if (/[\r\n/\\]/.test(binaryName) || binaryName.length > 255)
      throw new UsageError('--binary-name is a file name.');
    if (binaryName) request.binaryName = binaryName;
    else delete request.binaryName;
  }
  const from = one(parsed, '--form-fields');
  if (from === undefined) return;
  if (from !== '-') throw new UsageError('--form-fields - reads the fields from standard input.');
  let fields: unknown;
  try {
    fields = JSON.parse(await context.stdin());
  } catch {
    throw new UsageError(
      '--form-fields reads JSON: [{"key": "…", "value": "…", "enabled": true}].',
    );
  }
  if (!Array.isArray(fields) || fields.length > 500)
    throw new UsageError('--form-fields reads a list of fields.');
  const existing = request.bodyFields ?? [];
  // A list that says each field's kind is the whole form, file fields included, in order; one
  // without kinds is its text fields, and the file fields stay as they are.
  const whole = fields.some((field) => field && typeof field === 'object' && 'kind' in field);
  const given = fields.map((field: unknown): NonNullable<ApiRequest['bodyFields']>[number] => {
    const { key, value, enabled, kind, fileName } = (field ?? {}) as Record<string, unknown>;
    if (typeof key !== 'string' || /[\r\n]/.test(key))
      throw new UsageError('Each form field has a key, as text.');
    if (kind === 'file') {
      if (fileName !== undefined && (typeof fileName !== 'string' || /[\r\n/\\]/.test(fileName)))
        throw new UsageError('A file field’s fileName is a file name.');
      const old = existing.find((item) => item.kind === 'file' && item.key === key);
      return {
        enabled: enabled !== false,
        key,
        value: '',
        kind: 'file',
        ...(old?.fileId ? { fileId: old.fileId } : {}),
        ...(fileName ? { fileName } : old?.fileName ? { fileName: old.fileName } : {}),
      };
    }
    if (kind !== undefined && kind !== 'text')
      throw new UsageError('A form field’s kind is text or file.');
    if (typeof value !== 'string') throw new UsageError('Each form field has a value, as text.');
    const old = existing.find((item) => item.kind !== 'file' && item.key === key);
    return {
      enabled: enabled !== false,
      key,
      value: value === '<hidden>' && old ? old.value : value,
      kind: 'text',
    };
  });
  request.bodyFields = whole
    ? given
    : [...given, ...existing.filter((field) => field.kind === 'file')];
}

/**
 * A live request's settings from `--settings-file`: its gRPC schema, method, and TLS; Socket.IO
 * path, event, and acknowledgement; or MQTT connection, subscriptions, and publishing. Each is
 * checked as the app checks an imported one, and must match the request's protocol.
 */
async function updateLiveSettings(request: ApiRequest, parsed: Parsed): Promise<void> {
  const file = one(parsed, '--settings-file');
  if (file === undefined) return;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new UsageError(`${file} is not a JSON file of settings.`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new UsageError('The settings file holds an object, such as {"grpc": {…}}.');
  const protocol = protocolOf(request);
  for (const key of Object.keys(settings)) {
    if (!['grpc', 'socketio', 'mqtt'].includes(key))
      throw new UsageError(`Settings are for gRPC, Socket.IO, or MQTT requests, not ${key}.`);
    if (key !== protocol)
      throw new UsageError(`${request.name} is a ${protocol} request; it has no ${key} settings.`);
  }
  if (protocol === 'grpc' && settings.grpc) {
    const given = settings.grpc as Record<string, unknown>;
    const proto = given.proto ?? request.grpc?.proto ?? '';
    const method = given.method ?? request.grpc?.method ?? '';
    if (typeof proto !== 'string' || Buffer.byteLength(proto) > 1024 * 1024)
      throw new UsageError('The .proto schema is text of up to 1 MiB.');
    if (typeof method !== 'string' || method.length > 1024 || /[\r\n]/.test(method))
      throw new UsageError('The gRPC method is a path such as /shop.Orders/Watch.');
    request.grpc = {
      proto,
      method,
      tls: given.tls === undefined ? Boolean(request.grpc?.tls) : given.tls === true,
    };
  } else if (protocol === 'socketio' && settings.socketio)
    request.socketio = normalizedSocketIO({
      ...request.socketio,
      ...(settings.socketio as object),
    });
  else if (protocol === 'mqtt' && settings.mqtt) {
    const mqtt = normalizedMQTT({ ...request.mqtt, ...(settings.mqtt as object) })!;
    for (const row of mqtt.subscriptions) {
      const problem = mqttTopicProblem(row.topic, true);
      if (problem) throw new UsageError(problem);
    }
    const problem = mqtt.topic ? mqttTopicProblem(mqtt.topic, false) : undefined;
    if (problem) throw new UsageError(problem);
    request.mqtt = mqtt;
  }
}
