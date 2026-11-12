import { defineStore } from 'pinia';
import { trimHistory } from '@techieutils/api-workbench-common/history';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import { shallowReactive, toRaw } from 'vue';
import { payloadSettings } from '@techieutils/api-workbench-common/http-settings';
import * as runner from '@techieutils/api-workbench-common/runner';
import type {
  RunnerBaseline,
  RunnerConfig,
  RunnerProgress,
  RunnerReport,
  RunnerSample,
} from '@techieutils/api-workbench-common/runner';
import type { ResourceReport } from '@techieutils/api-workbench-common/runner-resources';
import {
  RUN_DATA_LIMITS,
  parseRunData,
  withRowValues,
  type RunData,
} from '@techieutils/api-workbench-common/run-data';
import type {
  ApiRequest,
  RequestPayload,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import { render } from '../shell';
import { download, errorMessage, toast, uid } from '../utils';
import { useRequestsStore } from './requests';
import { useScriptsStore } from './scripts';
import {
  describeTagFilter,
  effectiveTags,
  emptyTagFilter,
  matchesTags,
  tagFilterActive,
} from '@techieutils/api-workbench-common/tags';
import {
  allScriptSteps,
  scriptHostProblem,
  type StepResult,
} from '@techieutils/api-workbench-common/scripts';
import { requestProtocol } from './protocols';
import { useCookiesStore } from './cookies';
import { useHTTPSettingsStore } from './http-settings';
import { useRequestTestsStore } from './request-tests';
import { useResponseStore } from './response';
import { useToolsStore } from './tools';
import { useUiStore } from './ui';
import { useWorkspacesStore } from './workspaces';
import { useWorkspaceStore } from './workspace';

/** Progress repaints at most this often while samples stream in. */
const PAINT_INTERVAL_MS = 250;
const BASELINE_KEY = 'api-workbench:runner-baseline';

/** Collection runs, benchmarks, and performance tests: their configuration, progress, and report. */
export const useRunnerStore = defineStore('runner', () => {
  const workspace = useWorkspaceStore();
  const ui = useUiStore();
  const workspaces = useWorkspacesStore().manager;
  /**
   * Shallow, so reports and samples stay plain objects. The config is edited in place, so views
   * that read it re-evaluate on render() through useRendered().
   */
  const run = shallowReactive({
    workspaceId: '',
    folder: '',
    environment: 0,
    selected: null as string[] | null,
    /** Which requests the run sends by their tags, on top of the ones chosen by hand. */
    tags: emptyTagFilter(),
    config: undefined as RunnerConfig | undefined,
    running: false,
    error: '',
    report: undefined as RunnerReport | undefined,
    resources: undefined as ResourceReport | undefined,
    progress: undefined as RunnerProgress | undefined,
    samples: [] as RunnerSample[],
    controller: undefined as AbortController | undefined,
    active: new Set<string>(),
    lastPaint: 0,
    filter: 'all',
    metadata: { workspace: '', environment: '', collection: '' } as {
      workspace: string;
      environment: string;
      collection: string;
      /** The data file of a data-driven run, without its values. */
      data?: { file: string; format: string; rows: number; columns: string[] };
      /** The tag filter the requests were chosen by, in words, when there was one. */
      tags?: string;
    },
    /** The saved baseline for this workspace, collection, and mode, compared with each run. */
    baseline: undefined as RunnerBaseline | undefined,
    /**
     * A data file for collection runs: one iteration per row, its columns as variables. Kept for
     * this session only, since the file stays where it is on disk.
     */
    data: undefined as RunData | undefined,
    /** The data file's size on disk, for showing it. */
    dataBytes: 0,
    dataError: '',
    /** The data file the last report was run with, for its iteration summary. */
    reportData: undefined as RunData | undefined,
  });

  // Baselines are kept per viewer in local storage, by workspace, collection, and run mode.
  const baselineKey = () =>
    `${BASELINE_KEY}:${run.workspaceId}:${run.folder}:${run.config?.mode ?? 'collection'}`;
  /** Follows a renamed collection: the selection and its saved baselines for every mode. */
  function renameCollection(from: string, to: string): void {
    if (run.folder === from) run.folder = to;
    try {
      for (const mode of ['collection', 'benchmark', 'performance']) {
        const key = (folder: string) => `${BASELINE_KEY}:${workspaces.id}:${folder}:${mode}`;
        const saved = localStorage.getItem(key(from));
        if (saved === null) continue;
        localStorage.setItem(key(to), saved);
        localStorage.removeItem(key(from));
      }
    } catch {
      // Baselines are a convenience; a missing one is simply not shown.
    }
  }
  function loadBaseline(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(baselineKey()) || 'null') as RunnerBaseline;
      run.baseline = saved?.metrics ? saved : undefined;
    } catch {
      run.baseline = undefined;
    }
  }
  function saveBaseline(): void {
    if (!run.report) return;
    run.baseline = runner.baselineOf(run.report);
    try {
      localStorage.setItem(baselineKey(), JSON.stringify(run.baseline));
    } catch {
      /* Storage unavailable; the baseline still applies for this session. */
    }
    render();
  }
  function clearBaseline(): void {
    run.baseline = undefined;
    try {
      localStorage.removeItem(baselineKey());
    } catch {
      /* Storage unavailable. */
    }
    render();
  }

  /** Resets the run for a newly opened workspace and keeps the choices valid for this one. */
  function initialize(): void {
    const state = workspace.state;
    if (run.workspaceId !== workspaces.id) {
      run.workspaceId = workspaces.id;
      run.folder = '';
      run.environment = state.environment;
      run.selected = null;
      run.tags = emptyTagFilter();
      run.config = {
        ...runner.defaults,
        delayMs: workspace.settings().runnerDelayMs,
        stopOnFailure: workspace.settings().stopRunnerOnFailure,
      };
      run.report = undefined;
      run.resources = undefined;
      run.progress = undefined;
      run.samples = [];
      run.error = '';
      run.data = undefined;
      run.dataError = '';
      run.reportData = undefined;
    }
    if (!state.requests.some((request) => isWithin(request.folder, run.folder))) {
      run.folder = collectionOf(state.requests[0]?.folder ?? '');
      run.selected = null;
    }
    run.environment = Math.min(Math.max(0, run.environment), state.environments.length - 1);
    loadBaseline();
  }
  const selectedRequests = (): ApiRequest[] =>
    workspace.state.requests.filter(
      (request) =>
        requestProtocol(request) === 'http' &&
        isWithin(request.folder, run.folder) &&
        (run.selected === null || run.selected.includes(request.id)) &&
        matchesTags(effectiveTags(workspace.state, request), run.tags),
    );
  const formatNumber = (value: number, digits = 1): string =>
    Number.isFinite(value)
      ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
      : '0';

  function exportReport(kind: 'json' | 'csv' | 'resources'): void {
    const report = run.report;
    if (!report) return;
    if (kind === 'resources') {
      if (report.resources)
        download('api-runner-resources.csv', runner.resourcesCsv(report.resources), 'text/csv');
      return;
    }
    const json = kind === 'json';
    download(
      `api-${report.mode}-report.${json ? 'json' : 'csv'}`,
      json ? JSON.stringify({ ...run.metadata, ...report }, null, 2) : runner.csv(report),
      json ? 'application/json' : 'text/csv',
    );
  }
  /** Reads a chosen data file; each row becomes one iteration of the collection run. */
  async function loadData(file: File): Promise<void> {
    run.dataError = '';
    try {
      if (file.size > RUN_DATA_LIMITS.bytes) throw new Error('Data files are limited to 5 MB.');
      run.data = parseRunData(file.name, await file.text());
      run.dataBytes = file.size;
      // Every row runs once: the iteration count follows the file.
      if (run.config) run.config.iterations = run.data.rows.length;
    } catch (error) {
      run.dataError = errorMessage(error);
    }
    render();
  }
  function clearData(): void {
    run.data = undefined;
    run.dataBytes = 0;
    run.dataError = '';
    if (run.config) run.config.iterations = 1;
    render();
  }
  /** The run's data file, when this run uses one: only collection runs do. */
  const runData = () => (run.config?.mode === 'collection' ? run.data : undefined);
  function stop(): void {
    run.controller?.abort();
    if (window.workbench)
      void Promise.allSettled([...run.active].map((id) => window.workbench!.cancel(id)));
  }
  /** Resolves variables against the run's environment without changing the active one. */
  function withRunEnvironment<T>(callback: () => T): T {
    const state = workspace.state;
    const previous = state.environment;
    try {
      state.environment = run.environment;
      return callback();
    } finally {
      state.environment = previous;
    }
  }
  async function browserSend(
    payload: RequestPayload,
    signal: AbortSignal,
  ): Promise<RequestResponse> {
    if (payload.credentialId || payload.multipart || payload.binary)
      throw new Error('Saved credentials and uploads require Electron.');
    useHTTPSettingsStore().requireDesktop(payloadSettings(payload));
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, payload.timeoutMs || 60000),
      start = performance.now();
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: ['GET', 'HEAD'].includes(payload.method) ? undefined : payload.body || undefined,
        signal: controller.signal,
        redirect: payload.followRedirects === false ? 'manual' : 'follow',
      });
      if (response.type === 'opaqueredirect')
        throw new Error('Inspecting redirects requires Electron.');
      const body = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body,
        time: performance.now() - start,
        size: new TextEncoder().encode(body).length,
        url: response.url,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  async function start(): Promise<void> {
    if (ui.busy || run.running) return;
    initialize();
    run.error = '';
    const state = workspace.state;
    const requests = selectedRequests().map((request) => structuredClone(request));
    const scripts = useScriptsStore();
    let config: RunnerConfig;
    const payloads = new Map<string, RequestPayload>();
    const data = runData();
    /** The data row for a measured request: rows run in order, one per iteration. */
    const rowOf = (sequence: number) =>
      data?.rows[Math.floor((sequence - 1) / requests.length) % data.rows.length];
    try {
      if (data) run.config!.iterations = data.rows.length;
      config = runner.validateConfig(run.config!, requests);
      // Load tests send prepared requests as fast as they can; scripts run in collection runs.
      if (
        config.mode !== 'collection' &&
        requests.some((request) => allScriptSteps(state, request).length)
      )
        toast('Request scripts run in collection runs, not in load tests', 'warning');
      // Checked with the first row, so a request that needs a column fails before the run starts.
      withRunEnvironment(() =>
        workspace.withDataRow(data?.rows[0], () =>
          requests.forEach((request) =>
            payloads.set(request.id, useRequestsStore().prepare(request)),
          ),
        ),
      );
    } catch (error) {
      run.error = errorMessage(error);
      render();
      return;
    }
    run.metadata = {
      workspace: workspace.settings().workspaceName,
      environment: state.environments[run.environment].name,
      collection: run.folder,
      ...(tagFilterActive(run.tags) ? { tags: describeTagFilter(run.tags) } : {}),
      ...(data
        ? {
            data: {
              file: data.name,
              format: data.format,
              rows: data.rows.length,
              columns: data.columns,
            },
          }
        : {}),
    };
    run.reportData = data;
    run.controller = new AbortController();
    run.running = true;
    run.report = undefined;
    run.resources = undefined;
    run.samples = [];
    run.progress = undefined;
    run.filter = 'all';
    run.lastPaint = 0;
    ui.busy = true;
    render();
    const runId = uid(),
      signal = run.controller.signal,
      lastResponses = new Map<string, RequestResponse>();
    const capturedWorkspaceId = workspaces.id,
      requestMap = new Map(requests.map((request) => [request.id, request]));
    const sameWorkspace = () => workspaces.id === capturedWorkspaceId;
    try {
      const report = await runner.run(
        config,
        requests.map(({ id, name, method }) => ({ id, name, method })),
        {
          signal,
          readResources: window.workbench ? () => window.workbench!.runnerResources() : undefined,
          send: async (task, context) => {
            if (signal.aborted)
              return { response: { error: 'Cancelled' }, testsPassed: 0, testsTotal: 0 };
            const id = `runner-${runId}-${context.warmup ? 'warmup' : 'sample'}-${context.sequence}`;
            run.active.add(id);
            try {
              // Collection runs re-resolve each request so it sees variables captured earlier in the run.
              const row = context.warmup ? undefined : rowOf(context.sequence);
              const scripted = config.mode === 'collection' && !context.warmup;
              let pre: StepResult[] = [];
              if (scripted)
                try {
                  // Where the request went before its scripts, to check they did not move it.
                  const before = withRunEnvironment(() =>
                    workspace.withDataRow(row, () =>
                      workspace.resolve(requestMap.get(task.id)!.url),
                    ),
                  );
                  // A pre-request script sets variables in the run's environment, then the
                  // request is prepared from its changed copy.
                  const prepared = await scripts.beforeSend(
                    requestMap.get(task.id)!,
                    workspace.state.environments[run.environment],
                    row,
                  );
                  pre = prepared.results;
                  payloads.set(
                    task.id,
                    withRunEnvironment(() =>
                      workspace.withDataRow(row, () =>
                        useRequestsStore().prepare(prepared.request),
                      ),
                    ),
                  );
                  const moved = pre.length
                    ? scriptHostProblem(before, payloads.get(task.id)!.url)
                    : undefined;
                  if (moved) throw new Error(moved);
                } catch (error) {
                  return {
                    response: { error: errorMessage(error) },
                    testsPassed: 0,
                    testsTotal: 0,
                  };
                }
              const payload = { ...payloads.get(task.id)!, id };
              const response = window.workbench
                ? await window.workbench.send(payload)
                : await browserSend(payload, signal);
              const request = requestMap.get(task.id)!;
              // A data row's columns fill {{column}} in tests, so rows can carry expected values.
              const tests =
                response.error === undefined
                  ? useRequestTestsStore().runTests(
                      row ? { ...request, tests: withRowValues(request.tests, row) } : request,
                      response,
                    )
                  : [];
              tests.push(...scripts.stepAssertions(pre));
              if (config.mode === 'collection' && !context.warmup) {
                lastResponses.set(task.id, response);
                if (sameWorkspace()) {
                  useCookiesStore().storeResponse(response);
                  useRequestTestsStore().applyCaptures(
                    requestMap.get(task.id)!,
                    response,
                    workspace.state.environments[run.environment],
                  );
                }
              }
              if (scripted && sameWorkspace()) {
                const post = await scripts.afterResponse(
                  request,
                  response,
                  workspace.state.environments[run.environment],
                  row,
                );
                tests.push(...scripts.stepAssertions(post));
              }
              return {
                response,
                testsPassed: tests.filter((test) => test.pass).length,
                testsTotal: tests.length,
                // Failure messages go into reports, which omit request URLs: the URL is replaced,
                // then the console's redaction removes credentials and likely secret values.
                ...(response.error !== undefined
                  ? {
                      error: useToolsStore().consoleSafeError(
                        response.error.split(payload.url).join('<request URL>'),
                        requestMap.get(task.id)!,
                      ),
                    }
                  : {}),
              };
            } finally {
              run.active.delete(id);
            }
          },
          onUpdate: (progress, samples, resources) => {
            // Written without notifying views; they repaint on phase changes and at most every
            // PAINT_INTERVAL_MS, as streaming samples would otherwise re-render on every update.
            const raw = toRaw(run);
            const phaseChanged = raw.progress?.phase !== progress.phase;
            raw.resources = resources;
            raw.progress = progress;
            raw.samples = samples;
            if (phaseChanged || performance.now() - raw.lastPaint >= PAINT_INTERVAL_MS) {
              raw.lastPaint = performance.now();
              if (ui.view === 'Runner') workspace.refresh();
            }
          },
        },
      );
      run.report = report;
      if (config.mode === 'collection' && sameWorkspace()) {
        const state = workspace.state;
        const response = useResponseStore();
        for (const [id, last] of lastResponses) {
          const request = state.requests.find((item) => item.id === id);
          if (request) {
            request.response = last;
            response.recordSnapshot(request, last);
          }
        }
        const settings = workspace.settings();
        if (settings.historyEnabled && settings.historyLimit > 0) {
          state.history = [
            ...report.samples
              .filter((sample) => !sample.cancelled)
              .reverse()
              .map((sample) => ({
                requestId: sample.requestId,
                method: sample.method,
                url: payloads.get(sample.requestId)!.url,
                status: sample.status,
                date: sample.startedAt,
                time: Math.round(sample.durationMs),
              })),
            ...state.history,
          ];
          state.history = trimHistory(state.history, settings.historyLimit);
        }
        workspace.persist();
      }
    } catch (error) {
      run.error = errorMessage(error);
    } finally {
      run.running = false;
      run.controller = undefined;
      run.active.clear();
      ui.busy = false;
      ui.activeRequestId = '';
      render();
    }
  }
  /**
   * Each data row's outcome in the last report: requests that succeeded and tests that passed,
   * in row order.
   */
  function iterationSummary() {
    const data = run.reportData;
    const report = run.report;
    if (!data || !report) return [];
    const rows = data.rows.map((values, index) => ({
      iteration: index + 1,
      values,
      requests: 0,
      succeeded: 0,
      testsPassed: 0,
      testsTotal: 0,
      ran: false,
      passed: true,
    }));
    for (const sample of report.samples) {
      const row = rows[sample.iteration - 1];
      if (!row || sample.cancelled) continue;
      row.ran = true;
      row.requests++;
      if (sample.success) row.succeeded++;
      row.testsPassed += sample.testsPassed;
      row.testsTotal += sample.testsTotal;
      // A row passes on its assertions, so a row may expect an error status. Without tests, the
      // run's successful status range decides; a request that never got a response always fails.
      if (
        sample.failure === 'transport' ||
        sample.testsPassed < sample.testsTotal ||
        (sample.failure === 'http' && sample.testsTotal === 0)
      )
        row.passed = false;
    }
    return rows;
  }
  return {
    run,
    iterationSummary,
    loadData,
    clearData,
    renameCollection,
    initialize,
    selectedRequests,
    formatNumber,
    exportReport,
    stop,
    start,
    saveBaseline,
    clearBaseline,
    summarize: runner.summarize,
    endpointMetrics: runner.endpointMetrics,
    timeline: runner.timeline,
    histogram: runner.histogram,
    errorSummary: runner.errorSummary,
    compareToBaseline: runner.compareToBaseline,
  };
});
