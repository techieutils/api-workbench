import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineOf,
  compareToBaseline,
  csv,
  defaults,
  endpointMetrics,
  errorSummary,
  histogram,
  run,
  summarize,
  timeline,
  validateConfig,
} from './runner';
import type { RunnerReply, RunnerSample } from './runner';
import type { HttpResponse } from './types';
const tasks = [
  { id: 'a', name: 'First', method: 'GET' },
  { id: 'b', name: 'Second', method: 'POST' },
];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reply = (status = 200): RunnerReply => ({
  response: {
    status,
    statusText: 'OK',
    headers: {},
    body: '{}',
    time: 1,
    size: 2,
    url: 'http://localhost',
  },
  testsPassed: 1,
  testsTotal: 1,
});
test('metrics exclude cancellations and use nearest-rank percentiles and elapsed throughput', () => {
  const sample: RunnerSample = {
    sequence: 1,
    startedAt: '2026-01-01',
    iteration: 1,
    requestId: 'a',
    name: 'First',
    method: 'GET',
    status: 200,
    offsetMs: 0,
    durationMs: 10,
    bytes: 2,
    testsPassed: 1,
    testsTotal: 1,
    success: true,
    cancelled: false,
  };
  const samples = [
    sample,
    {
      ...sample,
      sequence: 2,
      durationMs: 20,
      success: false,
      failure: 'http' as const,
      testsPassed: 0,
    },
    { ...sample, sequence: 3, durationMs: 30, success: false, failure: 'transport' as const },
    { ...sample, sequence: 4, durationMs: 999, cancelled: true },
  ];
  const result = summarize(samples, 2000);
  assert.equal(result.completed, 3);
  assert.equal(result.cancelled, 1);
  assert.equal(result.average, 20);
  assert.equal(result.p50, 20);
  assert.equal(result.p95, 30);
  assert.equal(result.rps, 1.5);
  assert.equal(result.successfulRps, 0.5);
  assert.equal(result.httpErrors, 1);
  assert.equal(result.transportErrors, 1);
  assert.equal(result.assertionFailures, 1);
  assert.equal(result.bytes, 6);
  assert.equal(endpointMetrics(samples, 2000)[0].metrics.completed, 3);
  assert.equal(summarize([], 0).rps, 0);
});
test('benchmark respects concurrency, iterations, and excluded warmups', async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const order: string[] = [];
  const result = await run(
    { ...defaults, mode: 'benchmark', iterations: 3, concurrency: 3, warmupIterations: 1 },
    tasks,
    {
      send: async (task, context) => {
        active++;
        calls++;
        max = Math.max(max, active);
        if (!context.warmup) order.push(task.id);
        await delay(3);
        active--;
        return reply();
      },
    },
  );
  assert.equal(calls, 8);
  assert.equal(result.samples.length, 6);
  assert.equal(result.warmupCompleted, 2);
  assert.equal(max, 3);
  assert.deepEqual(order, ['a', 'b', 'a', 'b', 'a', 'b']);
  assert.equal(result.metrics.testsTotal, 6);
  assert.equal(result.outcome, 'passed');
});
test('collection forces sequential execution and retains iteration order', async () => {
  const order: string[] = [];
  const result = await run(
    { ...defaults, iterations: 2, concurrency: 9, warmupIterations: 2 },
    tasks,
    {
      send: async (task) => {
        order.push(task.id);
        return reply();
      },
    },
  );
  assert.equal(result.config.concurrency, 1);
  assert.equal(result.warmupCompleted, 0);
  assert.deepEqual(order, ['a', 'b', 'a', 'b']);
});
test('performance deadline stops dispatch and drains active requests', async () => {
  const starts: number[] = [];
  const beginning = performance.now();
  const result = await run(
    { ...defaults, mode: 'performance', durationSeconds: 0.04, concurrency: 2 },
    tasks,
    {
      send: async () => {
        starts.push(performance.now());
        await delay(15);
        return reply();
      },
    },
  );
  assert.ok(result.samples.length >= 2);
  assert.equal(result.reason, 'completed');
  assert.ok(starts.at(-1)! - beginning < 80);
  assert.ok(result.elapsedMs >= 40);
});
test('request cap cancels pending ramp-up workers without idle waiting', async () => {
  const beginning = performance.now();
  const result = await run(
    {
      ...defaults,
      mode: 'performance',
      concurrency: 5,
      durationSeconds: 5,
      rampUpSeconds: 4,
      maxRequests: 1,
    },
    tasks,
    { send: async () => reply() },
  );
  assert.equal(result.samples.length, 1);
  assert.equal(result.reason, 'request-limit');
  assert.ok(performance.now() - beginning < 500);
});
test('warmup failures can stop before measured scheduling and ramp-up', async () => {
  const result = await run(
    {
      ...defaults,
      mode: 'performance',
      concurrency: 4,
      warmupIterations: 1,
      rampUpSeconds: 5,
      stopOnFailure: true,
    },
    tasks,
    { send: async () => reply(500) },
  );
  assert.equal(result.samples.length, 0);
  assert.equal(result.warmupFailures, 1);
  assert.equal(result.reason, 'failure');
  assert.equal(result.outcome, 'failed');
});
test('cancellation interrupts worker delay and excludes aborted requests from metrics', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await run(
    { ...defaults, mode: 'benchmark', iterations: 100, delayMs: 10000 },
    tasks,
    {
      signal: controller.signal,
      send: async () => {
        calls++;
        setTimeout(() => controller.abort(), 5);
        return reply();
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.metrics.completed, 1);
  const second = new AbortController();
  const aborted = await run(
    { ...defaults, mode: 'benchmark', iterations: 10, concurrency: 2 },
    tasks,
    {
      signal: second.signal,
      send: async () => {
        second.abort();
        throw new Error('aborted');
      },
    },
  );
  assert.equal(aborted.metrics.completed, 0);
  assert.ok(aborted.metrics.cancelled > 0);
  assert.equal(aborted.outcome, 'cancelled');
});
test('status criteria, assertion failures, stop-on-failure and thresholds determine outcome', async () => {
  const accepted = await run({ ...defaults, successMin: 404, successMax: 404 }, tasks, {
    send: async () => reply(404),
  });
  assert.equal(accepted.outcome, 'passed');
  const failed = await run({ ...defaults, iterations: 10, stopOnFailure: true }, tasks, {
    send: async () => ({ ...reply(), testsPassed: 0 }),
  });
  assert.equal(failed.samples.length, 1);
  assert.equal(failed.metrics.assertionFailures, 1);
  assert.equal(failed.reason, 'failure');
  const latency = await run({ ...defaults, p95LimitMs: 1, minRps: 1000000 }, tasks, {
    send: async () => {
      await delay(5);
      return reply();
    },
  });
  assert.equal(latency.outcome, 'failed');
  assert.equal(latency.thresholds.filter((check) => !check.passed).length, 2);
});
test('configuration rejects invalid numbers, missing selection and impossible bounds', () => {
  for (const config of [
    { ...defaults, concurrency: 0 },
    { ...defaults, iterations: NaN },
    { ...defaults, successMin: 500, successMax: 200 },
    { ...defaults, mode: 'performance' as const, durationSeconds: 1, rampUpSeconds: 2 },
  ])
    assert.throws(() => validateConfig(config, tasks));
  assert.throws(() => validateConfig(defaults, []));
  assert.throws(() => validateConfig(defaults, [tasks[0], tasks[0]]));
});
test('CSV exports samples with timestamps, quoted names and spreadsheet formula protection', async () => {
  const report = await run(defaults, [{ ...tasks[0], name: '=SUM(1,2)"' }], {
    send: async () => reply(),
  });
  const output = csv(report);
  assert.ok(output.includes('started_at'));
  assert.ok(output.includes('"\'=SUM(1,2)"""'));
  assert.equal(output.split('\r\n').length, 2);
});

const sampleAt = (overrides: Partial<RunnerSample>): RunnerSample => ({
  sequence: 1,
  startedAt: '2026-01-01',
  iteration: 1,
  requestId: 'a',
  name: 'First',
  method: 'GET',
  status: 200,
  offsetMs: 0,
  durationMs: 10,
  bytes: 0,
  testsPassed: 0,
  testsTotal: 0,
  success: true,
  cancelled: false,
  ...overrides,
});
test('metrics report spread, a confidence interval, and network latency when it was measured', () => {
  const samples = [10, 20, 30, 40].map((durationMs, index) =>
    sampleAt({
      sequence: index + 1,
      durationMs,
      networkMs: durationMs - 5,
      ttfbMs: durationMs / 2,
    }),
  );
  const metrics = summarize([...samples, sampleAt({ durationMs: 5 })], 1000);
  assert.equal(metrics.networkAverage, 20);
  assert.equal(metrics.networkP95, 35);
  assert.equal(metrics.ttfbP95, 20);
  const plain = summarize(samples, 1000);
  assert.ok(Math.abs(plain.stdDev - 12.9099) < 0.001, 'sample standard deviation');
  assert.ok(Math.abs(plain.ci95 - (1.96 * plain.stdDev) / 2) < 1e-9);
  assert.equal(summarize([sampleAt({})], 1000).ci95, 0, 'one sample has no interval');
});
test('runs record network timing, time to first byte, and start offsets', async () => {
  const report = await run({ ...defaults, mode: 'benchmark', iterations: 2 }, [tasks[0]], {
    send: async () => ({
      ...reply(),
      response: {
        ...(reply().response as HttpResponse),
        time: 7,
        timings: {
          startedAt: '',
          totalMs: 6.5,
          preparationMs: 0,
          requests: [
            {
              method: 'GET',
              url: 'http://localhost',
              startMs: 0,
              durationMs: 6.5,
              connectionReused: true,
              phases: [{ id: 'waiting', label: '', startMs: 1, durationMs: 3 }],
            },
          ],
        },
      },
    }),
  });
  assert.equal(report.version, 2);
  assert.deepEqual(
    report.samples.map((sample) => [sample.networkMs, sample.ttfbMs]),
    [
      [6.5, 4],
      [6.5, 4],
    ],
  );
  assert.ok(report.samples[1].offsetMs >= report.samples[0].offsetMs);
  assert.equal(report.metrics.networkAverage, 6.5);
});
test('the rate model starts requests on schedule and drops starts beyond the in-flight limit', async () => {
  const report = await run(
    {
      ...defaults,
      mode: 'performance',
      loadModel: 'rate',
      targetRps: 200,
      durationSeconds: 0.25,
      concurrency: 50,
    },
    tasks,
    { send: async () => (await delay(5), reply()) },
  );
  // 200 req/s for 0.25 s schedules about 50 starts; timers may run slightly late but catch up.
  assert.ok(
    report.samples.length >= 40 && report.samples.length <= 51,
    `${report.samples.length} requests`,
  );
  assert.equal(report.dropped, 0);
  const saturated = await run(
    {
      ...defaults,
      mode: 'performance',
      loadModel: 'rate',
      targetRps: 400,
      durationSeconds: 0.2,
      concurrency: 2,
    },
    tasks,
    { send: async () => (await delay(60), reply()) },
  );
  assert.ok(
    saturated.dropped > 0,
    'a slow API under a fixed rate drops starts instead of slowing the schedule',
  );
  assert.ok(saturated.samples.length <= 2 * Math.ceil(0.2 / 0.06) + 2);
});
test('the rate model ramps up from a low rate', async () => {
  const report = await run(
    {
      ...defaults,
      mode: 'performance',
      loadModel: 'rate',
      targetRps: 100,
      durationSeconds: 0.4,
      rampUpSeconds: 0.4,
      concurrency: 20,
    },
    tasks,
    { send: async () => reply() },
  );
  const early = report.samples.filter((sample) => sample.offsetMs < 200).length,
    late = report.samples.filter((sample) => sample.offsetMs >= 200).length;
  assert.ok(late > early, `ramp-up sends more later (${early} then ${late})`);
});
test('validation only keeps the rate model for performance tests', () => {
  assert.equal(
    validateConfig({ ...defaults, mode: 'benchmark', loadModel: 'rate' }, tasks).loadModel,
    'workers',
  );
  assert.throws(
    () =>
      validateConfig({ ...defaults, mode: 'performance', loadModel: 'rate', targetRps: 0 }, tasks),
    /targetRps/,
  );
  assert.throws(
    () => validateConfig({ ...defaults, mode: 'performance', loadModel: 'other' as 'rate' }, tasks),
    /load model/,
  );
});
test('timeline buckets completions by interval and grows intervals for long runs', () => {
  const samples = [
    sampleAt({ offsetMs: 0, durationMs: 100 }),
    sampleAt({ offsetMs: 500, durationMs: 300 }),
    sampleAt({ offsetMs: 900, durationMs: 200, success: false, failure: 'http' }),
    sampleAt({ offsetMs: 1500, durationMs: 100, cancelled: true }),
  ];
  const buckets = timeline(samples, 2000);
  assert.deepEqual(
    buckets.map((bucket) => [bucket.startMs, bucket.completed, bucket.failed, bucket.rps]),
    [
      [0, 2, 0, 2],
      [1000, 1, 1, 1],
    ],
  );
  assert.equal(timeline([], 3_600_000).length, 120, 'an hour is shown in 30-second intervals');
  const sliver = timeline([sampleAt({ offsetMs: 2000, durationMs: 50 })], 2100);
  assert.deepEqual(
    sliver.map((bucket) => [bucket.startMs, bucket.durationMs, bucket.completed]),
    [
      [0, 1000, 0],
      [1000, 1100, 1],
    ],
    'a final sliver joins the previous interval',
  );
  assert.equal(timeline([], 1600).length, 2, 'a final part of at least half an interval stays');
  assert.equal(timeline([], 300).length, 1, 'a run shorter than an interval has one');
  assert.equal(timeline([], 0).length, 0);
});
test('histogram spreads latencies across equal-width bins', () => {
  const bins = histogram(
    [0, 5, 10, 10].map((durationMs) => sampleAt({ durationMs })),
    2,
  );
  assert.deepEqual(
    bins.map((bin) => [bin.fromMs, bin.toMs, bin.count]),
    [
      [0, 5, 1],
      [5, 10, 3],
    ],
  );
  assert.equal(
    histogram([sampleAt({ durationMs: 4 })]).reduce((total, bin) => total + bin.count, 0),
    1,
  );
});
test('error summary groups failures by kind and message, most frequent first', () => {
  const groups = errorSummary([
    sampleAt({ name: 'A', success: false, failure: 'transport', error: 'ECONNRESET' }),
    sampleAt({ name: 'B', success: false, failure: 'transport', error: 'ECONNRESET' }),
    sampleAt({ success: false, failure: 'http', status: 503 }),
    sampleAt({ success: false, failure: 'assertion', testsPassed: 1, testsTotal: 3 }),
    sampleAt({ success: false, failure: 'transport', error: 'ignored', cancelled: true }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.failure, group.message, group.count, group.requests]),
    [
      ['transport', 'ECONNRESET', 2, ['A', 'B']],
      ['http', 'HTTP 503', 1, ['First']],
      ['assertion', '2 of 3 assertions failed', 1, ['First']],
    ],
  );
});
test('baseline comparison flags regressions beyond the tolerance in the worse direction', async () => {
  const before = await run({ ...defaults, mode: 'benchmark', iterations: 4 }, [tasks[0]], {
    send: async () => (await delay(2), reply()),
  });
  const baseline = baselineOf(before);
  const slower = {
    ...before.metrics,
    p95: before.metrics.p95 * 1.5,
    rps: before.metrics.rps * 1.2,
    errorRate: 0,
  };
  const rows = compareToBaseline(baseline, slower);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.p95.regression, true, 'latency up 50%');
  assert.ok(Math.abs(byKey.p95.changePercent - 50) < 1e-9);
  assert.equal(byKey.rps.regression, false, 'throughput up is an improvement');
  assert.equal(byKey.errorRate.regression, false);
  const failing = compareToBaseline(baseline, { ...before.metrics, errorRate: 2 });
  assert.equal(
    failing.find((row) => row.key === 'errorRate')!.regression,
    true,
    'errors appearing regress',
  );
});
test('CSV includes timing columns and failure messages', async () => {
  const report = await run({ ...defaults, mode: 'benchmark', iterations: 1 }, [tasks[0]], {
    send: async () => ({
      response: { error: 'ECONNREFUSED 127.0.0.1' },
      testsPassed: 0,
      testsTotal: 0,
      error: 'ECONNREFUSED <redacted>',
    }),
  });
  const [header, row] = csv(report).split('\r\n');
  assert.match(header, /"offset_ms","latency_ms","network_ms","ttfb_ms"/);
  assert.match(header, /"failure","error"$/);
  assert.match(row, /"transport","ECONNREFUSED <redacted>"$/);
});
