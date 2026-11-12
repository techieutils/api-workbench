/**
 * The requests of a `.http` file, found the way the command line reads one (common
 * `collection-formats/text-formats.ts`, `httpFile`), with the lines they start on so the editor can
 * put **Send request** above each. A request's `id` is its position, `1`, `2`, …, which is the id
 * `request send --file` gives it. Only the text is read; nothing in it is run.
 */

import {
  httpFile,
  httpFileReferences,
} from '@techieutils/api-workbench-common/collection-formats/text-formats';

const REQUEST_LINE =
  /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+)?(?:https?:\/\/|\{\{)/i;
// `s`, so a stray carriage return or line separator in the line is part of the URL rather than
// leaving nothing to match (found by fuzzing).
const REQUEST_PARTS =
  /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+)?(.+?)(?:\s+HTTP\/\S+)?$/is;
const VARIABLE = /^@([\w.-]+)\s*=\s*(.*)$/;
const SEPARATOR = /^\s*###/;

export interface HttpFileRequest {
  /** Its position in the file, as `request send --file` names it. */
  id: string;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string;
  /** The zero-based line of its `###` separator, or of the request line for the first. */
  startLine: number;
  /** The zero-based line of `GET https://…`. */
  requestLine: number;
  /** The zero-based line after its last. */
  endLine: number;
}

export interface HttpFile {
  requests: HttpFileRequest[];
  /** `@name = value` lines, the file's variables. */
  variables: Record<string, string>;
  /** A line the command line will refuse, so no request in the file can be sent. */
  problem?: { line: number; message: string };
}

export function parseHttpFile(text: string): HttpFile {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const variables: Record<string, string> = {};
  // Variable lines are removed before the file is split, so they read as blank lines.
  const plain = lines.map((line) => {
    const match = line.match(VARIABLE);
    if (!match) return line;
    variables[match[1]] = match[2];
    return '';
  });
  const starts = [0];
  plain.forEach((line, index) => {
    if (index > 0 && SEPARATOR.test(line)) starts.push(index);
  });
  const requests: HttpFileRequest[] = [];
  let problem: HttpFile['problem'];
  starts.forEach((start, chunkIndex) => {
    const end = starts[chunkIndex + 1] ?? plain.length;
    const chunk = plain.slice(start, end);
    // The separator line keeps what follows `###` (the request's name) as its first line.
    if (SEPARATOR.test(chunk[0])) chunk[0] = chunk[0].replace(/^\s*###\s*/, '');
    const at = chunk.findIndex((line) => REQUEST_LINE.test(line.trim()));
    if (at < 0) return;
    const parts = chunk[at].trim().match(REQUEST_PARTS)!;
    const name =
      chunk
        .slice(0, at)
        .find((line) => line.trim() && !line.startsWith('#'))
        ?.trim() || `Request ${requests.length + 1}`;
    const headers: HttpFileRequest['headers'] = [];
    let index = at + 1;
    for (; index < chunk.length && chunk[index].trim(); index++) {
      if (/^\s*(#|\/\/)/.test(chunk[index])) continue;
      const header = chunk[index].match(/^([^:]+):\s*(.*)$/);
      if (!header) {
        problem ??= {
          line: start + index,
          message: `Invalid HTTP header: ${chunk[index]}`,
        };
        continue;
      }
      headers.push({ key: header[1], value: header[2] });
    }
    requests.push({
      id: String(requests.length + 1),
      name,
      method: (parts[1] || 'GET').toUpperCase(),
      url: parts[2],
      headers,
      body: chunk
        .slice(index + 1)
        .join('\n')
        .replace(/\n+$/, ''),
      startLine: SEPARATOR.test(plain[start]) ? start : start + at,
      requestLine: start + at,
      endLine: end,
    });
  });
  return { requests, variables, ...(problem ? { problem } : {}) };
}

/** The request whose lines hold `line`, for Send Request at the cursor. */
export function requestAtLine(file: HttpFile, line: number): HttpFileRequest | undefined {
  return (
    file.requests.find((request) => line >= request.startLine && line < request.endLine) ??
    // Above the first request: the first one.
    (file.requests[0] && line < file.requests[0].startLine ? file.requests[0] : undefined)
  );
}

/**
 * The `request create` arguments that save one request of a file into a collection, keeping its
 * `{{variables}}` as written so the workspace's environments fill them in.
 */
export function createArgs(request: HttpFileRequest, collection: string): string[] {
  // `--option=value`, so a value that starts with a dash is not read as an option.
  // The name is a positional, which cannot start with a dash.
  const args = [request.name.replace(/^-+/, ''), `--collection=${collection}`];
  args.push(`--method=${request.method}`, `--url=${request.url}`);
  const files = bodyFiles(request);
  for (const header of request.headers)
    // A multipart form's boundary is chosen when it is sent, so its Content-Type is not kept.
    if (files?.bodyType !== 'form-data' || header.key.trim().toLowerCase() !== 'content-type')
      args.push(`--header=${header.key}: ${header.value}`);
  // A file body or a form is set after the request is made (`savedBodyPlan`), not as text.
  if (request.body && !files) args.push(`--body=${request.body}`);
  return args;
}

/**
 * The `request update` that gives a request saved from a `.http` file its file body or form:
 * the body type, the file's name, and the form's fields (on standard input). The files themselves
 * are chosen in the request editor, as for any saved request.
 */
export function savedBodyPlan(
  request: HttpFileRequest,
): { args: string[]; input?: string } | undefined {
  const files = bodyFiles(request);
  if (!files) return undefined;
  if (files.bodyType === 'binary')
    return {
      args: [
        '--body-type=binary',
        ...(files.binaryName ? [`--binary-name=${files.binaryName}`] : []),
      ],
    };
  return {
    args: ['--body-type=form-data', '--form-fields=-'],
    input: JSON.stringify(
      files.form.map((row) =>
        row.kind === 'file'
          ? {
              key: row.key,
              value: '',
              enabled: row.enabled,
              kind: 'file',
              ...(row.fileName ? { fileName: row.fileName } : {}),
            }
          : { key: row.key, value: row.value, enabled: row.enabled, kind: 'text' },
      ),
    ),
  };
}

/** Whether a YAML or JSON document is an OpenAPI or Swagger specification. */
export function isSpecText(text: string): boolean {
  const head = text.slice(0, 4000);
  return /(?:^|[{,])\s*["']?(?:openapi|swagger)["']?\s*:/m.test(head);
}

/**
 * The files a `.http` request sends, read as the command line reads them: a body of one
 * `< ./path` line is that file; a `multipart/form-data` body is a form, its `< ./path` parts file
 * fields. Paths are as written, relative to the file; undefined for a body that is text.
 */
export interface HttpBodyFiles {
  bodyType: 'binary' | 'form-data';
  binaryName?: string;
  form: { key: string; value: string; enabled: boolean; kind?: 'file'; fileName?: string }[];
  /** The paths as the file writes them: the body's, and file fields' by name. */
  files: { binary?: string; fields: Record<string, string> };
}

export function bodyFiles(request: HttpFileRequest): HttpBodyFiles | undefined {
  if (
    !/^\s*</m.test(request.body) &&
    !/multipart\/form-data/i.test(JSON.stringify(request.headers))
  )
    return undefined;
  const text = [
    `${request.method} ${request.url}`,
    ...request.headers.map((header) => `${header.key}: ${header.value}`),
    '',
    request.body,
  ].join('\n');
  let parsed;
  try {
    parsed = httpFile(text).requests[0];
  } catch {
    return undefined;
  }
  if (!parsed || (parsed.bodyType !== 'binary' && parsed.bodyType !== 'form-data'))
    return undefined;
  const files = httpFileReferences(text)[0] ?? { fields: {} };
  return {
    bodyType: parsed.bodyType,
    ...(parsed.binaryName ? { binaryName: parsed.binaryName } : {}),
    form: (parsed.bodyFields ?? []).map((field) =>
      field.kind === 'file'
        ? {
            key: field.key,
            value: '',
            enabled: field.enabled,
            kind: 'file' as const,
            ...(field.fileName ? { fileName: field.fileName } : {}),
          }
        : { key: field.key, value: field.value, enabled: field.enabled },
    ),
    files,
  };
}
