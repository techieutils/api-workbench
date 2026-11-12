import type { RunOutcome, RunResult } from './run';

/**
 * Reports of a run: lines for the console as requests finish, a summary, JSON for tools, and
 * JUnit XML, which CI systems (GitHub Actions, GitLab, Jenkins, Azure DevOps) show as test results.
 * None of them include headers, bodies, or variable values: only names, URLs without secrets,
 * statuses, timings, and test messages.
 */

export interface Painter {
  pass(text: string): string;
  fail(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}
export const painter = (color: boolean): Painter => {
  const wrap = (code: number, reset: number) => (text: string) =>
    color ? `\u001b[${code}m${text}\u001b[${reset}m` : text;
  return { pass: wrap(32, 39), fail: wrap(31, 39), dim: wrap(2, 22), bold: wrap(1, 22) };
};

const ms = (value: number) => `${Math.round(value)} ms`;
/** Text a person typed into a request or test, without control characters that move the cursor. */
export const printable = (text: string) =>
  // eslint-disable-next-line no-control-regex -- Removing control characters is the point.
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** A request's line as it finishes, with its failing tests and capture problems beneath. */
export function resultLines(result: RunResult, paint: Painter, quiet: boolean): string[] {
  if (quiet && result.passed) return [];
  const mark = result.passed ? paint.pass('✓') : paint.fail('✗');
  const status = result.error !== undefined ? paint.fail('error') : String(result.status);
  const lines = [
    `  ${mark} ${result.request.method.padEnd(6)} ${printable(result.request.name)}  ${status}  ${paint.dim(ms(result.durationMs))}`,
  ];
  if (!result.passed || !quiet) lines.push(`      ${paint.dim(printable(result.url))}`);
  if (result.error !== undefined) lines.push(`      ${paint.fail(printable(result.error))}`);
  for (const test of result.tests)
    if (!test.pass)
      lines.push(
        `      ${paint.fail('✗')} ${printable(test.name || test.label)}: ${printable(test.message)}`,
      );
    else if (!quiet)
      lines.push(`      ${paint.pass('✓')} ${paint.dim(printable(test.name || test.label))}`);
  if (!result.tests.length && result.error === undefined && !result.passed)
    lines.push(
      `      ${paint.fail('✗')} Status ${result.status} is outside 200–399, and the request has no tests`,
    );
  for (const capture of result.captures)
    if (capture.error)
      lines.push(`      ${paint.dim(`capture ${capture.variable}: ${printable(capture.error)}`)}`);
  // What the request's scripts logged, after its results; failures show it even when quiet.
  for (const log of result.logs ?? [])
    lines.push(
      `      ${paint.dim(`${log.phase === 'pre' ? 'pre-request' : 'post-response'} ›`)} ${
        log.level === 'error' || log.level === 'warn'
          ? paint.fail(printable(log.message))
          : printable(log.message)
      }`,
    );
  return lines;
}
/** The line before each iteration of a run with several, naming the data row's first values. */
export function iterationLine(
  outcome: Pick<RunOutcome, 'data'>,
  iteration: number,
  total: number,
  paint: Painter,
): string {
  const row = outcome.data?.rows[iteration - 1];
  const values = row
    ? Object.entries(row)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${value.length > 30 ? `${value.slice(0, 29)}…` : value}`)
        .join(', ')
    : '';
  return paint.bold(`Iteration ${iteration}/${total}${values ? ` (${printable(values)})` : ''}`);
}
export function summaryLines(outcome: RunOutcome, paint: Painter): string[] {
  const failed = outcome.results.filter((result) => !result.passed).length;
  const tests = outcome.results.flatMap((result) => result.tests);
  const testsFailed = tests.filter((test) => !test.pass).length;
  const lines = [
    '',
    `${outcome.results.length} ${outcome.results.length === 1 ? 'request' : 'requests'}: ${paint.pass(`${outcome.results.length - failed} passed`)}${failed ? `, ${paint.fail(`${failed} failed`)}` : ''}${outcome.skipped ? `, ${outcome.skipped} skipped` : ''}`,
    `${tests.length} ${tests.length === 1 ? 'test' : 'tests'}: ${paint.pass(`${tests.length - testsFailed} passed`)}${testsFailed ? `, ${paint.fail(`${testsFailed} failed`)}` : ''}`,
    paint.dim(
      `Average ${ms(outcome.report.metrics.average)} · p95 ${ms(outcome.report.metrics.p95)} · ${ms(outcome.report.elapsedMs)} in all`,
    ),
  ];
  if (outcome.bailed) lines.push(paint.fail('Stopped at the first failure (--bail).'));
  if (outcome.interrupted)
    lines.push(paint.fail('Interrupted: the run was stopped before it finished.'));
  return lines;
}

/** Every request ran and passed. */
export const runPassed = (
  outcome: Pick<RunOutcome, 'results' | 'bailed' | 'interrupted' | 'report'>,
) =>
  !outcome.interrupted &&
  (outcome.report.mode === 'collection'
    ? outcome.results.every((result) => result.passed) && !outcome.bailed
    : // A load test passes by its thresholds: its error rate, latency, and throughput.
      outcome.report.outcome === 'passed');

/** The line before a load test, saying what it will do. */
export function loadPlan(load: NonNullable<import('./args').RunOptions['load']>, requests: number) {
  const each = `${requests} ${requests === 1 ? 'request' : 'requests'}`;
  const concurrency = `${load.concurrency ?? 1} at a time`;
  return load.mode === 'benchmark'
    ? `Benchmark: ${each}, ${concurrency}`
    : `Performance: ${each} for ${load.durationSeconds ?? 10} s, ${load.targetRps ? `${load.targetRps} a second` : concurrency}${load.rampUpSeconds ? `, ramping up over ${load.rampUpSeconds} s` : ''}`;
}
/** A load test's summary: throughput, latency, errors, and each threshold with its result. */
export function loadSummaryLines(outcome: RunOutcome, paint: Painter): string[] {
  const { metrics, thresholds } = outcome.report;
  const lines = [
    '',
    `${metrics.completed} requests in ${(outcome.report.elapsedMs / 1000).toFixed(1)} s · ${metrics.rps.toFixed(1)} a second · ${metrics.failed ? paint.fail(`${metrics.failed} failed`) : paint.pass('0 failed')} (${metrics.errorRate.toFixed(2)}%)`,
    paint.dim(
      `Latency: average ${ms(metrics.average)} · p50 ${ms(metrics.p50)} · p90 ${ms(metrics.p90)} · p95 ${ms(metrics.p95)} · p99 ${ms(metrics.p99)} · max ${ms(metrics.max)}`,
    ),
  ];
  if (metrics.transportErrors || metrics.httpErrors || metrics.assertionFailures)
    lines.push(
      paint.dim(
        `Failures: ${metrics.transportErrors} no response · ${metrics.httpErrors} HTTP status · ${metrics.assertionFailures} tests`,
      ),
    );
  for (const group of outcome.report.errors.slice(0, 5))
    lines.push(`  ${paint.fail('✗')} ${printable(group.message)} ×${group.count}`);
  for (const check of thresholds)
    lines.push(
      `  ${check.passed ? paint.pass('✓') : paint.fail('✗')} ${check.name}: ${Number(check.actual.toFixed(2))} (limit ${check.limit})`,
    );
  lines.push(
    outcome.report.outcome === 'passed'
      ? paint.pass('Passed')
      : paint.fail(
          outcome.report.outcome === 'cancelled' ? 'Stopped before it finished.' : 'Failed',
        ),
  );
  return lines;
}

/** The JSON report: the run's settings, every request's outcome and tests, and the timings. */
export function jsonReport(outcome: RunOutcome, startedAt: string) {
  return {
    tool: 'api-workbench',
    version: 1,
    startedAt,
    source: { name: outcome.source.name, kind: outcome.source.kind },
    environment: outcome.environment,
    ...(outcome.tags ? { tags: outcome.tags } : {}),
    ...(outcome.data
      ? {
          data: {
            file: outcome.data.name,
            format: outcome.data.format,
            rows: outcome.data.rows.length,
            columns: outcome.data.columns,
          },
        }
      : {}),
    passed: runPassed(outcome),
    ...(outcome.interrupted ? { interrupted: true } : {}),
    summary: {
      requests: outcome.results.length,
      failed: outcome.results.filter((result) => !result.passed).length,
      skipped: outcome.skipped,
      tests: outcome.results.reduce((sum, result) => sum + result.tests.length, 0),
      testsFailed: outcome.results.reduce(
        (sum, result) => sum + result.tests.filter((test) => !test.pass).length,
        0,
      ),
      elapsedMs: outcome.report.elapsedMs,
    },
    metrics: outcome.report.metrics,
    // A load test reports its thresholds and errors; its every sample would be too many.
    ...(outcome.report.mode === 'collection'
      ? { results: outcome.results }
      : {
          mode: outcome.report.mode,
          config: outcome.report.config,
          thresholds: outcome.report.thresholds,
          errors: outcome.report.errors,
          timeline: outcome.report.timeline,
        }),
  };
}

const xml = (value: unknown) =>
  printable(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const seconds = (value: number) => (value / 1000).toFixed(3);
/** A load test as JUnit: one test case per threshold, so CI shows which limit was missed. */
function loadJunit(outcome: RunOutcome): string {
  const { thresholds, elapsedMs, mode } = outcome.report;
  const failures = thresholds.filter((check) => !check.passed).length;
  const name = `${outcome.source.name} · ${mode}`;
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(name)}" tests="${thresholds.length}" failures="${failures}" errors="0" time="${seconds(elapsedMs)}">`,
    `  <testsuite name="${xml(name)}" tests="${thresholds.length}" failures="${failures}" errors="0" time="${seconds(elapsedMs)}">`,
    ...thresholds.flatMap((check) => [
      `    <testcase classname="load" name="${xml(check.name)}" time="0">`,
      ...(check.passed
        ? []
        : [
            `      <failure message="${xml(`${check.name}: ${check.actual} (limit ${check.limit})`)}" type="threshold"/>`,
          ]),
      '    </testcase>',
    ]),
    '  </testsuite>',
    '</testsuites>',
  ].join('\n')}\n`;
}
/**
 * JUnit XML: a test suite per collection (and per iteration when there are several), a test
 * case per request sent, with a failure for failing tests and an error when no response came.
 */
export function junitReport(outcome: RunOutcome): string {
  if (outcome.report.mode !== 'collection') return loadJunit(outcome);
  const iterations = outcome.report.config.iterations;
  const suites = new Map<string, RunResult[]>();
  for (const result of outcome.results) {
    const collection = result.request.folder.split('/')[0] || outcome.source.name;
    const key = iterations > 1 ? `${collection} · iteration ${result.iteration}` : collection;
    suites.set(key, [...(suites.get(key) ?? []), result]);
  }
  const count = (results: RunResult[]) => ({
    tests: results.length,
    failures: results.filter((result) => !result.passed && result.error === undefined).length,
    errors: results.filter((result) => result.error !== undefined).length,
    time: seconds(results.reduce((sum, result) => sum + result.durationMs, 0)),
  });
  const all = count(outcome.results);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(outcome.source.name)}" tests="${all.tests}" failures="${all.failures}" errors="${all.errors}" time="${all.time}">`,
  ];
  for (const [name, results] of suites) {
    const totals = count(results);
    lines.push(
      `  <testsuite name="${xml(name)}" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" time="${totals.time}">`,
    );
    for (const result of results) {
      lines.push(
        `    <testcase classname="${xml(result.request.folder.replaceAll('/', '.'))}" name="${xml(`${result.request.method} ${result.request.name}`)}" time="${seconds(result.durationMs)}">`,
      );
      if (result.error !== undefined)
        lines.push(`      <error message="${xml(result.error)}" type="request"/>`);
      else if (!result.passed) {
        const failing = result.tests.filter((test) => !test.pass);
        const message = failing.length
          ? failing.map((test) => `${test.name || test.label}: ${test.message}`).join('; ')
          : `Status ${result.status} is outside 200–399, and the request has no tests`;
        lines.push(
          `      <failure message="${xml(message)}" type="assertion">${xml(
            [
              `${result.request.method} ${result.url} → ${result.status}`,
              ...failing.map((test) => `✗ ${test.name || test.label}: ${test.message}`),
            ].join('\n'),
          )}</failure>`,
        );
      }
      lines.push(
        `      <system-out>${xml(`${result.request.method} ${result.url} → ${result.status ?? 'no response'} in ${Math.round(result.durationMs)} ms`)}</system-out>`,
      );
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}
