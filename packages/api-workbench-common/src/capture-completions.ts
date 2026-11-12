import { formatJSONPath } from './capture-suggestions';
import {
  CERTIFICATE_CONNECTION_FIELDS,
  CERTIFICATE_FIELDS,
  CAPTURE_TRANSFORM_NAMES,
  TIMING_PHASES,
  captureSteps,
  queryJSON,
  responseCookies,
} from './variables';
import { regexArgument } from './assertions';
import type { HttpResponse } from './types';
import { BODY_FORMAT_NAMES, parseBody } from './structured-body';

/**
 * Completions for a capture's source as it is typed: the kinds of source, then what the last
 * response holds for the kind chosen (its JSON paths, headers, cookies, form fields), and after
 * `|`, the transforms. Each completion is the whole source it would make, so choosing one
 * replaces the text before the cursor.
 */
export interface CaptureCompletion {
  /** The whole source once chosen. */
  value: string;
  /** What is shown: the part being completed. */
  label: string;
  detail: string;
  /** The heading it is listed under: Sources, Body, Headers, Cookies, Status, Transforms, … */
  group: string;
  /** A short tag beside it, such as the body's format (JSON, XML, …). */
  badge?: string;
}
/** The heading for what a kind of source offers. */
const GROUPS: Record<string, string> = {
  $: 'Body',
  'body.': 'Body',
  header: 'Headers',
  'header.': 'Headers',
  cookie: 'Cookies',
  'cookie.': 'Cookies',
  'status.': 'Status',
  form: 'Form fields',
  timing: 'Timing',
  certificate: 'Certificate',
};
const grouped =
  (group: string) =>
  (item: { insert: string; detail: string; label?: string; badge?: string }) => ({
    ...item,
    group,
  });

/** The kinds of source, in the order a person reaches for them. */
export const CAPTURE_SOURCES: readonly { insert: string; label: string; detail: string }[] = [
  {
    insert: 'body.',
    label: 'body.path',
    detail: 'A value in the body: JSON, XML, YAML, form, NDJSON, or CSV',
  },
  { insert: 'header.', label: 'header.name', detail: 'A response header, case-insensitive' },
  { insert: 'cookie.', label: 'cookie.name', detail: 'A cookie the response sets' },
  { insert: 'status.code', label: 'status.code', detail: 'The HTTP status code, such as 200' },
  { insert: 'status.text', label: 'status.text', detail: 'The status text, such as OK' },
  { insert: 'body', label: 'body', detail: 'The whole response body, as text' },
  { insert: '$.', label: '$.path', detail: 'A JSON path in the body (same as body.path)' },
  { insert: 'time', label: 'time', detail: 'How long the request took, in ms' },
  { insert: 'size', label: 'size', detail: 'The response size, in bytes' },
  { insert: 'regex /', label: 'regex /…/', detail: 'A regular expression group from the body' },
  { insert: 'between "', label: 'between "…" "…"', detail: 'The text between two markers' },
  { insert: 'html ', label: 'html selector @attr', detail: 'An HTML element’s text or attribute' },
  { insert: 'form ', label: 'form field', detail: 'A field of a form-encoded body' },
  { insert: 'timing ', label: 'timing phase', detail: 'A network timing in ms' },
  { insert: 'certificate ', label: 'certificate field', detail: 'A detail of the TLS certificate' },
  { insert: 'error', label: 'error', detail: 'Why the request failed; runs when it fails' },
];
/** Transforms after `|`, with what each does. */
export const CAPTURE_TRANSFORMS: readonly { insert: string; detail: string }[] = [
  { insert: 'first', detail: 'The first item of a list' },
  { insert: 'last', detail: 'The last item of a list' },
  { insert: 'at ', detail: 'The item (or character) at a position; -1 is the last' },
  { insert: 'length', detail: 'How many items, or characters' },
  { insert: 'join ", "', detail: 'A list as text, with a separator' },
  { insert: 'split ","', detail: 'Text as a list, split at a separator' },
  { insert: 'slice ', detail: 'Part of a list or text: slice 0 3' },
  { insert: 'unique', detail: 'A list without repeated items' },
  { insert: 'sort', detail: 'A list in order; sort desc for the reverse' },
  { insert: 'reverse', detail: 'A list or text back to front' },
  { insert: 'keys', detail: 'An object’s keys, as a list' },
  { insert: 'values', detail: 'An object’s values, as a list' },
  { insert: 'trim', detail: 'Without spaces at either end' },
  { insert: 'lower', detail: 'In lowercase' },
  { insert: 'upper', detail: 'In uppercase' },
  { insert: 'replace "', detail: 'Every "from" replaced with "to"' },
  { insert: 'prefix "', detail: 'Text added before the value' },
  { insert: 'suffix "', detail: 'Text added after the value' },
  { insert: 'regex /', detail: 'A regular expression group of the value' },
  { insert: 'between "', detail: 'The text between two markers' },
  { insert: 'json $.', detail: 'A JSON path into the value, parsed as JSON' },
  { insert: 'jwt $.', detail: 'A claim of the value, decoded as a JWT' },
  { insert: 'base64-decode', detail: 'Decoded from Base64' },
  { insert: 'base64-encode', detail: 'Encoded as Base64' },
  { insert: 'url-decode', detail: 'Decoded from URL encoding' },
  { insert: 'url-encode', detail: 'Encoded for a URL' },
  { insert: 'sum', detail: 'The total of a list of numbers' },
  { insert: 'min', detail: 'The smallest number of a list' },
  { insert: 'max', detail: 'The largest number of a list' },
  { insert: 'avg', detail: 'The average of a list of numbers' },
  { insert: 'round', detail: 'A number rounded; round 2 keeps two decimals' },
  { insert: 'add ', detail: 'A number plus another' },
  { insert: 'subtract ', detail: 'A number minus another' },
  { insert: 'multiply ', detail: 'A number times another' },
  { insert: 'divide ', detail: 'A number divided by another' },
  { insert: 'date', detail: 'A date or Unix time as an ISO 8601 date' },
  { insert: 'epoch', detail: 'A date as Unix time in seconds' },
  { insert: 'epoch-ms', detail: 'A date as Unix time in milliseconds' },
  { insert: 'if-empty "', detail: 'This value when the result is empty' },
  { insert: 'default "', detail: 'This value when an earlier step fails' },
];
const TIMING_NAMES = ['total', 'ttfb', 'preparation', ...TIMING_PHASES, 'connect'];
const MAX_PATHS = 200;
const LIMIT = 40;

