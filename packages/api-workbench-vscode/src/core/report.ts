import type { ListedRequest } from './model';

/**
 * Running requests: which `run` arguments send exactly the requests chosen, and what each request's
 * outcome was in the JSON report (`--report-json`) or a `request send --json` result.
 */

/** One request's result, as `run --report-json` lists them and `request send --json` prints one. */
export interface SendResult {
  iteration?: number;
  request: { id: string; name: string; method: string; folder: string };
  url?: string;
  status?: number;
  statusText?: string;
  httpVersion?: string;
  durationMs?: number;
  size?: number;
  error?: string;
  tests: { label: string; pass: boolean; message: string; line?: number }[];
  captures: { name?: string; variable?: string; value?: string; error?: string }[];
  passed: boolean;
  headers?: Record<string, string>;
  body?: string;
  /** Where the time went, hop by hop, and the server's TLS connection: `request send --json`. */
  timings?: import('@techieutils/api-workbench-common/types').NetworkTiming;
  tls?: import('@techieutils/api-workbench-common/types').TLSConnectionInfo;
}
export interface RunReport {
  passed: boolean;
  environment?: string;
  summary: {
    requests: number;
    failed: number;
    skipped: number;
    tests: number;
    testsFailed: number;
    elapsedMs: number;
  };
  results: SendResult[];
  interrupted?: boolean;
}

/**
 * The `run` options that send `chosen` requests of a source. All of its runnable requests is a
 * plain run; otherwise the requests by id, since `-c` and `-r` narrow each other rather than add
 * up. Requests the command line cannot run (live protocols) are left out; none left is `undefined`.
 */
export function selectionArgs(chosen: ListedRequest[], all: ListedRequest[]): string[] | undefined {
  const runnable = new Set(all.filter((request) => request.runnable).map((request) => request.id));
  const ids = [...new Set(chosen.map((request) => request.id))].filter((id) => runnable.has(id));
  if (!ids.length) return undefined;
  if (ids.length === runnable.size) return [];
  return ids.flatMap((id) => ['-r', id]);
}

export interface Outcome {
  state: 'passed' | 'failed' | 'errored';
  durationMs: number;
  /** One line per failed test or error, for the test view. */
  messages: string[];
  /** Status and timing, for the run's output. */
  summary: string;
}

/**
 * Each request's outcome in a report. A request sent several times (iterations or data rows)
 * passes only when every send passed; its messages say which send failed.
 */
export function outcomes(report: RunReport): Map<string, Outcome> {
  const byRequest = new Map<string, SendResult[]>();
  for (const result of report.results) {
    const list = byRequest.get(result.request.id) ?? [];
    list.push(result);
    byRequest.set(result.request.id, list);
  }
  const found = new Map<string, Outcome>();
  for (const [id, results] of byRequest) {
    const several = results.length > 1;
    const messages: string[] = [];
    let errored = false;
    for (const [index, result] of results.entries()) {
      const prefix = several ? `Send ${index + 1}: ` : '';
      if (result.error) {
        errored = true;
        messages.push(`${prefix}${result.error}`);
      }
      for (const test of result.tests)
        if (!test.pass)
          messages.push(`${prefix}${test.label}${test.message ? ` — ${test.message}` : ''}`);
      if (!result.passed && !result.error && !result.tests.some((test) => !test.pass))
        messages.push(`${prefix}Status ${result.status ?? '—'} is outside 200–399`);
    }
    const last = results[results.length - 1];
    found.set(id, {
      state: results.every((result) => result.passed) ? 'passed' : errored ? 'errored' : 'failed',
      durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
      messages,
      summary: statusLine(last),
    });
  }
  return found;
}

/** `200 OK · 84 ms · 412 B`, or the error. */
export function statusLine(result: SendResult): string {
  if (result.error) return `No response · ${result.error}`;
  return [
    `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
    result.durationMs === undefined ? '' : `${Math.round(result.durationMs)} ms`,
    result.size === undefined ? '' : formatBytes(result.size),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
