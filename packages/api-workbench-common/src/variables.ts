import { parseBody } from './structured-body';
import { findValue, regexArgument, sameJSON } from './assertions';
import type { HttpResponse, RequestResponse } from './types';
import { certificateCapture, responseCookies, timingCapture } from './response-values';

export {
  CERTIFICATE_CONNECTION_FIELDS,
  CERTIFICATE_FIELDS,
  TIMING_PHASES,
  certificateCapture,
  responseCookies,
  timingCapture,
} from './response-values';

/** Built-in `{{$name}}` values, generated fresh each time a request is resolved. */
export const dynamicVariables = [
  { name: '$guid', description: 'Random UUID v4' },
  { name: '$uuid', description: 'Random UUID v4 (alias of $guid)' },
  { name: '$timestamp', description: 'Current Unix time in seconds' },
  { name: '$timestampMs', description: 'Current Unix time in milliseconds' },
  { name: '$isoTimestamp', description: 'Current time as ISO 8601' },
  { name: '$isoDate', description: 'Current date as YYYY-MM-DD' },
  { name: '$randomInt', description: 'Random integer from 0 to 1000' },
  { name: '$randomFloat', description: 'Random decimal from 0 to 1000' },
  { name: '$randomBoolean', description: 'true or false' },
  { name: '$randomHex', description: 'Random 16-character hex string' },
  { name: '$randomAlphaNumeric', description: 'Random 12-character alphanumeric string' },
  { name: '$randomEmail', description: 'Random example.com email address' },
  { name: '$randomUserName', description: 'Random user name' },
  { name: '$randomFirstName', description: 'Random first name' },
  { name: '$randomLastName', description: 'Random last name' },
  { name: '$randomIP', description: 'Random IPv4 address' },
] as const;

const firstNames = [
  'Alex',
  'Jordan',
  'Taylor',
  'Morgan',
  'Riley',
  'Casey',
  'Avery',
  'Quinn',
  'Sam',
  'Jamie',
];
const lastNames = [
  'Lee',
  'Patel',
  'Garcia',
  'Nguyen',
  'Kim',
  'Silva',
  'Okafor',
  'Novak',
  'Rossi',
  'Haddad',
];
const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];
const chars = (alphabet: string, length: number, random: () => number): string =>
  Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');

/**
 * Returns the value of a dynamic variable, or undefined if the name is not built in.
 * `now`, `random`, and `uuid` are injectable so results can be tested deterministically.
 */
export function dynamicValue(
  name: string,
  now: Date = new Date(),
  random: () => number = Math.random,
  uuid: () => string = () => crypto.randomUUID(),
): string | undefined {
  switch (name) {
    case '$guid':
    case '$uuid':
      return uuid();
    case '$timestamp':
      return String(Math.floor(now.getTime() / 1000));
    case '$timestampMs':
      return String(now.getTime());
    case '$isoTimestamp':
      return now.toISOString();
    case '$isoDate':
      return now.toISOString().slice(0, 10);
    case '$randomInt':
      return String(Math.floor(random() * 1001));
    case '$randomFloat':
      return (random() * 1000).toFixed(2);
    case '$randomBoolean':
      return String(random() < 0.5);
    case '$randomHex':
      return chars('0123456789abcdef', 16, random);
    case '$randomAlphaNumeric':
      return chars('abcdefghijklmnopqrstuvwxyz0123456789', 12, random);
    case '$randomEmail':
      return `${chars('abcdefghijklmnopqrstuvwxyz', 8, random)}@example.com`;
    case '$randomUserName':
      return `${pick(firstNames, random).toLowerCase()}.${pick(lastNames, random).toLowerCase()}${Math.floor(random() * 100)}`;
    case '$randomFirstName':
      return pick(firstNames, random);
    case '$randomLastName':
      return pick(lastNames, random);
    case '$randomIP':
      return Array.from(
        { length: 4 },
        (_, index) => Math.floor(random() * 254) + (index === 0 ? 1 : 0),
      ).join('.');
    default:
      return undefined;
  }
}

