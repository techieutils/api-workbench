import { createResourceMonitor } from './runner-resources';
import type { ResourceReading, ResourceReport } from './runner-resources';
export { resourcesCsv, summarizeResources } from './runner-resources';
import type { RequestResponse } from './types';
export type RunnerMode = 'collection' | 'benchmark' | 'performance';
/**
 * How a performance test generates load. `workers` is a closed model: each worker sends its next
 * request after the previous one finishes, so a slow API lowers the load it receives. `rate` is
 * an open model: requests start on a fixed schedule (`targetRps`) whatever the API's latency, up
 * to `concurrency` in flight; starts that would exceed it are counted as dropped.
 */
export type RunnerLoadModel = 'workers' | 'rate';
export interface RunnerConfig {
  mode: RunnerMode;
  loadModel: RunnerLoadModel;
  targetRps: number;
  iterations: number;
  concurrency: number;
  durationSeconds: number;
  rampUpSeconds: number;
  warmupIterations: number;
  delayMs: number;
  maxRequests: number;
  successMin: number;
  successMax: number;
  p95LimitMs: number;
  maxErrorRate: number;
  minRps: number;
  stopOnFailure: boolean;
}
export interface RunnerTask {
  id: string;
  name: string;
  method: string;
}
export interface RunnerReply {
  response: RequestResponse;
  testsPassed: number;
  testsTotal: number;
  /** The failure message to report, when it should differ from the response's (e.g. redacted). */
  error?: string;
}
export interface RunnerSample {
  sequence: number;
  startedAt: string;
  iteration: number;
  requestId: string;
  name: string;
  method: string;
  status?: number;
  /** When the request started, in milliseconds after the measured run began. */
  offsetMs: number;
  /** End-to-end time in the client: dispatch, network, response transfer, and assertions. */
  durationMs: number;
  /** Time on the network, as measured where the request was sent, when it was reported. */
  networkMs?: number;
  /** Time to the first response byte, when network timing was captured. */
  ttfbMs?: number;
  bytes: number;
  testsPassed: number;
  testsTotal: number;
  success: boolean;
  cancelled: boolean;
  failure?: 'transport' | 'http' | 'assertion';
  /** The transport error message, for failures that have one. */
  error?: string;
}
export interface RunnerMetrics {
  completed: number;
  cancelled: number;
  successful: number;
  failed: number;
  transportErrors: number;
  httpErrors: number;
  assertionFailures: number;
  errorRate: number;
  rps: number;
  successfulRps: number;
  average: number;
  /** Sample standard deviation of latency. */
  stdDev: number;
  /** Half-width of the 95% confidence interval for the mean latency. */
  ci95: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  /** Network latency, excluding client overhead; 0 when no sample reported it. */
  networkAverage: number;
  networkP50: number;
  networkP95: number;
  networkP99: number;
  /** Time to first byte; 0 when no sample captured network timing. */
  ttfbAverage: number;
  ttfbP95: number;
  bytes: number;
  testsPassed: number;
  testsTotal: number;
}
export interface RunnerProgress {
  phase: 'warmup' | 'running' | 'done';
  scheduled: number;
  completed: number;
  inFlight: number;
  /** Rate model: starts skipped because the in-flight limit was reached. */
  dropped: number;
  warmupCompleted: number;
  warmupTotal: number;
  elapsedMs: number;
}
export interface RunnerReport {
  version: 2;
  resources?: ResourceReport;
  startedAt: string;
  endedAt: string;
  mode: RunnerMode;
  config: RunnerConfig;
  tasks: RunnerTask[];
  elapsedMs: number;
  warmupCompleted: number;
  warmupFailures: number;
  /** Rate model: starts skipped because the in-flight limit was reached. */
  dropped: number;
  reason: 'completed' | 'cancelled' | 'failure' | 'request-limit';
  outcome: 'passed' | 'failed' | 'cancelled' | 'empty';
  metrics: RunnerMetrics;
  thresholds: { name: string; actual: number; limit: number; passed: boolean }[];
  timeline: RunnerBucket[];
  errors: RunnerErrorGroup[];
  samples: RunnerSample[];
}
/** Requests that completed in one interval of the run. */
export interface RunnerBucket {
  /** Interval start, in milliseconds after the measured run began. */
  startMs: number;
  durationMs: number;
  completed: number;
  failed: number;
  rps: number;
  average: number;
  p95: number;
}
export interface RunnerErrorGroup {
  failure: NonNullable<RunnerSample['failure']>;
  message: string;
  count: number;
  requests: string[];
}
export const defaults: RunnerConfig = {
  mode: 'collection',
  loadModel: 'workers',
  targetRps: 10,
  iterations: 1,
  concurrency: 1,
  durationSeconds: 10,
  rampUpSeconds: 0,
  warmupIterations: 0,
  delayMs: 0,
  maxRequests: 10000,
  successMin: 200,
  successMax: 399,
  p95LimitMs: 1000,
  maxErrorRate: 0,
  minRps: 0,
  stopOnFailure: false,
};
export function validateConfig(config: RunnerConfig, tasks: RunnerTask[]): RunnerConfig {
  const result = { ...config };
  if (!['collection', 'benchmark', 'performance'].includes(result.mode))
    throw new Error('Choose a valid run mode.');
  if (!tasks.length) throw new Error('Select at least one request.');
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error('Selected request IDs must be unique.');
  const range = (key: keyof RunnerConfig, min: number, max: number, integer = false) => {
    const value = result[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(`${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  };
  range('iterations', 1, 10000, true);
  range('concurrency', 1, 50, true);
  range('durationSeconds', 0.01, 3600);
  range('rampUpSeconds', 0, 3600);
  range('warmupIterations', 0, 100, true);
  range('delayMs', 0, 60000);
  range('maxRequests', 1, 100000, true);
  range('successMin', 100, 599, true);
  range('successMax', 100, 599, true);
  range('p95LimitMs', 0, 3600000);
  range('maxErrorRate', 0, 100);
  range('minRps', 0, 1000000);
  range('targetRps', 0.1, 10000);
  if (!['workers', 'rate'].includes(result.loadModel))
    throw new Error('Choose a valid load model.');
  if (result.successMin > result.successMax)
    throw new Error('Minimum successful status must not exceed maximum.');
  if (result.mode === 'performance' && result.rampUpSeconds > result.durationSeconds)
    throw new Error('Ramp-up must not exceed test duration.');
  if (result.mode !== 'performance' && result.iterations * tasks.length > 100000)
    throw new Error('The run may contain at most 100,000 measured requests.');
  if (result.warmupIterations * tasks.length > 10000)
    throw new Error('Warm-up may contain at most 10,000 requests.');
  if (result.mode !== 'performance') result.loadModel = 'workers';
  if (result.mode === 'collection') {
    result.concurrency = 1;
    result.warmupIterations = 0;
    result.rampUpSeconds = 0;
  }
  return result;
}
export function percentile(sorted: number[], percent: number): number {
  return sorted.length ? sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] : 0;
}
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0);
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
export function summarize(samples: RunnerSample[], elapsedMs: number): RunnerMetrics {
  const completed = samples.filter((sample) => !sample.cancelled),
    latencies = sorted(completed.map((sample) => sample.durationMs));
  const network = sorted(
      completed.flatMap((sample) => (sample.networkMs === undefined ? [] : [sample.networkMs])),
    ),
    ttfb = sorted(
      completed.flatMap((sample) => (sample.ttfbMs === undefined ? [] : [sample.ttfbMs])),
    );
  const successful = completed.filter((sample) => sample.success).length,
    seconds = elapsedMs / 1000,
    average = mean(latencies);
  const stdDev =
    latencies.length > 1
      ? Math.sqrt(sum(latencies.map((value) => (value - average) ** 2)) / (latencies.length - 1))
      : 0;
  return {
    completed: completed.length,
    cancelled: samples.length - completed.length,
    successful,
    failed: completed.length - successful,
    transportErrors: completed.filter((sample) => sample.failure === 'transport').length,
    httpErrors: completed.filter((sample) => sample.failure === 'http').length,
    assertionFailures: completed.filter((sample) => sample.testsPassed < sample.testsTotal).length,
    errorRate: completed.length ? ((completed.length - successful) / completed.length) * 100 : 0,
    rps: seconds > 0 ? completed.length / seconds : 0,
    successfulRps: seconds > 0 ? successful / seconds : 0,
    average,
    stdDev,
    ci95: latencies.length > 1 ? (1.96 * stdDev) / Math.sqrt(latencies.length) : 0,
    min: latencies[0] || 0,
    max: latencies.at(-1) || 0,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    p999: percentile(latencies, 99.9),
    networkAverage: mean(network),
    networkP50: percentile(network, 50),
    networkP95: percentile(network, 95),
    networkP99: percentile(network, 99),
    ttfbAverage: mean(ttfb),
    ttfbP95: percentile(ttfb, 95),
    bytes: sum(completed.map((sample) => sample.bytes)),
    testsPassed: sum(completed.map((sample) => sample.testsPassed)),
    testsTotal: sum(completed.map((sample) => sample.testsTotal)),
  };
}
/**
 * Completed requests per interval, by completion time. Intervals are at least a second and grow
 * so a run has at most `maxBuckets` of them.
 */
export function timeline(
  samples: RunnerSample[],
  elapsedMs: number,
  maxBuckets = 120,
): RunnerBucket[] {
  if (elapsedMs <= 0) return [];
  const size = Math.max(1000, Math.ceil(elapsedMs / maxBuckets / 1000) * 1000);
  // A final sliver shorter than half an interval joins the one before it: a rate over a few
  // milliseconds of stragglers would read as a spike.
  const whole = Math.floor(elapsedMs / size),
    rest = elapsedMs - whole * size;
  const count = Math.max(1, rest > 0 && (rest >= size / 2 || whole === 0) ? whole + 1 : whole);
  const groups: RunnerSample[][] = Array.from({ length: count }, () => []);
  for (const sample of samples) {
    if (sample.cancelled) continue;
    const index = Math.floor((sample.offsetMs + sample.durationMs) / size);
    groups[Math.min(count - 1, Math.max(0, index))].push(sample);
  }
  return groups.map((group, index) => {
    const startMs = index * size,
      durationMs = index === count - 1 ? elapsedMs - startMs : size,
      latencies = sorted(group.map((sample) => sample.durationMs));
    return {
      startMs,
      durationMs,
      completed: group.length,
      failed: group.filter((sample) => !sample.success).length,
      rps: durationMs > 0 ? group.length / (durationMs / 1000) : 0,
      average: mean(latencies),
      p95: percentile(latencies, 95),
    };
  });
}
/** Latency distribution as `bins` equal-width ranges from the fastest to the slowest request. */
export function histogram(
  samples: RunnerSample[],
  bins = 20,
): { fromMs: number; toMs: number; count: number }[] {
  const latencies = samples
    .filter((sample) => !sample.cancelled)
    .map((sample) => sample.durationMs);
  if (!latencies.length) return [];
  const low = Math.min(...latencies),
    high = Math.max(...latencies),
    width = (high - low) / bins || 1;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of latencies) counts[Math.min(bins - 1, Math.floor((value - low) / width))]++;
  return counts.map((count, index) => ({
    fromMs: low + index * width,
    toMs: low + (index + 1) * width,
    count,
  }));
}
/** Failures grouped by kind and message, most frequent first. */
export function errorSummary(samples: RunnerSample[], limit = 10): RunnerErrorGroup[] {
  const groups = new Map<string, RunnerErrorGroup>();
  for (const sample of samples) {
    if (sample.cancelled || !sample.failure) continue;
    const message =
      sample.failure === 'transport'
        ? sample.error || 'Transport error'
        : sample.failure === 'http'
          ? `HTTP ${sample.status ?? 'error'}`
          : `${sample.testsTotal - sample.testsPassed} of ${sample.testsTotal} assertions failed`;
    const key = `${sample.failure}|${message}`;
    const group = groups.get(key) || { failure: sample.failure, message, count: 0, requests: [] };
    group.count++;
    if (!group.requests.includes(sample.name)) group.requests.push(sample.name);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
/** The metrics a run is compared on, kept to compare later runs against. */
export interface RunnerBaseline {
  savedAt: string;
  mode: RunnerMode;
  metrics: Pick<
    RunnerMetrics,
    'completed' | 'rps' | 'errorRate' | 'average' | 'p50' | 'p95' | 'p99' | 'networkP95'
  >;
}
export function baselineOf(report: RunnerReport): RunnerBaseline {
  const { completed, rps, errorRate, average, p50, p95, p99, networkP95 } = report.metrics;
  return {
    savedAt: report.endedAt,
    mode: report.mode,
    metrics: { completed, rps, errorRate, average, p50, p95, p99, networkP95 },
  };
}
/**
 * Change from a baseline for each compared metric. A change counts as a regression when it is
 * worse by more than `tolerance` percent (latency or errors up, throughput down).
 */
export function compareToBaseline(
  baseline: RunnerBaseline,
  metrics: RunnerMetrics,
  tolerance = 10,
): {
  key: keyof RunnerBaseline['metrics'];
  label: string;
  baseline: number;
  current: number;
  changePercent: number;
  regression: boolean;
}[] {
  const rows: [keyof RunnerBaseline['metrics'], string, 'lower' | 'higher'][] = [
    ['rps', 'Throughput (req/s)', 'higher'],
    ['average', 'Average latency (ms)', 'lower'],
    ['p50', 'Median latency (ms)', 'lower'],
    ['p95', 'p95 latency (ms)', 'lower'],
    ['p99', 'p99 latency (ms)', 'lower'],
    ['networkP95', 'Network p95 (ms)', 'lower'],
    ['errorRate', 'Error rate (%)', 'lower'],
  ];
  return rows
    .filter(([key]) => key !== 'networkP95' || (baseline.metrics.networkP95 && metrics.networkP95))
    .map(([key, label, better]) => {
      const before = baseline.metrics[key],
        after = metrics[key];
      const changePercent = before ? ((after - before) / before) * 100 : after ? 100 : 0;
      const worse = better === 'lower' ? changePercent : -changePercent;
      return {
        key,
        label,
        baseline: before,
        current: after,
        changePercent,
        regression: worse > tolerance,
      };
    });
}
export function endpointMetrics(
  samples: RunnerSample[],
  elapsedMs: number,
): { id: string; name: string; method: string; metrics: RunnerMetrics }[] {
  const groups = new Map<string, RunnerSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.requestId) || [];
    group.push(sample);
    groups.set(sample.requestId, group);
  }
  return [...groups].map(([id, group]) => ({
    id,
    name: group[0].name,
    method: group[0].method,
    metrics: summarize(group, elapsedMs),
  }));
}
/** Time to the first byte of the final response, from the network timing when it was captured. */
function firstByteMs(response: RequestResponse): number | undefined {
  const waiting = response.timings?.requests.at(-1)?.phases.find((phase) => phase.id === 'waiting');
  return waiting ? waiting.startMs + waiting.durationMs : undefined;
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
export async function run(
  config: RunnerConfig,
  tasks: RunnerTask[],
  options: {
    signal?: AbortSignal;
    send(
      task: RunnerTask,
      context: { sequence: number; warmup: boolean; signal?: AbortSignal },
    ): Promise<RunnerReply>;
    readResources?(): Promise<ResourceReading>;
    onUpdate?(progress: RunnerProgress, samples: RunnerSample[], resources?: ResourceReport): void;
  },
): Promise<RunnerReport> {
  const settings = validateConfig(config, tasks),
    samples: RunnerSample[] = [];
  let scheduled = 0,
    inFlight = 0,
    dropped = 0,
    warmupCompleted = 0,
    warmupFailures = 0,
    halt = false,
    reason: RunnerReport['reason'] = 'completed',
    phase: RunnerProgress['phase'] = 'warmup';
  let measuredStart = performance.now();
  let startedAt: string;
  const resourceMonitor = options.readResources
    ? createResourceMonitor(options.readResources, () => emit())
    : undefined;
  const warmupTotal = settings.warmupIterations * tasks.length;
  const emit = () =>
    options.onUpdate?.(
      {
        phase,
        scheduled,
        completed: samples.length,
        inFlight,
        dropped,
        warmupCompleted,
        warmupTotal,
        elapsedMs: phase === 'warmup' ? 0 : performance.now() - measuredStart,
      },
      samples,
      resourceMonitor?.report(),
    );
  const execute = async (
    task: RunnerTask,
    sequence: number,
    warmup: boolean,
  ): Promise<RunnerSample> => {
    const start = performance.now(),
      offsetMs = warmup ? 0 : Math.max(0, start - measuredStart),
      sampleStartedAt = new Date().toISOString();
    inFlight++;
    emit();
    let reply: RunnerReply;
    try {
      reply = await options.send(task, { sequence, warmup, signal: options.signal });
    } catch {
      reply = { response: { error: 'Transport error' }, testsPassed: 0, testsTotal: 0 };
    }
    inFlight--;
    const response = reply.response,
      cancelled = Boolean(options.signal?.aborted && response.error !== undefined),
      transport = response.error !== undefined,
      http =
        !transport &&
        ((response.status || 0) < settings.successMin ||
          (response.status || 0) > settings.successMax),
      assertion = reply.testsPassed < reply.testsTotal;
    return {
      sequence,
      startedAt: sampleStartedAt,
      iteration: Math.floor((sequence - 1) / tasks.length) + 1,
      requestId: task.id,
      name: task.name,
      method: task.method,
      status: response.status,
      offsetMs,
      durationMs: Math.max(0, performance.now() - start),
      ...(response.timings?.totalMs !== undefined || (!transport && Number.isFinite(response.time))
        ? { networkMs: response.timings?.totalMs ?? response.time }
        : {}),
      ...(firstByteMs(response) !== undefined ? { ttfbMs: firstByteMs(response) } : {}),
      bytes: response.size || 0,
      testsPassed: reply.testsPassed,
      testsTotal: reply.testsTotal,
      success: !transport && !http && !assertion,
      cancelled,
      ...(transport
        ? {
            failure: 'transport' as const,
            error: String(reply.error ?? response.error).slice(0, 300),
          }
        : http
          ? { failure: 'http' as const }
          : assertion
            ? { failure: 'assertion' as const }
            : {}),
    };
  };
  const scheduling = new AbortController();
  const abortScheduling = () => scheduling.abort();
  options.signal?.addEventListener('abort', abortScheduling, { once: true });
  if (options.signal?.aborted) scheduling.abort();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(emit, 250);
  try {
    emit();
    for (let index = 0; index < warmupTotal && !options.signal?.aborted; index++) {
      const sample = await execute(tasks[index % tasks.length], index + 1, true);
      warmupCompleted++;
      if (!sample.success && !sample.cancelled) warmupFailures++;
      emit();
      if (settings.stopOnFailure && !sample.success && !sample.cancelled) {
        halt = true;
        reason = 'failure';
        break;
      }
      if (index + 1 < warmupTotal) await wait(settings.delayMs, options.signal);
    }
    await resourceMonitor?.start();
    phase = 'running';
    measuredStart = performance.now();
    startedAt = new Date().toISOString();
    emit();
    const limit =
      settings.mode === 'performance' ? settings.maxRequests : settings.iterations * tasks.length;
    const deadline = measuredStart + settings.durationSeconds * 1000;
    if (settings.mode === 'performance')
      deadlineTimer = setTimeout(abortScheduling, settings.durationSeconds * 1000);
    const worker = async (workerIndex: number) => {
      if (halt || scheduling.signal.aborted || scheduled >= limit) return;
      if (settings.mode === 'performance' && settings.concurrency > 1)
        await wait(
          (settings.rampUpSeconds * 1000 * workerIndex) / (settings.concurrency - 1),
          scheduling.signal,
        );
      while (!scheduling.signal.aborted && !halt && !options.signal?.aborted && scheduled < limit) {
        if (settings.mode === 'performance' && performance.now() >= deadline) break;
        const sequence = ++scheduled,
          task = tasks[(sequence - 1) % tasks.length];
        if (scheduled >= limit) scheduling.abort();
        const sample = await execute(task, sequence, false);
        samples.push(sample);
        if (settings.stopOnFailure && !sample.success && !sample.cancelled) {
          halt = true;
          reason = 'failure';
          scheduling.abort();
        }
        emit();
        if (!halt && scheduled < limit) {
          const remaining =
            settings.mode === 'performance'
              ? Math.max(0, deadline - performance.now())
              : settings.delayMs;
          await wait(Math.min(settings.delayMs, remaining), scheduling.signal);
        }
      }
    };
    /** Open model: starts requests on a schedule, ramping the rate up over the ramp-up period. */
    const rateScheduler = async () => {
      const pending = new Set<Promise<void>>();
      // Starts follow the integral of the rate: a linear ramp from zero to the target, then a
      // constant rate. During the ramp the k-th start is at sqrt(2 * ramp * k / target).
      const rampSeconds = settings.rampUpSeconds,
        target = settings.targetRps,
        rampStarts = (target * rampSeconds) / 2;
      const dueAt = (slot: number) =>
        measuredStart +
        1000 *
          (slot < rampStarts
            ? Math.sqrt((2 * rampSeconds * slot) / target)
            : rampSeconds + (slot - rampStarts) / target);
      let slot = 0;
      const dispatch = (sequence: number) => {
        const task = tasks[(sequence - 1) % tasks.length];
        const job = execute(task, sequence, false).then((sample) => {
          samples.push(sample);
          if (settings.stopOnFailure && !sample.success && !sample.cancelled) {
            halt = true;
            reason = 'failure';
            scheduling.abort();
          }
          emit();
        });
        pending.add(job);
        void job.finally(() => pending.delete(job));
      };
      while (!scheduling.signal.aborted && !halt && !options.signal?.aborted && scheduled < limit) {
        await wait(dueAt(slot) - performance.now(), scheduling.signal);
        if (scheduling.signal.aborted || halt || performance.now() >= deadline) break;
        // Catch up on starts that came due while waiting, as a fixed schedule would.
        while (dueAt(slot) <= performance.now() && scheduled < limit && dueAt(slot) < deadline) {
          if (inFlight >= settings.concurrency) dropped++;
          else dispatch(++scheduled);
          slot++;
        }
      }
      await Promise.all(pending);
    };
    if (settings.mode === 'performance' && settings.loadModel === 'rate') await rateScheduler();
    else
      await Promise.all(Array.from({ length: settings.concurrency }, (_, index) => worker(index)));
    if (options.signal?.aborted) reason = 'cancelled';
    else if (!halt && settings.mode === 'performance' && scheduled >= limit)
      reason = 'request-limit';
    const elapsedMs = performance.now() - measuredStart,
      metrics = summarize(samples, elapsedMs);
    const thresholds = [
      {
        name: 'Error rate (%)',
        actual: metrics.errorRate,
        limit: settings.maxErrorRate,
        passed: metrics.errorRate <= settings.maxErrorRate,
      },
      ...(settings.p95LimitMs > 0
        ? [
            {
              name: 'p95 latency (ms)',
              actual: metrics.p95,
              limit: settings.p95LimitMs,
              passed: metrics.p95 <= settings.p95LimitMs,
            },
          ]
        : []),
      ...(settings.minRps > 0
        ? [
            {
              name: 'Minimum throughput (req/s)',
              actual: metrics.rps,
              limit: settings.minRps,
              passed: metrics.rps >= settings.minRps,
            },
          ]
        : []),
    ];
    await resourceMonitor?.stop();
    phase = 'done';
    emit();
    return {
      version: 2,
      ...(resourceMonitor ? { resources: resourceMonitor.report() } : {}),
      startedAt,
      endedAt: new Date().toISOString(),
      mode: settings.mode,
      config: settings,
      tasks: structuredClone(tasks),
      elapsedMs,
      warmupCompleted,
      warmupFailures,
      dropped,
      reason,
      outcome:
        reason === 'cancelled'
          ? 'cancelled'
          : reason === 'failure'
            ? 'failed'
            : !metrics.completed
              ? 'empty'
              : thresholds.every((check) => check.passed)
                ? 'passed'
                : 'failed',
      metrics,
      thresholds,
      timeline: timeline(samples, elapsedMs),
      errors: errorSummary(samples),
      samples,
    };
  } finally {
    resourceMonitor?.dispose();
    clearInterval(heartbeat);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', abortScheduling);
  }
}
export function csv(report: RunnerReport): string {
  const escape = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [
    [
      'sequence',
      'started_at',
      'iteration',
      'request',
      'method',
      'status',
      'offset_ms',
      'latency_ms',
      'network_ms',
      'ttfb_ms',
      'bytes',
      'success',
      'cancelled',
      'tests_passed',
      'tests_total',
      'failure',
      'error',
    ],
    ...report.samples.map((sample) => [
      sample.sequence,
      sample.startedAt,
      sample.iteration,
      sample.name,
      sample.method,
      sample.status,
      sample.offsetMs,
      sample.durationMs,
      sample.networkMs,
      sample.ttfbMs,
      sample.bytes,
      sample.success,
      sample.cancelled,
      sample.testsPassed,
      sample.testsTotal,
      sample.failure,
      sample.error,
    ]),
  ]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
}
