import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceMonitor, summarizeResources, resourcesCsv } from './runner-resources';
import { run, defaults } from './runner';

test('resource summary uses time-weighted CPU, sampled memory peaks, and signed memory change', () => {
  const report = summarizeResources([
    { elapsedMs: 0, intervalMs: 0, cpuPercent: null, memoryBytes: 100, processCount: 3 },
    { elapsedMs: 100, intervalMs: 100, cpuPercent: 10, memoryBytes: 200, processCount: 3 },
    { elapsedMs: 400, intervalMs: 300, cpuPercent: 30, memoryBytes: 80, processCount: 4 },
  ]);
  assert.equal(report.averageCpuPercent, 25);
  assert.equal(report.peakCpuPercent, 30);
  assert.equal(report.peakMemoryBytes, 200);
  assert.equal(report.memoryChangeBytes, -20);
  assert.equal(report.latestMemoryBytes, 80);
  assert.equal(summarizeResources([]).averageCpuPercent, null);
  assert.equal(summarizeResources([]).peakMemoryBytes, null);
  assert.equal(resourcesCsv(report).split('\r\n').length, 4);
  assert.ok(resourcesCsv(report).includes('0,0,,100,3'));
});
test('monitor discards baseline CPU and collects final sample without waiting for periodic timer', async () => {
  let reads = 0;
  const monitor = createResourceMonitor(async () => ({
    timestampMs: ++reads * 100,
    cpuPercent: reads * 10,
    memoryBytes: reads * 1024,
    processCount: 3,
  }));
  await monitor.start();
  await monitor.stop();
  const report = monitor.report();
  assert.equal(reads, 2);
  assert.equal(report.samples[0].cpuPercent, null);
  assert.equal(report.averageCpuPercent, 20);
  assert.equal(report.latestMemoryBytes, 2048);
});
test('unavailable or invalid resource readings are counted without breaking monitoring', async () => {
  const monitor = createResourceMonitor(async () => {
    throw new Error('unavailable');
  });
  await monitor.start();
  await monitor.stop();
  assert.equal(monitor.report().failures, 2);
  assert.equal(monitor.report().samples.length, 0);
  const invalid = createResourceMonitor(async () => ({
    timestampMs: 0,
    cpuPercent: NaN,
    memoryBytes: -1,
    processCount: 0,
  }));
  await invalid.start();
  await invalid.stop();
  assert.equal(invalid.report().failures, 2);
});
test('runner resources exclude warmups, export with report and do not fail runs on monitoring errors', async () => {
  let reads = 0,
    sends = 0;
  const tasks = [{ id: 'a', name: 'Request', method: 'GET' }];
  const report = await run({ ...defaults, mode: 'benchmark', warmupIterations: 1 }, tasks, {
    send: async () => {
      sends++;
      return { response: { error: 'Expected fixture' }, testsPassed: 0, testsTotal: 0 };
    },
    readResources: async () => {
      assert.ok(sends >= 1);
      return { timestampMs: ++reads * 50, cpuPercent: 5, memoryBytes: 100, processCount: 2 };
    },
  });
  assert.equal(report.warmupCompleted, 1);
  assert.equal(report.resources?.samples.length, 2);
  assert.equal(report.resources?.averageCpuPercent, 5);
  const failedMonitor = await run(defaults, tasks, {
    send: async () => ({ response: { error: 'Expected fixture' }, testsPassed: 0, testsTotal: 0 }),
    readResources: async () => {
      throw new Error('monitor unavailable');
    },
  });
  assert.equal(failedMonitor.metrics.completed, 1);
  assert.equal(failedMonitor.resources?.failures, 2);
});