export interface CaptureResult {
  variable: string;
  source: string;
  value?: string;
  error?: string;
}

/** Text for a captured value: strings as they are, anything else as compact JSON. */
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

/**
 * Splits a capture into its source and transforms at ` | `, keeping pipes inside quoted text and
 * `/regular expressions/` (where `|` means "or") together.
 */
export function captureSteps(source: string): string[] {
  const steps: string[] = [];
  let current = '';
  let quote = false;
  let regex = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if ((quote || regex) && char === '\\') {
      current += char + (source[index + 1] ?? '');
      index++;
      continue;
    }
    if (!regex && char === '"') quote = !quote;
    // A regular expression opens with / after a space or at the start of a step.
    else if (!quote && char === '/' && (regex || !current.trim() || /\s$/.test(current)))
      regex = !regex;
    if (!quote && !regex && source.startsWith(' | ', index)) {
      steps.push(current.trim());
      current = '';
      index += 2;
      continue;
    }
    current += char;
  }
  steps.push(current.trim());
  if (steps.some((step) => !step)) throw new Error('Each | needs a source or transform beside it.');
  return steps;
}

/** A quoted (JSON) string argument, or the text itself. */
function quotedText(source: string): string {
  const text = source.trim();
  if (!text.startsWith('"')) return text;
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'string') throw new Error('Expected quoted text.');
  return value;
}
/** Two quoted arguments: `"start" "end"`. */
function quotedPair(source: string): [string, string] {
  const match = source.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (!match) throw new Error('Use between "start" "end", with both markers quoted.');
  return [JSON.parse(match[1]) as string, JSON.parse(match[2]) as string];
}
/** The match of `regex /pattern/flags [group]` in text: the group, else the first group, else all. */
function regexCapture(text: string, argument: string): string {
  const match = argument.match(/^(\/.+\/[a-z]*)(?:\s+([\w$]+))?$/s);
  if (!match) throw new Error('Use regex /pattern/flags, optionally followed by a group.');
  const found = regexArgument(match[1]).exec(text);
  if (!found) throw new Error(`No match for ${match[1]}.`);
  const group = match[2];
  if (group === undefined) return found[1] ?? found[0];
  const value = /^\d+$/.test(group) ? found[Number(group)] : found.groups?.[group];
  if (value === undefined)
    throw new Error(`The pattern has no group ${group}, or it did not match.`);
  return value;
}
function betweenCapture(text: string, argument: string): string {
  const [start, end] = quotedPair(argument.trim());
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`"${start}" was not found.`);
  const begin = from + start.length;
  const to = text.indexOf(end, begin);
  if (to < 0) throw new Error(`"${end}" was not found after "${start}".`);
  return text.slice(begin, to);
}
function jsonBody(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    // A `$.` path reads XML, YAML, and the other data formats too, as `body.` does.
    try {
      return parseBody(response.body, contentTypeOf(response)).value;
    } catch {
      throw new Error('Response body is not valid JSON.');
    }
  }
}
const contentTypeOf = (response: Pick<HttpResponse, 'headers'>) =>
  Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
/** A name after `header.` or `cookie.`: as written, or in brackets and quotes, as `["a.b"]`. */
function dottedName(text: string): string {
  const quoted = /^\[\s*("(?:[^"\\]|\\.)*")\s*\]$/.exec(text);
  return quoted ? (JSON.parse(quoted[1]) as string) : text.replace(/^\./, '');
}
/** A JSON path's value; wildcard and filter paths give an array of every match. */
function jsonPath(root: unknown, path: string): unknown {
  try {
    return queryJSON(root, path);
  } catch (error) {
    if ((error as Error).message === 'No value matches this path.')
      throw new Error(`JSON path ${path} is missing.`, { cause: error });
    throw error;
  }
}

/**
 * An element of an HTML body, found by a CSS selector: its text (whitespace collapsed), or an
 * attribute's value. Parsing needs a browser's DOMParser, which the app's renderer has.
 */
