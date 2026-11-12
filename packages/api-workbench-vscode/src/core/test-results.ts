import type { RunReport } from './report';

/**
 * The Test results page, opened when a run finishes: a summary as the app's runner shows it, each
 * request's outcome with its tests (failures first to read), and the run's whole output as the
 * command line printed it. Values come from the run's report, which holds no secret values.
 */
export interface TestResultsView {
  view: 'testResults';
  workspace: string;
  /** What ran: “Users”, “List users”, or “every request”. */
  scope: string;
  environment?: string;
  finishedAt: string;
  passed: boolean;
  interrupted: boolean;
  summary: {
    requests: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
    tests: number;
    testsFailed: number;
    durationMs: number;
  };
  results: TestResultRow[];
  /** The run's report as the command line printed it. */
  output: string;
}

export interface TestResultRow {
  id: string;
  name: string;
  folder: string;
  method: string;
  /** `200 OK`, or why it got no response. */
  status: string;
  state: 'passed' | 'failed' | 'errored';
  durationMs?: number;
  tests: { label: string; pass: boolean; message: string }[];
  error?: string;
}

/** Terminal colour codes, such as the command line's green ✓, built so no control character is written. */
const COLOUR_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The page's view of a finished run. */
export function testResultsView(
  report: RunReport,
  output: string,
  meta: { workspace: string; scope: string; environment?: string; finishedAt: string },
): TestResultsView {
  const results: TestResultRow[] = report.results.map((result) => ({
    id: result.request.id,
    name: result.request.name,
    folder: result.request.folder,
    method: result.request.method,
    status: result.error
      ? 'No response'
      : `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
    state: result.error ? 'errored' : result.passed ? 'passed' : 'failed',
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    tests: result.tests.map(({ label, pass, message }) => ({ label, pass, message })),
    ...(result.error ? { error: result.error } : {}),
  }));
  const count = (state: TestResultRow['state']) =>
    results.filter((row) => row.state === state).length;
  return {
    view: 'testResults',
    ...meta,
    passed: report.passed,
    interrupted: Boolean(report.interrupted),
    summary: {
      requests: report.summary.requests,
      passed: count('passed'),
      failed: count('failed'),
      errored: count('errored'),
      skipped: report.summary.skipped,
      tests: report.summary.tests,
      testsFailed: report.summary.testsFailed,
      durationMs: report.summary.elapsedMs,
    },
    results,
    // Colour codes are left out: the page shows the report as plain text.
    output: output.replace(COLOUR_CODES, ''),
  };
}
