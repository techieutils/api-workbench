import { statusLine, type SendResult } from './report';

/**
 * A sent request's response as a read-only document: the status, the request line, the headers,
 * the tests and captures, then the body — JSON indented — as the command line prints it. Header
 * values the command line hides (`<hidden>`) stay hidden.
 */
export function renderResponse(result: SendResult, method: string): string {
  const lines: string[] = [];
  lines.push(
    statusLine(result) +
      (result.httpVersion && !result.error ? ` · HTTP/${result.httpVersion}` : ''),
  );
  if (result.url) lines.push(`${method} ${result.url}`);
  if (result.headers && Object.keys(result.headers).length) {
    lines.push('');
    for (const [name, value] of Object.entries(result.headers)) lines.push(`${name}: ${value}`);
  }
  if (result.tests.length || result.captures.length) {
    lines.push('');
    for (const test of result.tests)
      lines.push(
        `${test.pass ? '✓' : '✗'} ${test.label}${!test.pass && test.message ? ` — ${test.message}` : ''}`,
      );
    for (const capture of result.captures) {
      const name = capture.variable ?? capture.name ?? '';
      lines.push(capture.error ? `✗ capture ${name}: ${capture.error}` : `captured ${name}`);
    }
  }
  if (result.body !== undefined && result.body !== '') {
    lines.push('', formatBody(result.body, result.headers?.['content-type']));
  }
  return `${lines.join('\n')}\n`;
}

/** JSON bodies indented; anything else as it came. */
export function formatBody(body: string, contentType = ''): string {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

/** A short, file-name-safe title for the response tab: `List users · 200`. */
export function responseTitle(result: SendResult): string {
  const name = result.request.name.replace(/[\\/:*?"<>|]/g, '-');
  return `${name} · ${result.error ? 'no response' : (result.status ?? '')}`;
}