function htmlCapture(body: string, selector: string, attribute?: string): string {
  if (typeof DOMParser === 'undefined')
    throw new Error('HTML captures run in the app, where a browser parses the body.');
  const document = new DOMParser().parseFromString(body, 'text/html');
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    throw new Error(`"${selector}" is not a valid CSS selector.`);
  }
  if (!element) throw new Error(`No element matches ${selector}.`);
  if (!attribute) return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const value = element.getAttribute(attribute);
  if (value === null) throw new Error(`${selector} has no ${attribute} attribute.`);
  return value;
}

/** Whether a capture reads something a failed request has: its error, timing, or certificate. */
export function readsFailures(source: string): boolean {
  return /^(?:error|timing|certificate)\b/i.test(captureSteps(source.trim())[0] ?? '');
}

/** Where a capture starts: a part of the response, or of the failure when the request failed. */
function captureSource(source: string, response: RequestResponse): unknown {
  let match: RegExpMatchArray | null;
  if (source === 'error') {
    if (response.error === undefined)
      throw new Error('The request did not fail, so there is no error to read.');
    return response.error;
  }
  // A failed request can still have timing and a certificate, as when it timed out after them.
  if ((match = source.match(/^certificate\s+([a-z0-9-]+)(?:\s+(\d+))?$/i)))
    return certificateCapture(response, match[1].toLowerCase(), match[2]);
  if ((match = source.match(/^timing\s+([a-z-]+)(?:\s+(\d+))?$/i)))
    return timingCapture(response, match[1].toLowerCase(), match[2]);
  if (response.error !== undefined)
    throw new Error(
      'The request failed, so there is no response to read: use error, timing, or certificate.',
    );
  if (source === 'status' || source === 'status.code') return String(response.status);
  if (source === 'status.text') return response.statusText;
  if (source === 'body') return response.body;
  // `body.path` reads the body as data (JSON, XML, YAML, form, NDJSON, or CSV) at a JSON path.
  if ((match = source.match(/^body(\s*[.[].*)$/s))) {
    const { value } = parseBody(response.body, contentTypeOf(response));
    const path = `$${match[1].trim()}`;
    try {
      return queryJSON(value, path);
    } catch (error) {
      if ((error as Error).message === 'No value matches this path.')
        throw new Error(`The body has nothing at ${source}.`, { cause: error });
      throw error;
    }
  }
  if ((match = source.match(/^header(\.[^\s].*|\[.+\])$/s)))
    source = `header ${dottedName(match[1])}`;
  if ((match = source.match(/^cookie(\.[^\s].*|\[.+\])$/s)))
    source = `cookie ${JSON.stringify(dottedName(match[1]))}`;
  if (source === 'time') return String(response.time);
  if (source === 'size') return String(response.size);
  if ((match = source.match(/^header\s+(\S+)$/i))) {
    const name = match[1].toLowerCase();
    const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name);
    if (!entry) throw new Error(`Header "${match[1]}" was not returned.`);
    return entry[1];
  }
  if ((match = source.match(/^cookie\s+(.+)$/i))) {
    const name = quotedText(match[1]);
    const value = responseCookies(response)
      .filter((cookie) => cookie.name === name)
      .at(-1)?.value;
    if (value === undefined) throw new Error(`Cookie "${name}" was not set by the response.`);
    return value;
  }
  if ((match = source.match(/^html\s+(.+?)(?:\s+@([\w:.-]+))?$/is)))
    return htmlCapture(response.body, match[1], match[2]);
  if ((match = source.match(/^regex\s+(.+)$/is))) return regexCapture(response.body, match[1]);
  if ((match = source.match(/^between\s+(.+)$/is))) return betweenCapture(response.body, match[1]);
  if ((match = source.match(/^form\s+(.+)$/i))) {
    const name = quotedText(match[1]);
    const value = new URLSearchParams(response.body.trim()).get(name);
    if (value === null) throw new Error(`Form field "${name}" is missing.`);
    return value;
  }
  const path = source.replace(/^json\s+/i, '');
  if (!path.startsWith('$'))
    throw new Error(
      'Use body.path, $.path, header.name, cookie.name, status.code, status.text, body, regex /pattern/, between "start" "end", html <selector> [@attribute], form <field>, timing <phase>, certificate <field>, error, size, or time.',
    );
  return jsonPath(jsonBody(response), path);
}