/** Every JSON path in a value, breadth first: objects by key, lists by their first item and `[*]`. */
function jsonPaths(root: unknown): { path: string; sample: unknown }[] {
  const found: { path: string; sample: unknown }[] = [];
  const queue: { segments: (string | number)[]; value: unknown; every?: boolean }[] = [
    { segments: [], value: root },
  ];
  while (queue.length && found.length < MAX_PATHS) {
    const { segments, value, every } = queue.shift()!;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      const base = formatJSONPath(segments);
      // `[*]` gathers every item; the first item stands in for the rest below it.
      if (!every) found.push({ path: `${base}[*]`, sample: value });
      queue.push({ segments: [...segments, 0], value: value[0] });
    } else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        const next = [...segments, key];
        found.push({ path: formatJSONPath(next), sample: child });
        if (child && typeof child === 'object') queue.push({ segments: next, value: child });
      }
  }
  return found;
}
/** A short, single-line look at a value, for a completion's detail. */
function preview(value: unknown): string {
  const text =
    typeof value === 'string'
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `list of ${value.length}`
        : value && typeof value === 'object'
          ? `object of ${Object.keys(value).length}`
          : String(value);
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}
const contentType = (response: HttpResponse | undefined) =>
  Object.entries(response?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
/** The body as data, in whatever format it is, and that format's name; undefined when it is not. */
function parsedBody(
  response: HttpResponse | undefined,
): { value: unknown; format: string } | undefined {
  if (!response?.body) return undefined;
  try {
    const parsed = parseBody(response.body, contentType(response));
    return { value: parsed.value, format: BODY_FORMAT_NAMES[parsed.format] };
  } catch {
    return undefined;
  }
}

/** What the response offers for one kind of source. */
function responseOptions(
  kind: string,
  response: HttpResponse | undefined,
): { insert: string; detail: string; badge?: string }[] {
  if (kind === '$' || kind === 'body.') {
    const body = parsedBody(response);
    return jsonPaths(body?.value).map(({ path, sample }) => ({
      // `body.` paths are JSON paths without the `$`.
      insert: kind === '$' ? path : `body${path.slice(1)}`,
      detail: preview(sample),
      badge: body!.format,
    }));
  }
  if (kind === 'header' || kind === 'header.')
    return Object.entries(response?.headers ?? {}).map(([name, value]) => ({
      insert: `header${kind === 'header.' ? '.' : ' '}${name.toLowerCase()}`,
      detail: preview(value),
    }));
  if (kind === 'cookie' || kind === 'cookie.')
    return (response ? responseCookies(response) : []).map(({ name, value }) => ({
      insert: kind === 'cookie.' ? dottedCookie(name) : `cookie ${name}`,
      detail: preview(value),
    }));
  if (kind === 'status.')
    return [
      { insert: 'status.code', detail: response ? String(response.status) : 'Such as 200' },
      { insert: 'status.text', detail: response ? preview(response.statusText) : 'Such as OK' },
    ];
  if (kind === 'form') {
    const type = Object.entries(response?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1];
    if (!response?.body || !/x-www-form-urlencoded/i.test(type ?? '')) return [];
    return [...new URLSearchParams(response.body)].map(([name, value]) => ({
      insert: `form ${name}`,
      detail: preview(value),
    }));
  }
  if (kind === 'timing')
    return TIMING_NAMES.map((name) => ({
      insert: `timing ${name}`,
      detail:
        name === 'ttfb'
          ? 'Time to first byte (waiting)'
          : name === 'total'
            ? 'The whole exchange'
            : `The ${name} phase, in ms`,
    }));
  if (kind === 'certificate')
    return [...CERTIFICATE_FIELDS, ...CERTIFICATE_CONNECTION_FIELDS].map((name) => ({
      insert: `certificate ${name}`,
      detail: (CERTIFICATE_CONNECTION_FIELDS as readonly string[]).includes(name)
        ? 'Of the TLS connection'
        : 'Of the server’s certificate',
    }));
  return [];
}
/** `cookie.name`, or `cookie["a.b"]` for a name that is not a plain word. */
const dottedCookie = (name: string) =>
  /^[\w-]+$/.test(name) ? `cookie.${name}` : `cookie[${JSON.stringify(name)}]`;
/** Whether `insert` continues `typed`; after a dot, a bracketed name (`cookie["a.b"]`) does too. */
const continues = (insert: string, typed: string) =>
  matches(insert, typed) || (typed.endsWith('.') && insert.startsWith(`${typed.slice(0, -1)}[`));
const matches = (insert: string, typed: string) =>
  insert.toLowerCase().startsWith(typed.toLowerCase()) && insert !== typed;

/**
 * Completions for `text` up to `cursor` (its end by default), using `response` (the request's
 * last response, when it has one) for paths, headers, cookies, and form fields.
 */
export function captureCompletions(
  text: string,
  response?: HttpResponse,
  cursor = text.length,
): CaptureCompletion[] {
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  // Half-typed text may not split yet (a trailing `|`), so a failed split reads as one step.
  let steps: string[];
  try {
    steps = before.trim() ? captureSteps(before) : [''];
  } catch {
    steps = [before];
  }
  // After a ` | `, the step being typed is a transform.
  const pipe = /\|\s*$/.test(before) || steps.length > 1;
  if (pipe) {
    const typed = /\|\s*$/.test(before) ? '' : steps.at(-1)!.trimStart();
    const head = before.slice(0, before.length - typed.length).replace(/\|\s*$/, '| ');
    return CAPTURE_TRANSFORMS.filter((item) => !typed || matches(item.insert, typed))
      .slice(0, LIMIT)
      .map((item) => ({
        value: head + item.insert + after,
        label: item.insert,
        detail: item.detail,
        group: 'Transforms',
      }));
  }
  const typed = before.trimStart();
  const kind = typed.startsWith('$')
    ? '$'
    : /^(body|header|cookie|status)[.[]/.test(typed)
      ? `${/^\w+/.exec(typed)![0]}.`
      : (/^(\w+)\s/.exec(typed)?.[1] ?? '');
  const options = kind
    ? responseOptions(kind, response)
        .filter((item) => continues(item.insert, typed))
        .map(grouped(GROUPS[kind] ?? 'Suggestions'))
    : [
        ...CAPTURE_SOURCES.filter((item) => matches(item.insert, typed)).map(grouped('Sources')),
        // `body` typed whole: its paths come next, such as `body[*]` for a list.
        ...(typed === 'body'
          ? responseOptions('body.', response)
              .filter((item) => matches(item.insert, typed))
              .map(grouped('Body'))
          : []),
        // With nothing typed yet, what the response holds comes first: its fields and headers.
        ...(typed.length < 2
          ? [
              ...responseOptions('body.', response).slice(0, 8).map(grouped('From the response')),
              ...responseOptions('header.', response).slice(0, 4).map(grouped('From the response')),
            ]
          : []),
      ];
  return options.slice(0, LIMIT).map((item) => ({
    value: item.insert + after,
    label: item.label ?? item.insert,
    detail: item.detail,
    group: item.group,
    ...(item.badge ? { badge: item.badge } : {}),
  }));
}

/** Words in a variable name that usually mean a secret, so its preview is hidden. */
export const SECRET_CAPTURE_NAME = /token|secret|password|passwd|session|cookie|auth|key|jwt|csrf/i;

/**
 * Captures worth adding from a response: tokens, ids, and other values later requests often
 * need (from the JSON body, `Location` and request-id headers, and cookies), not already captured.
 */
export function suggestedCaptures(
  response: HttpResponse | undefined,
  existing: readonly string[],
): { source: string; detail: string }[] {
  if (!response) return [];
  const taken = new Set(existing.map((source) => source.trim()));
  const found: { source: string; detail: string }[] = [];
  const body = parsedBody(response);
  for (const { path, sample } of jsonPaths(body?.value)) {
    // Values inside lists would only ever pick the first item, so they are left out.
    if (typeof sample === 'object' || path.includes('[')) continue;
    const key = /(?:\.|\[")([^.["]+)"?\]?$/.exec(path)?.[1] ?? '';
    if (/token|^id$|_id$|Id$|csrf|session|cursor|next/i.test(key))
      found.push({
        source: `body${path.slice(1)}`,
        detail: `${body!.format} · ${preview(sample)}`,
      });
  }
  for (const [name, value] of Object.entries(response.headers ?? {}))
    if (/^(location|x-request-id|x-correlation-id|etag|x-csrf-token)$/i.test(name))
      found.push({ source: `header.${name.toLowerCase()}`, detail: preview(value) });
  for (const cookie of responseCookies(response))
    found.push({ source: dottedCookie(cookie.name), detail: 'Cookie' });
  return found.filter((item) => !taken.has(item.source)).slice(0, 6);
}

/** What a capture reads, for its badge in the Source field. */
export type CaptureKind =
  | 'body-path'
  | 'json-path'
  | 'body'
  | 'header'
  | 'cookie'
  | 'status'
  | 'time'
  | 'size'
  | 'regex'
  | 'between'
  | 'html'
  | 'form'
  | 'timing'
  | 'certificate'
  | 'error'
  | 'unknown';
const SOURCE_WORDS = [
  'body',
  'header',
  'cookie',
  'status',
  'time',
  'size',
  'regex',
  'between',
  'html',
  'form',
  'timing',
  'certificate',
  'error',
  'json',
] as const;
const TRANSFORM_NAMES: readonly string[] = CAPTURE_TRANSFORM_NAMES;
/** The kind of a capture's first step. */
export function captureKind(first: string): CaptureKind {
  const text = first.trim();
  if (text.startsWith('$')) return 'json-path';
  if (/^body\s*[.[]/.test(text)) return 'body-path';
  if (/^json\s+\$/.test(text)) return 'json-path';
  const word = /^[a-z-]+/i.exec(text)?.[0].toLowerCase() ?? '';
  if (word === 'status') return 'status';
  return (SOURCE_WORDS as readonly string[]).includes(word) && word !== 'json'
    ? (word as CaptureKind)
    : 'unknown';
}
/** How many single-character edits turn `a` into `b`, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
/** The closest of `options` to `word`, when it is close enough to be a slip. */
function nearest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const option of options) {
    const d = distance(word.toLowerCase(), option);
    if (d < score) [best, score] = [option, d];
  }
  // Two slips (such as swapped letters) are allowed in words of four letters or more.
  return score <= (word.length >= 4 ? 2 : 1) ? best : undefined;
}
export interface CaptureCheck {
  kind: CaptureKind;
  /** What is wrong, in words, found without a response. */
  problem?: string;
  /** The source with the likely fix applied, such as a misspelt transform corrected. */
  fix?: string;
  /** The fix in a few words, for its button, such as `Use jwt`. */
  fixLabel?: string;
}
/**
 * Checks a capture's source as it is written, before any response: that the source and each
 * transform exist, and that paths, regular expressions, timings, and certificate fields are valid.
 */
export function checkCaptureSource(source: string): CaptureCheck {
  const text = source.trim();
  if (!text) return { kind: 'unknown' };
  if (/\|$/.test(text))
    return {
      kind: captureKind(text.replace(/\s*\|$/, '')),
      problem: 'Each | needs a transform after it, such as | first; or remove the |.',
      fix: text.replace(/\s*\|$/, ''),
      fixLabel: 'Remove the |',
    };
  let steps: string[];
  try {
    steps = captureSteps(text);
  } catch (error) {
    return { kind: 'unknown', problem: (error as Error).message };
  }
  const [first, ...transforms] = steps;
  const kind = captureKind(first);
  const replaceStep = (index: number, next: string) =>
    [...steps.slice(0, index), next, ...steps.slice(index + 1)].join(' | ');
  if (kind === 'unknown') {
    const word = /^[^\s.[]+/.exec(first)?.[0] ?? first;
    const guess = nearest(word, SOURCE_WORDS);
    return {
      kind,
      problem: `“${word}” is not a source. Use body.path, header.name, cookie.name, status.code, or another from the list.`,
      ...(guess
        ? { fix: replaceStep(0, guess + first.slice(word.length)), fixLabel: `Use ${guess}` }
        : {}),
    };
  }
  if (kind === 'body-path' || kind === 'json-path') {
    const path =
      kind === 'body-path' ? `$${first.replace(/^body\s*/, '')}` : first.replace(/^json\s+/, '');
    try {
      queryJSON({}, path);
    } catch (error) {
      if ((error as Error).message !== 'No value matches this path.')
        return { kind, problem: `The path is not valid: ${(error as Error).message}` };
    }
  }
  const argument = first.replace(/^\S+\s*/, '');
  if (kind === 'timing') {
    const name = argument.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!name) return { kind, problem: 'Name the timing, such as timing ttfb.' };
    if (!TIMING_NAMES.includes(name)) {
      const guess = nearest(name, TIMING_NAMES);
      return {
        kind,
        problem: `“${name}” is not a timing. Use total, ttfb, dns, tcp, tls, download, or another phase.`,
        ...(guess
          ? { fix: replaceStep(0, first.replace(name, guess)), fixLabel: `Use ${guess}` }
          : {}),
      };
    }
  }
  if (kind === 'certificate') {
    const fields = [...CERTIFICATE_FIELDS, ...CERTIFICATE_CONNECTION_FIELDS] as readonly string[];
    const name = argument.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!name) return { kind, problem: 'Name the field, such as certificate days-left.' };
    if (!fields.includes(name)) {
      const guess = nearest(name, fields);
      return {
        kind,
        problem: `“${name}” is not a certificate field.`,
        ...(guess
          ? { fix: replaceStep(0, first.replace(name, guess)), fixLabel: `Use ${guess}` }
          : {}),
      };
    }
  }
  if ((kind === 'header' || kind === 'cookie') && !/^\w+(\s+\S|\.\S|\[.+\])/.test(first))
    return {
      kind,
      problem: `Name the ${kind}, such as ${kind}.${kind === 'header' ? 'x-request-id' : 'session'}.`,
    };
  if (kind === 'regex') {
    try {
      regexArgument(argument);
    } catch (error) {
      return { kind, problem: `The regular expression is not valid: ${(error as Error).message}` };
    }
  }
  if (kind === 'between' && !/^"(?:[^"\\]|\\.)*"\s+"(?:[^"\\]|\\.)*"$/.test(argument))
    return {
      kind,
      problem: 'between needs two quoted markers, such as between "<title>" "</title>".',
    };
  for (const [index, step] of transforms.entries()) {
    const name = /^[\w-]+/.exec(step)?.[0] ?? step;
    if (!TRANSFORM_NAMES.includes(name)) {
      const guess = nearest(name, TRANSFORM_NAMES);
      return {
        kind,
        problem: `“${name}” is not a transform.`,
        ...(guess
          ? {
              fix: replaceStep(index + 1, guess + step.slice(name.length)),
              fixLabel: `Use ${guess}`,
            }
          : {}),
      };
    }
    if (name === 'regex')
      try {
        regexArgument(step.replace(/^regex\s*/, ''));
      } catch (error) {
        return {
          kind,
          problem: `The regular expression is not valid: ${(error as Error).message}`,
        };
      }
  }
  return { kind };
}
