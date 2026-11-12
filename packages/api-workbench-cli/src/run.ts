import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from '@techieutils/api-workbench-common/folders';
import {
  run as runAssertions,
  type AssertionResult,
} from '@techieutils/api-workbench-common/assertions';
import * as runner from '@techieutils/api-workbench-common/runner';
import { effectiveAuth, preparePayload } from '@techieutils/api-workbench-common/request-payload';
import {
  parseRunData,
  withRowValues,
  type RunData,
} from '@techieutils/api-workbench-common/run-data';
import {
  captureAll,
  dynamicValue,
  readsFailures,
} from '@techieutils/api-workbench-common/variables';
import { storeCookies, type StoredCookie } from '@techieutils/api-workbench-common/cookies';
import type {
  ApiRequest,
  Environment,
  HttpResponse,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import { sendHttpRequest } from '@techieutils/api-workbench-electron/http';
import { vaultCertificate } from '@techieutils/api-workbench-electron/vault-certificates';
import type { LoadedClientCertificate } from '@techieutils/api-workbench-electron/client-certificates';
import {
  certificatePayload,
  matchClientCertificate,
} from '@techieutils/api-workbench-common/client-certificates';
import { withCredential } from '@techieutils/api-workbench-electron/credentials';
import { runScript } from '@techieutils/api-workbench-common/script-engine';
import {
  describeTagFilter,
  effectiveTags,
  matchesTags,
  sameTag,
  tagCounts,
  tagFilterActive,
} from '@techieutils/api-workbench-common/tags';
import {
  allScriptSteps,
  applyScriptVariables,
  runScriptSteps,
  scriptAssertions,
  scriptSteps,
  stepScope,
  scriptRequestOf,
  scriptResponseOf,
  scriptHostProblem,
  withScriptRequest,
  type ScriptLog,
  type ScriptPhase,
  type StepResult,
} from '@techieutils/api-workbench-common/scripts';
import { SECRET_NAME, sharedURL } from '@techieutils/api-workbench-electron/team-files';
import {
  UsageError,
  hostAllowed,
  hostNotAllowed,
  urlHost,
  suggest,
  type RunOptions,
  type Uploads,
} from './args';
import { readProjectUpload, uploadsFromFile } from './uploads';
import type { FileUploads, Source } from './source';

/** One request sent: what came back and how its tests went. */
export interface RunResult {
  sequence: number;
  iteration: number;
  request: { id: string; name: string; method: string; folder: string };
  /** The URL sent, with credentials and secret query values left out. */
  url: string;
  status?: number;
  durationMs: number;
  error?: string;
  tests: AssertionResult[];
  captures: { variable: string; error?: string }[];
  /** What the request's scripts wrote with console.log, in order. */
  logs?: { phase: ScriptPhase; level: ScriptLog['level']; message: string }[];
  passed: boolean;
}
export interface RunOutcome {
  source: Source;
  environment?: string;
  data?: RunData;
  requests: ApiRequest[];
  results: RunResult[];
  report: runner.RunnerReport;
  /** The tag filter the requests were chosen by, in words, when there was one. */
  tags?: string;
  /** Requests chosen but not sent because --bail stopped the run. */
  skipped: number;
  bailed: boolean;
  /** The run was stopped from outside, by Ctrl+C. */
  interrupted: boolean;
  /** The environment as the run left it, with captured values, for `request send --save`. */
  finalEnvironment?: Environment;
}
/** What a load test (benchmark or performance run) says about its run, beyond the defaults. */
export type LoadOptions = Partial<
  Pick<
    runner.RunnerConfig,
    | 'mode'
    | 'concurrency'
    | 'durationSeconds'
    | 'targetRps'
    | 'rampUpSeconds'
    | 'warmupIterations'
    | 'maxRequests'
    | 'p95LimitMs'
    | 'maxErrorRate'
    | 'minRps'
  >
>;

/**
 * A test as reports and logs show it. Messages carry the value the response had, which is what
 * makes a failure clear, so they are kept for failures only, and left out when the test reads
 * something secret-looking (a token, password, or Authorization header), as CI logs are widely read.
 */
function reportedTest(test: AssertionResult): AssertionResult {
  if (test.pass) return { ...test, message: '' };
  return SECRET_NAME.test(`${test.label} ${test.name ?? ''}`)
    ? { ...test, message: 'Failed. The value is not shown, as it may be a secret.' }
    : test;
}
/** The requests to run: HTTP requests in the chosen collections and names, in explorer order. */
export function selectRequests(
  source: Source,
  options: Pick<RunOptions, 'collections' | 'requests' | 'tags'>,
) {
  const http = source.workspace.requests.filter(
    (request) => !request.protocol || request.protocol === 'http',
  );
  for (const collection of options.collections)
    if (!http.some((request) => isWithin(request.folder, collection))) {
      // Every folder path, so “Users/Admn” can suggest “Users/Admin”.
      const folders = http.flatMap((request) =>
        request.folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')),
      );
      throw new UsageError(
        `No collection or folder “${collection}”.${suggest(collection, folders)} Collections: ${[...new Set(http.map((request) => request.folder.split('/')[0]))].join(', ') || 'none'}.`,
      );
    }
  const chosen = http.filter(
    (request) =>
      (!options.collections.length ||
        options.collections.some((collection) => isWithin(request.folder, collection))) &&
      (!options.requests.length ||
        options.requests.some((name) => name === request.id || name === request.name)),
  );
  for (const name of options.requests)
    if (!chosen.some((request) => request.id === name || request.name === name))
      throw new UsageError(
        `No request named “${name}” in the chosen collections.${suggest(
          name,
          http.map((request) => request.name),
        )}`,
      );
  if (!chosen.length) throw new UsageError('There are no HTTP requests to run.');
  if (!tagFilterActive(options.tags)) return chosen;
  const filter = options.tags!;
  // A tag no chosen request has is likely a typo: say so, with the tags there are.
  // A request's tags include its collection's and folders'.
  const tagsOf = (request: ApiRequest) => effectiveTags(source.workspace, request);
  const known = tagCounts(chosen.map((request) => ({ tags: tagsOf(request) }))).map(
    (entry) => entry.tag,
  );
  for (const tag of [...filter.include, ...filter.exclude])
    if (!known.some((other) => sameTag(other, tag)))
      throw new UsageError(
        `No request in the chosen collections is tagged “${tag}”.${suggest(tag, known)} Tags: ${known.join(', ') || 'none'}.`,
      );
  const tagged = chosen.filter((request) => matchesTags(tagsOf(request), filter));
  if (!tagged.length) throw new UsageError(`No request is tagged ${describeTagFilter(filter)}.`);
  return tagged;
}
/** The environment by name, with --var values set on a copy. */
export function chooseEnvironment(
  source: Source,
  options: Pick<RunOptions, 'environment' | 'variables'>,
): Environment | undefined {
  const environments = source.workspace.environments;
  const found = options.environment
    ? environments.find((environment) => environment.name === options.environment)
    : environments[0];
  if (options.environment && !found)
    throw new UsageError(
      `No environment “${options.environment}”.${suggest(
        options.environment,
        environments.map((item) => item.name),
      )} Environments: ${environments.map((item) => item.name).join(', ') || 'none'}.`,
    );
  const environment: Environment = structuredClone(
    found ?? { name: 'Command line', variables: [] },
  );
  for (const [key, value] of options.variables) {
    const existing = environment.variables.find((variable) => variable.key === key);
    if (existing) Object.assign(existing, { value, enabled: true });
    else environment.variables.push({ enabled: true, key, value });
  }
  return found || options.variables.length ? environment : undefined;
}

/** A run's data file (`-d`), read and parsed; undefined without one. */
async function readRunData(file: string | undefined): Promise<RunData | undefined> {
  if (!file) return undefined;
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new UsageError(`The data file ${file} could not be read.`);
  }
  try {
    return parseRunData(path.basename(file), text);
  } catch (error) {
    throw new UsageError(`${file}: ${(error as Error).message}`);
  }
}
/** Fills in `{{variables}}`: a data row's values first, then the environment, then built-ins. */
function resolver(
  scope: Pick<Environment, 'variables'>,
  row: () => Record<string, string> | undefined,
): (value: string) => string {
  return (value) =>
    String(value).replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const name = key.trim();
      const values = row();
      if (values && Object.hasOwn(values, name)) return values[name];
      return (
        scope.variables.find((variable) => variable.enabled && variable.key === name)?.value ??
        dynamicValue(name) ??
        match
      );
    });
}