/** Every transform a capture accepts after `|`, in the order the docs list them. */
export const CAPTURE_TRANSFORM_NAMES = [
  'first',
  'last',
  'at',
  'length',
  'join',
  'split',
  'slice',
  'unique',
  'sort',
  'reverse',
  'keys',
  'values',
  'trim',
  'lower',
  'upper',
  'replace',
  'prefix',
  'suffix',
  'regex',
  'between',
  'json',
  'jwt',
  'base64-decode',
  'base64-encode',
  'url-decode',
  'url-encode',
  'sum',
  'min',
  'max',
  'avg',
  'round',
  'add',
  'subtract',
  'multiply',
  'divide',
  'date',
  'epoch',
  'epoch-ms',
  'if-empty',
  'default',
] as const;
/** A number from a value: a JSON number, or text that is one. */
function numberOf(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(asText(value).trim());
  if (typeof value === 'boolean' || !asText(value).trim() || !Number.isFinite(number))
    throw new Error(`${name} needs a number, not ${JSON.stringify(asText(value)).slice(0, 60)}.`);
  return number;
}
/** A transform's numeric argument, such as the 2 in `round 2`. */
function numberArgument(argument: string, name: string, integer = false): number {
  const number = Number(argument.trim());
  if (!argument.trim() || !Number.isFinite(number) || (integer && !Number.isInteger(number)))
    throw new Error(`${name} needs ${integer ? 'a whole number' : 'a number'}, such as ${name} 2.`);
  return number;
}
/** Two quoted arguments, `"a" "b"`, for a transform named `name`. */
function quotedArguments(source: string, name: string, example: string): [string, string] {
  const match = source.trim().match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (!match) throw new Error(`Use ${name} ${example}, with both quoted.`);
  return [JSON.parse(match[1]) as string, JSON.parse(match[2]) as string];
}
/** A moment from a value: Unix seconds or milliseconds, or a date the platform can read. */
function timeOf(value: unknown, name: string): number {
  const text = asText(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    // Ten digits are seconds until the year 2286; more are milliseconds.
    return Math.abs(number) < 1e11 ? number * 1000 : number;
  }
  const time = Date.parse(text);
  if (!text || Number.isNaN(time)) throw new Error(`${name} needs a date or a Unix time.`);
  return time;
}
/** Items compared as numbers when every one is a number, otherwise as text. */
function sortedItems(items: unknown[]): unknown[] {
  const numbers = items.every((item) => typeof item === 'number');
  return [...items].sort((a, b) =>
    numbers ? (a as number) - (b as number) : asText(a).localeCompare(asText(b)),
  );
}

/** Applies one transform (after a `|`) to the value captured so far. */
function captureTransform(step: string, value: unknown): unknown {
  const [, name, argument = ''] = step.match(/^([\w-]+)(?:\s+(.*))?$/s) ?? [];
  const list = () => {
    if (!Array.isArray(value)) throw new Error(`${name} needs a list, such as from $.items[*].id.`);
    return value;
  };
  switch (name) {
    case 'first':
    case 'last': {
      const items = list();
      if (!items.length) throw new Error('The list is empty.');
      return name === 'first' ? items[0] : items.at(-1);
    }
    case 'at': {
      const index = numberArgument(argument, 'at', true);
      const items = typeof value === 'string' ? [...value] : list();
      const item = items.at(index);
      if (item === undefined) throw new Error(`There is no item ${index}; it has ${items.length}.`);
      return item;
    }
    case 'split':
      return asText(value).split(argument ? quotedText(argument) : ',');
    case 'slice': {
      const [from, to] = argument.trim().split(/\s+/);
      const start = numberArgument(from ?? '', 'slice', true);
      const end = to === undefined ? undefined : numberArgument(to, 'slice', true);
      return typeof value === 'string'
        ? [...value].slice(start, end).join('')
        : list().slice(start, end);
    }
    case 'unique': {
      const seen = new Set<string>();
      return list().filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    case 'sort':
      return argument.trim() === 'desc' ? sortedItems(list()).reverse() : sortedItems(list());
    case 'reverse':
      return typeof value === 'string' ? [...value].reverse().join('') : [...list()].reverse();
    case 'keys':
    case 'values':
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${name} needs an object, such as from $.data.`);
      return name === 'keys' ? Object.keys(value) : Object.values(value);
    case 'replace': {
      const [from, to] = quotedArguments(argument, 'replace', '"from" "to"');
      if (!from) throw new Error('replace needs text to find.');
      return asText(value).replaceAll(from, to);
    }
    case 'prefix':
      return quotedText(argument) + asText(value);
    case 'suffix':
      return asText(value) + quotedText(argument);
    case 'base64-encode': {
      const bytes = new TextEncoder().encode(asText(value));
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    }
    case 'url-encode':
      return encodeURIComponent(asText(value));
    case 'sum':
    case 'min':
    case 'max':
    case 'avg': {
      const numbers = list().map((item) => numberOf(item, name));
      if (!numbers.length && name !== 'sum') throw new Error('The list is empty.');
      const total = numbers.reduce((sum, number) => sum + number, 0);
      return name === 'sum'
        ? total
        : name === 'avg'
          ? total / numbers.length
          : name === 'min'
            ? Math.min(...numbers)
            : Math.max(...numbers);
    }
    case 'round': {
      const digits = argument.trim() ? numberArgument(argument, 'round', true) : 0;
      if (digits < 0 || digits > 10) throw new Error('round takes 0 to 10 decimal places.');
      const factor = 10 ** digits;
      return Math.round(numberOf(value, name) * factor) / factor;
    }
    case 'add':
      return numberOf(value, name) + numberArgument(argument, name);
    case 'subtract':
      return numberOf(value, name) - numberArgument(argument, name);
    case 'multiply':
      return numberOf(value, name) * numberArgument(argument, name);
    case 'divide': {
      const divisor = numberArgument(argument, name);
      if (divisor === 0) throw new Error('divide cannot divide by zero.');
      return numberOf(value, name) / divisor;
    }
    case 'date':
      return new Date(timeOf(value, name)).toISOString();
    case 'epoch':
      return Math.floor(timeOf(value, name) / 1000);
    case 'epoch-ms':
      return timeOf(value, name);
    case 'if-empty': {
      const empty =
        value === null ||
        value === undefined ||
        (typeof value === 'string' && !value.trim()) ||
        (Array.isArray(value) && !value.length) ||
        (typeof value === 'object' && value !== null && !Object.keys(value).length);
      return empty ? quotedText(argument) : value;
    }
    case 'length':
      if (typeof value === 'string' || Array.isArray(value)) return String(value.length);
      if (value && typeof value === 'object') return String(Object.keys(value).length);
      throw new Error('length needs text, a list, or an object.');
    case 'join':
      return list()
        .map(asText)
        .join(argument ? quotedText(argument) : ',');
    case 'trim':
      return asText(value).trim();
    case 'lower':
      return asText(value).toLowerCase();
    case 'upper':
      return asText(value).toUpperCase();
    case 'regex':
      return regexCapture(asText(value), argument.trim());
    case 'between':
      return betweenCapture(asText(value), argument);
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(asText(value));
      } catch {
        throw new Error('The value is not valid JSON.');
      }
      return argument ? jsonPath(parsed, argument.trim()) : parsed;
    }
    case 'jwt': {
      const decoded = decodeJWT(asText(value));
      if (!decoded) throw new Error('The value is not a JWT.');
      return jsonPath(decoded.payload, argument.trim() || '$');
    }
    case 'base64-decode': {
      const text = asText(value).trim().replace(/-/g, '+').replace(/_/g, '/');
      try {
        const binary = atob(text.padEnd(Math.ceil(text.length / 4) * 4, '='));
        return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
      } catch {
        throw new Error('The value is not Base64.');
      }
    }
    case 'url-decode':
      try {
        return decodeURIComponent(asText(value).replace(/\+/g, ' '));
      } catch {
        throw new Error('The value is not URL encoded.');
      }
    default:
      throw new Error(`Unknown transform "${step}". Use ${CAPTURE_TRANSFORM_NAMES.join(', ')}.`);
  }
}

/**
 * Reads one value from a response: a source, then any transforms, each after ` | `.
 *
 * Sources: `$.path` or `json $.path` (JSON body; `[*]`, `.*`, negative indexes, and filters such
 * as `[?(@.role == "admin")]` give every match), `regex /pattern/flags [group]`,
 * `between "start" "end"`, `html <selector> [@attribute]` (an element of an HTML body), `form <field>`, `header <name>`, `cookie <name>` (a cookie the response
 * set; the last, when several share the name), `error` (a failed request's message),
 * `timing <phase> [hop]` (network timing in ms:
 * total, preparation, dns, tcp, tls, waiting or ttfb, download, …), `certificate <field> [n]`
 * (the TLS connection, or certificate n of its chain: valid-to, days-left, sha256, …),
 * `status`, `body`, `size`, `time`.
 * Transforms (CAPTURE_TRANSFORM_NAMES): lists (`first`, `last`, `at n`, `length`, `join ", "`,
 * `split ","`, `slice a [b]`, `unique`, `sort [desc]`, `reverse`), objects (`keys`, `values`),
 * text (`trim`, `lower`, `upper`, `replace "a" "b"`, `prefix "…"`, `suffix "…"`, `regex …`,
 * `between …`), decoding (`json [$.path]`, `jwt [$.claim]`, `base64-decode`, `base64-encode`,
 * `url-decode`, `url-encode`), numbers (`sum`, `min`, `max`, `avg`, `round [digits]`, `add n`,
 * `subtract n`, `multiply n`, `divide n`), time (`date`, `epoch`, `epoch-ms`), `if-empty "value"`
 * for an empty result, and `default "value"`, which replaces a failure in the steps before it.
 * Objects and arrays are stored as compact JSON text.
 */
export function captureValue(source: string, response: RequestResponse): string {
  const [first, ...transforms] = captureSteps(source.trim());
  let value: unknown;
  let failure: Error | undefined;
  try {
    value = captureSource(first, response);
  } catch (error) {
    failure = error as Error;
  }
  for (const step of transforms) {
    const fallback = step.match(/^default(?:\s+(.*))?$/s);
    if (fallback) {
      if (failure) value = quotedText(fallback[1] ?? '');
      failure = undefined;
      continue;
    }
    if (failure) continue;
    try {
      value = captureTransform(step, value);
    } catch (error) {
      failure = error as Error;
    }
  }
  if (failure) throw failure;
  return asText(value);
}

/** One step of a capture as it ran: its value afterwards, or why it failed, or that it was skipped. */
export interface CaptureStepTrace {
  step: string;
  kind: 'source' | 'transform';
  /** The value after this step, as it would be saved. */
  value?: string;
  /** What kind of value it is: text, number, boolean, list, object, or null. */
  type?: CaptureValueType;
  error?: string;
  /** Not run: an earlier step failed and no `default` came before it. */
  skipped?: boolean;
}
export type CaptureValueType = 'text' | 'number' | 'boolean' | 'list' | 'object' | 'null';
/** What kind of value a step produced, for showing it. */
export function captureValueType(value: unknown): CaptureValueType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}
/**
 * Runs a capture step by step, keeping each step's value, so a person can see where a chain of
 * transforms turns into something unexpected. Gives the same result as captureValue.
 */
export function captureTrace(source: string, response: RequestResponse): CaptureStepTrace[] {
  const [first, ...transforms] = captureSteps(source.trim());
  const trace: CaptureStepTrace[] = [];
  let value: unknown;
  let failed = false;
  try {
    value = captureSource(first, response);
    trace.push({
      step: first,
      kind: 'source',
      value: asText(value),
      type: captureValueType(value),
    });
  } catch (error) {
    failed = true;
    trace.push({ step: first, kind: 'source', error: (error as Error).message });
  }
  for (const step of transforms) {
    const fallback = step.match(/^default(?:\s+(.*))?$/s);
    if (fallback) {
      if (failed) value = quotedText(fallback[1] ?? '');
      trace.push({
        step,
        kind: 'transform',
        value: asText(value),
        type: captureValueType(value),
        ...(failed ? {} : { skipped: true }),
      });
      failed = false;
      continue;
    }
    if (failed) {
      trace.push({ step, kind: 'transform', skipped: true });
      continue;
    }
    try {
      value = captureTransform(step, value);
      trace.push({ step, kind: 'transform', value: asText(value), type: captureValueType(value) });
    } catch (error) {
      failed = true;
      trace.push({ step, kind: 'transform', error: (error as Error).message });
    }
  }
  return trace;
}

/** Evaluates enabled capture rows; failures are reported per row and never throw. */
export function captureAll(
  rows: { enabled: boolean; key: string; value: string }[],
  response: RequestResponse,
): CaptureResult[] {
  return rows
    .filter((row) => row.enabled && row.key.trim() && row.value.trim())
    .map((row) => {
      const variable = row.key.trim(),
        source = row.value.trim();
      try {
        return { variable, source, value: captureValue(source, response) };
      } catch (error) {
        return { variable, source, error: error instanceof Error ? error.message : String(error) };
      }
    });
}

/** Where a `[?(…)]` filter's expression ends: the `)]` outside quoted text and patterns. */
function filterEnd(path: string): number {
  let quote = '';
  let regex = false;
  for (let index = 3; index < path.length; index++) {
    const char = path[index];
    if ((quote || regex) && char === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if (regex) {
      if (char === '/') regex = false;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '/') regex = true;
    else if (path.startsWith(')]', index)) return index;
  }
  throw new Error('Close the filter with )], as in [?(@.role == "admin")].');
}
/** A literal in a filter: JSON, or 'single-quoted' text. */
function filterLiteral(source: string): unknown {
  const text = source.trim();
  if (/^'(?:[^'\\]|\\.)*'$/.test(text)) return text.slice(1, -1).replace(/\\(.)/g, '$1');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Quote text in filters: ${text} → "${text}".`);
  }
}
/**
 * A filter's test: `@.field` (present and not false or null), or `@.field <op> value` with
 * ==, !=, <, <=, >, >=, or =~ /pattern/flags. `@` alone is the item itself.
 */