/** Where a run's requests would go: each host once, and requests whose host is not yet known. */
export interface RunHosts {
  hosts: string[];
  /** Requests whose host comes from a value only a run makes, such as an earlier capture. */
  unresolved: { request: string; url: string }[];
}
/**
 * The hosts the chosen requests would go to, for every data row, with the run's environment and
 * `-v` values, without sending anything or running scripts (which cannot change a request's
 * host). A caller can ask about them before the run, as VS Code does; `--allow-host` still
 * checks each request as it is sent.
 */
export async function runHosts(source: Source, options: RunOptions): Promise<RunHosts> {
  const requests = selectRequests(source, options);
  const scope = chooseEnvironment(source, options) ?? { name: '', variables: [] };
  const data = await readRunData(options.data);
  const hosts = new Set<string>();
  const unresolved = new Map<string, { request: string; url: string }>();
  for (const row of data?.rows ?? [undefined]) {
    const resolve = resolver(scope, () => row);
    for (const request of requests) {
      const url = resolve(request.url);
      const host = /\{\{/.test(url) ? undefined : urlHost(url);
      if (host) hosts.add(host);
      else unresolved.set(request.id, { request: request.name, url: request.url });
    }
  }
  return { hosts: [...hosts].sort(), unresolved: [...unresolved.values()] };
}

/**
 * Runs the chosen requests in order, once per iteration or data row, with their tests and
 * captures, as a collection run in the app does. A request passes when its tests pass; one
 * without tests passes when its status is in the 200–399 success range.
 */
export async function runSource(
  source: Source,
  options: RunOptions,
  /** Called as each request finishes, with the data file the run reads its rows from. */
  onResult?: (result: RunResult, data: RunData | undefined) => void,
  /** Aborted to stop the run early, as Ctrl+C does; requests that finished are still reported. */
  interrupt?: AbortSignal,
  /** Called with each response as it came back, for `request send` to show it. */
  onResponse?: (result: RunResult, response: RequestResponse) => void,
): Promise<RunOutcome> {
  const requests = selectRequests(source, options);
  const environment = chooseEnvironment(source, options);
  // The files requests send: given to `request send`, or named in `run --uploads`.
  const uploads =
    options.uploads ??
    (options.uploadsFile
      ? await uploadsFromFile(options.uploadsFile, source.workspace.requests)
      : undefined);
  // Scripts run code from the workspace, so a run with them says whether to run them. As in the
  // app, they run in collection runs; a load test sends requests as they are prepared.
  const scripted = requests.filter((request) => allScriptSteps(source.workspace, request).length);
  if (scripted.length && !options.scripts && !options.load)
    throw new UsageError(
      `${scripted.length === 1 ? 'A request has' : `${scripted.length} requests have`} scripts (${scripted
        .slice(0, 3)
        .map((request) => request.name)
        .join(
          ', ',
        )}${scripted.length > 3 ? ', …' : ''}). Add --allow-scripts to run them, or --skip-scripts to run without them.`,
    );
  const runScripts = options.scripts === 'allow' && !options.load;
  // Variables scripts set: the environment's, or the run's own when it has none.
  const scope = environment ?? { name: '', variables: [] };
  const data = await readRunData(options.data);
  const settings = {
    ...source.workspace.settings,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    httpSettings: {
      ...source.workspace.settings?.httpSettings,
      ...(options.insecure ? { verifyTLS: false } : {}),
    },
  } as NonNullable<Source['workspace']['settings']>;
  const workspace = { ...source.workspace, settings };
  let row: Record<string, string> | undefined;
  const resolve = resolver(scope, () => row);
  let jar: StoredCookie[] = [];
  const requestMap = new Map(requests.map((request) => [request.id, request]));
  const results: RunResult[] = [];
  const controller = new AbortController();
  let bailed = false;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    controller.abort();
  };
  if (interrupt?.aborted) stop();
  interrupt?.addEventListener('abort', stop, { once: true });
  const load = options.load;
  const config: runner.RunnerConfig = {
    ...runner.defaults,
    mode: 'collection',
    iterations: data ? data.rows.length : (options.iterations ?? 1),
    delayMs: options.delayMs ?? 0,
    // Without a limit of its own, a load test passes on its error rate alone, as in the app.
    ...(load ? { p95LimitMs: 0, ...load } : {}),
    // A target rate means the rate model: requests start on schedule, whatever is in flight.
    ...(load?.targetRps ? { loadModel: 'rate' as const } : {}),
    // A collection run stops itself (below), so the runner only stops a load test.
    stopOnFailure: Boolean(load) && options.bail,
  };
  // Checked first, so a mistyped setting is a usage mistake rather than a failed run.
  try {
    runner.validateConfig(
      config,
      requests.map(({ id, name, method }) => ({ id, name, method })),
    );
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const report = await runner.run(
    config,
    requests.map(({ id, name, method }) => ({ id, name, method })),
    {
      signal: controller.signal,
      send: async (task, context) => {
        const request = requestMap.get(task.id)!;
        const iteration = Math.floor((context.sequence - 1) / requests.length) + 1;
        row = data?.rows[iteration - 1];
        const started = performance.now();
        let response: RequestResponse;
        let url = sharedURL(resolve(request.url));
        const logs: NonNullable<RunResult['logs']> = [];
        const scriptVariables = () => {
          const values: Record<string, string> = {};
          for (const variable of scope.variables)
            if (variable.enabled && variable.key) values[variable.key] = variable.value;
          return { ...values, ...row };
        };
        // The collection's and folders' scripts, then the request's, in order.
        const runPhase = (phase: ScriptPhase, received?: HttpResponse) =>
          runScriptSteps(scriptSteps(workspace, request, phase), {
            request: scriptRequestOf(request),
            ...(received ? { response: scriptResponseOf(received) } : {}),
            variables: scriptVariables,
            // The command line has no allow list: --allow-scripts allows the library too.
            run: (input) => runScript({ ...input, libraries: workspace.scriptLibrary }),
            applied: ({ step, output }) => {
              applyScriptVariables(scope.variables, output.variables);
              const where = stepScope(step);
              logs.push(
                ...output.logs.map((line) => ({
                  phase,
                  ...line,
                  ...(where ? { message: `${where}: ${line.message}` } : {}),
                })),
              );
            },
          });
        let sent = request;
        let pre: StepResult[] = [];
        try {
          // Pre-request scripts run first: their variables resolve in the request, and their
          // changes apply to a copy of it.
          if (runScripts) {
            const ran = await runPhase('pre');
            pre = ran.results;
            if (ran.failed) {
              const where = stepScope(ran.failed.step);
              throw new Error(
                `${where ? `${where} pre-request` : 'Pre-request'} script failed: ${ran.failed.output.error}`,
              );
            }
            if (ran.request) sent = withScriptRequest(request, ran.request);
          }
          // A saved credential comes from the app's vault, opened with its password; team folders
          // and files keep none.
          const usesVault = effectiveAuth(workspace, sent).auth === 'Saved credential';
          if (usesVault && !source.credentials)
            throw new Error(
              `${request.auth === 'Inherit from collection' ? 'This request inherits' : 'This request uses'} a saved credential, which lives in the app’s vault: run it from one of the app’s workspaces (-w), or a team folder the app on this computer has open, with API_WORKBENCH_VAULT_PASSWORD; or put the secret in a variable and set it with --var.`,
            );
          // The files given for it (flags, --uploads), over those its .http file names.
          const files = await requestUploads(
            uploads?.[request.id],
            source.fileUploads?.[request.id],
            sent,
            resolve,
          );
          sent = withUploads(sent, files);
          let payload = preparePayload(sent, {
            workspace,
            resolve,
            cookieJar: source.workspace.cookies ? jar : undefined,
            // Files given for this send; a form field's is found by the id given to it above.
            upload: (id) => (id === sent.id ? files?.binary : uploadFor(sent, id, files)),
            // The workspace's client certificate for the host, as the app presents it.
            clientCertificate: (address) => {
              const match = matchClientCertificate(source.workspace.clientCertificates, address);
              return match ? certificatePayload(match) : undefined;
            },
          });
          // Scripts may not move the request to another host; `url` is where it went before them.
          const moved = pre.length ? scriptHostProblem(url, payload.url) : undefined;
          if (moved) throw new Error(moved);
          // Where it goes once variables and scripts have done their work, so a variable or a
          // script cannot take it somewhere --allow-host does not name.
          if (options.allowedHosts && !hostAllowed(payload.url, options.allowedHosts))
            throw new Error(hostNotAllowed(payload.url));
          url = sharedURL(payload.url);
          // Applied after `url` is kept for the report, so a key sent in the query never shows.
          if (usesVault && payload.credentialId) {
            const record = await source.credentials!.get(payload.credentialId);
            if (record.external)
              throw new Error(
                'This credential’s secret is kept by an external provider, which the app reads. Send it from the app.',
              );
            payload = withCredential(payload, record);
          }
          const certificate = await requestCertificate(payload, source.credentials);
          // A request in flight is cancelled with the run, so Ctrl+C does not wait for it.
          const sending = new AbortController();
          const cancel = () => sending.abort();
          controller.signal.addEventListener('abort', cancel, { once: true });
          try {
            response = await sendHttpRequest(payload, sending, undefined, certificate);
          } finally {
            controller.signal.removeEventListener('abort', cancel);
          }
        } catch (error) {
          response = { error: (error as Error).message };
        }
        // Cut short by Ctrl+C, it neither passed nor failed: it is counted as skipped.
        if (interrupted) return { response, testsPassed: 0, testsTotal: 0, error: 'Interrupted' };
        if (response.error === undefined && source.workspace.cookies && response.setCookies?.length)
          jar = storeCookies(jar, response.setCookies);
        const tests =
          response.error === undefined
            ? runAssertions(
                row ? withRowValues(request.tests, row) : request.tests,
                response as HttpResponse,
              )
            : [];
        // Captures feed later requests, as in the app; a failed request runs only those that read the failure.
        const rows = (request.captures ?? []).filter(
          (capture) => response.error === undefined || readsFailures(capture.value),
        );
        const captured = rows.some((capture) => capture.enabled && capture.key)
          ? captureAll(rows, response)
          : [];
        for (const capture of captured) {
          if (capture.value === undefined) continue;
          const existing = scope.variables.find((variable) => variable.key === capture.variable);
          if (existing) Object.assign(existing, { value: capture.value, enabled: true });
          else scope.variables.push({ enabled: true, key: capture.variable, value: capture.value });
        }
        // The post-response script runs last, so it reads the values captures just stored.
        const post =
          runScripts && response.error === undefined
            ? (await runPhase('post', response as HttpResponse)).results
            : [];
        for (const { step, output } of [...pre, ...post])
          tests.push(
            ...scriptAssertions(
              step.phase,
              step.phase === 'pre' ? { ...output, ok: true } : output,
              stepScope(step),
            ),
          );
        const status = response.error === undefined ? response.status : undefined;
        const passed =
          response.error === undefined &&
          (tests.length ? tests.every((test) => test.pass) : status! >= 200 && status! <= 399);
        const result: RunResult = {
          sequence: context.sequence,
          iteration,
          request: {
            id: request.id,
            name: request.name,
            method: request.method,
            folder: request.folder,
          },
          url,
          status,
          durationMs: performance.now() - started,
          ...(response.error !== undefined
            ? { error: response.error.split(url).join('<request URL>') }
            : {}),
          tests: tests.map(reportedTest),
          captures: captured.map((capture) => ({
            variable: capture.variable,
            ...(capture.error ? { error: capture.error } : {}),
          })),
          ...(logs.length ? { logs } : {}),
          passed,
        };
        results.push(result);
        onResponse?.(result, response);
        onResult?.(result, data);
        if (!passed && options.bail && config.mode === 'collection') {
          bailed = true;
          controller.abort();
        }
        return {
          response,
          testsPassed: tests.filter((test) => test.pass).length,
          testsTotal: tests.length,
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },
  );
  interrupt?.removeEventListener('abort', stop);
  return {
    source,
    environment: environment?.name,
    ...(tagFilterActive(options.tags) ? { tags: describeTagFilter(options.tags!) } : {}),
    data,
    requests,
    results,
    report,
    // A load test sends as many as its time allows, so nothing is left over.
    skipped:
      config.mode === 'collection' ? config.iterations * requests.length - results.length : 0,
    bailed: bailed || (config.mode !== 'collection' && report.reason === 'failure'),
    interrupted,
    finalEnvironment: environment,
  };
}

/**
 * The client certificate a request presents: from the app's vault, checked against the request's
 * host, as the app does. One saved by file path (from before the vault) is read by the transport,
 * unless its passphrase is encrypted with this device's keychain, which only the app can read.
 */
async function requestCertificate(
  payload: ReturnType<typeof preparePayload>,
  credentials: Source['credentials'],
): Promise<LoadedClientCertificate | undefined> {
  const chosen = payload.clientCertificate;
  if (!chosen) return undefined;
  if (!('credentialId' in chosen)) {
    if (chosen.passphrase?.startsWith('enc:'))
      throw new Error(
        'This host’s client certificate has a passphrase only the app can read. Open Credentials in the app once to move it into the vault.',
      );
    return undefined;
  }
  if (!credentials)
    throw new Error(
      'This host’s client certificate lives in the app’s vault: send it from one of the app’s workspaces (-w), or a team folder the app on this computer has open, with API_WORKBENCH_VAULT_PASSWORD.',
    );
  return vaultCertificate(await credentials.get(chosen.credentialId), payload.url);
}

/**
 * A request ready for the files given for it: a file body, or a form's file fields, need one each
 * (`request send --binary-file`, `--form-file name=path`), and say so when one is missing.
 */
function withUploads(request: ApiRequest, uploads: Uploads | undefined): ApiRequest {
  if (['GET', 'HEAD'].includes(request.method)) return request;
  if (request.bodyType === 'binary' && !uploads?.binary)
    throw new Error(
      `This request's body is a file${request.binaryName ? ` (${request.binaryName})` : ''}: give it with request send --binary-file <path>, or run --uploads <file>.`,
    );
  if (request.bodyType !== 'form-data') return request;
  const files = (request.bodyFields ?? []).filter(
    (field) => field.enabled && field.key && field.kind === 'file',
  );
  const missing = files.find((field) => !uploads?.fields[field.key]);
  if (missing)
    throw new Error(
      `The form field “${missing.key}” is a file${missing.fileName ? ` (${missing.fileName})` : ''}: give it with request send --form-file ${missing.key}=<path>, or run --uploads <file>.`,
    );
  // Each file field gets an id, which `uploadFor` finds its file by.
  return {
    ...request,
    bodyFields: (request.bodyFields ?? []).map((field, index) =>
      field.kind === 'file' && !field.fileId ? { ...field, fileId: `field-${index}` } : field,
    ),
  };
}
const uploadFor = (request: ApiRequest, id: string, uploads: Uploads | undefined) => {
  const field = request.bodyFields?.find((item) => item.fileId === id);
  return field ? uploads?.fields[field.key] : undefined;
};

/**
 * A request's files: those given for it (`--binary-file`, `--form-file`, `--uploads`) over the
 * ones its `.http` file names, which are read now, when it is sent. Their paths have their
 * `{{variables}}` filled in as the rest of the request does — environment, `-v`, data row,
 * built-ins — and `<@` files their text too, as REST Client does.
 */
async function requestUploads(
  given: Uploads | undefined,
  named: FileUploads | undefined,
  request: ApiRequest,
  resolve: (value: string) => string,
): Promise<Uploads | undefined> {
  if (!named) return given;
  const read = async (written: string, template: boolean) => {
    const filled = resolve(written);
    const unset = /\{\{\s*([^}]+?)\s*\}\}/.exec(filled)?.[1];
    if (unset)
      throw new Error(
        `The file ${written} names {{${unset}}}, which no environment, variable, or data row sets.`,
      );
    const upload = await readProjectUpload(named.folder, filled);
    if (!template) return upload;
    const text = resolve(Buffer.from(upload.base64, 'base64').toString('utf8'));
    return { ...upload, base64: Buffer.from(text, 'utf8').toString('base64') };
  };
  const templates = new Set(named.templates ?? []);
  const fields: Uploads['fields'] = {};
  for (const [field, file] of Object.entries(named.fields))
    if (!given?.fields[field]) {
      // Sent with the name its part gives (`filename="…"`), as REST Client and JetBrains do.
      const upload = await read(file, templates.has(field));
      const name = request.bodyFields?.find((item) => item.key === field)?.fileName;
      const sentAs = name ? resolve(name) : '';
      fields[field] = sentAs && !/\{\{/.test(sentAs) ? { ...upload, name: sentAs } : upload;
    }
  return {
    ...(given?.binary
      ? { binary: given.binary }
      : named.binary
        ? { binary: await read(named.binary, templates.has('')) }
        : {}),
    fields: { ...fields, ...given?.fields },
  };
}