function filterPredicate(expression: string): (item: unknown) => boolean {
  const match = expression
    .trim()
    .match(
      /^@((?:\.[A-Za-z_$][\w$-]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*)\s*(?:(==|!=|<=|>=|<|>|=~)\s*(.+))?$/s,
    );
  if (!match) throw new Error('Use a filter such as [?(@.role == "admin")] or [?(@.price < 10)].');
  const [, path, operator, argument] = match;
  const read = (item: unknown) =>
    path ? findValue(item, '$' + path) : { exists: true, value: item };
  if (!operator)
    return (item) => {
      const found = read(item);
      return found.exists && found.value !== null && found.value !== false;
    };
  if (operator === '=~') {
    const pattern = regexArgument(argument.trim());
    return (item) => {
      const found = read(item);
      return typeof found.value === 'string' && pattern.test(found.value);
    };
  }
  const expected = filterLiteral(argument);
  return (item) => {
    const found = read(item);
    if (!found.exists) return operator === '!=';
    if (operator === '==') return sameJSON(found.value, expected);
    if (operator === '!=') return !sameJSON(found.value, expected);
    const actual = found.value;
    if (
      !(typeof actual === 'number' && typeof expected === 'number') &&
      !(typeof actual === 'string' && typeof expected === 'string')
    )
      return false;
    return operator === '<'
      ? actual < expected
      : operator === '<='
        ? actual <= expected
        : operator === '>'
          ? actual > expected
          : actual >= expected;
  };
}

/**
 * Filters JSON with a path that may include wildcards: `$.items[*].id`, `$.data.*`, or filters:
 * `$.users[?(@.role == "admin")].id`.
 * Paths without wildcards return the single match; wildcard paths return an array.
 */
export function queryJSON(root: unknown, path: string): unknown {
  const text = path.trim();
  if (!text.startsWith('$')) throw new Error('Paths start with $, for example $.items[*].id');
  let rest = text.slice(1);
  let nodes: unknown[] = [root];
  let wildcard = false;
  while (rest) {
    if (rest.startsWith('[?(')) {
      // A filter keeps the items (of a list, or values of an object) that pass it.
      const end = filterEnd(rest);
      const passes = filterPredicate(rest.slice(3, end));
      wildcard = true;
      nodes = nodes.flatMap((node) =>
        (Array.isArray(node)
          ? node
          : node && typeof node === 'object'
            ? Object.values(node)
            : []
        ).filter(passes),
      );
      rest = rest.slice(end + 2);
      continue;
    }
    const match = rest.match(
      /^(?:\.\*|\[\*\]|\.([A-Za-z_$@#][\w$-]*)|\[(-?\d+)\]|\[("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])/,
    );
    if (!match) throw new Error(`Unexpected "${rest.slice(0, 12)}" in path.`);
    if (match[0] === '.*' || match[0] === '[*]') {
      wildcard = true;
      nodes = nodes.flatMap((node) =>
        Array.isArray(node) ? node : node && typeof node === 'object' ? Object.values(node) : [],
      );
    } else {
      const quoted = match[3];
      const key = quoted
        ? quoted.startsWith("'")
          ? quoted.slice(1, -1).replace(/\\(.)/g, '$1')
          : (JSON.parse(quoted) as string)
        : match[1];
      nodes = nodes.flatMap((node) => {
        if (match[2] !== undefined) {
          if (!Array.isArray(node)) return [];
          const index = Number(match[2]);
          const item = node.at(index);
          return index < node.length && index >= -node.length ? [item] : [];
        }
        return node !== null && typeof node === 'object' && Object.hasOwn(node, key)
          ? [(node as Record<string, unknown>)[key]]
          : [];
      });
    }
    rest = rest.slice(match[0].length);
  }
  if (wildcard) return nodes;
  if (!nodes.length) throw new Error('No value matches this path.');
  return nodes[0];
}

export interface DecodedJWT {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  expiresAt?: string;
  issuedAt?: string;
  expired?: boolean;
}

const base64UrlJSON = (part: string): Record<string, unknown> => {
  const base64 = part
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(part.length / 4) * 4, '=');
  const binary = atob(base64);
  const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
  return value as Record<string, unknown>;
};

/** Decodes a JWT's header and claims without verifying its signature. */
export function decodeJWT(token: string, now: Date = new Date()): DecodedJWT | undefined {
  const parts = token
    .trim()
    .replace(/^Bearer\s+/i, '')
    .split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) return undefined;
  try {
    const header = base64UrlJSON(parts[0]),
      payload = base64UrlJSON(parts[1]);
    const time = (claim: unknown) =>
      typeof claim === 'number' && Number.isFinite(claim)
        ? new Date(claim * 1000).toISOString()
        : undefined;
    const expiresAt = time(payload.exp);
    return {
      header,
      payload,
      expiresAt,
      issuedAt: time(payload.iat),
      expired: expiresAt ? new Date(expiresAt).getTime() <= now.getTime() : undefined,
    };
  } catch {
    return undefined;
  }
}
