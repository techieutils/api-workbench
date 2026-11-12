import { untrustedRegExp } from './regex-safety';
import type { HttpResponse } from './types';
import { validateJsonSchema } from './json-schema';
import { certificateCapture, responseCookies, timingCapture } from './response-values';
export interface AssertionResult {
  label: string;
  pass: boolean;
  message: string;
  line: number;
  name?: string;
}
export const examples = [
  {
    group: 'Status',
    label: 'Exact status',
    syntax: 'status 200',
    description: 'Response status is exactly 200.',
  },
  {
    group: 'Status',
    label: 'Successful status range',
    syntax: 'status between 200 299',
    description: 'Response status is within an inclusive range.',
  },
  {
    group: 'Status',
    label: 'Allowed status codes',
    syntax: 'status in 200, 201, 204',
    description: 'Response status matches one of these codes.',
  },
  {
    group: 'Status',
    label: 'No server error',
    syntax: 'status < 500',
    description: 'Status supports ==, !=, <, <=, >, and >=.',
  },
  {
    group: 'Performance',
    label: 'Response time',
    syntax: 'response-time < 3000',
    description: 'Elapsed response time in milliseconds.',
  },
  {
    group: 'Performance',
    label: 'Response size',
    syntax: 'response-size <= 1048576',
    description: 'Response body size in bytes.',
  },
  {
    group: 'Headers',
    label: 'Header exists',
    syntax: 'header-exists content-type',
    description: 'Header lookup is case-insensitive.',
  },
  {
    group: 'Headers',
    label: 'Header is absent',
    syntax: 'header-not-exists x-powered-by',
    description: 'Assert that a header is not returned.',
  },
  {
    group: 'Headers',
    label: 'Header contains',
    syntax: 'header content-type contains application/json',
    description: 'Check a substring in a response header value.',
  },
  {
    group: 'Headers',
    label: 'Header equals',
    syntax: 'header cache-control equals "no-store"',
    description: 'Compare an entire header value.',
  },
  {
    group: 'Headers',
    label: 'Response content type',
    syntax: 'content-type application/json',
    description: 'Compare the media type, ignoring charset and case.',
  },
  {
    group: 'Body',
    label: 'Body contains text',
    syntax: 'body-contains success',
    description: 'Check for text anywhere in the response body.',
  },
  {
    group: 'Body',
    label: 'Body excludes text',
    syntax: 'body-not-contains error',
    description: 'Check that the response does not contain text.',
  },
  {
    group: 'Body',
    label: 'Exact body',
    syntax: 'body-equals "OK"',
    description: 'Quoted strings support escaped newlines and tabs.',
  },
  {
    group: 'Body',
    label: 'Body starts with',
    syntax: 'body starts-with "{"',
    description: 'Also ends-with, not-equals, and case-insensitive equals-ignore-case.',
  },
  {
    group: 'Body',
    label: 'Body matches pattern',
    syntax: 'body matches /"id":\\s*\\d+/',
    description: 'A regular expression as /pattern/flags; not-matches checks the opposite.',
  },
  {
    group: 'Body',
    label: 'Body contains, any case',
    syntax: 'body contains-ignore-case "success"',
    description: 'Find text regardless of upper or lower case.',
  },
  {
    group: 'Body',
    label: 'Body length',
    syntax: 'body-length between 1 10000',
    description: 'Length in characters; supports ==, !=, <, <=, >, >=, and between.',
  },
  {
    group: 'Body',
    label: 'Non-empty body',
    syntax: 'body-not-empty',
    description: 'Response contains non-whitespace text.',
  },
  {
    group: 'Body',
    label: 'Empty body',
    syntax: 'body-empty',
    description: 'Response is empty or contains only whitespace.',
  },
  {
    group: 'JSON',
    label: 'Valid JSON',
    syntax: 'json-valid',
    description: 'Parse the response body as JSON.',
  },
  {
    group: 'JSON',
    label: 'JSON field exists',
    syntax: 'json-exists $.id',
    description: 'Find an own property, including values of null, false, or zero.',
  },
  {
    group: 'JSON',
    label: 'JSON field is absent',
    syntax: 'json-not-exists $.error',
    description: 'Check that a property is missing.',
  },
  {
    group: 'JSON',
    label: 'JSON value equals',
    syntax: 'json $.active equals true',
    description:
      'Expected value is a JSON literal: string, number, boolean, null, object, or array.',
  },
  {
    group: 'JSON',
    label: 'JSON value differs',
    syntax: 'json $.status not-equals "error"',
    description: 'Compare values with strict JSON types.',
  },
  {
    group: 'JSON',
    label: 'JSON number comparison',
    syntax: 'json $.count >= 1',
    description: 'Compare a numeric JSON value.',
  },
  {
    group: 'JSON',
    label: 'JSON text contains',
    syntax: 'json $.name contains "Example"',
    description: 'Check a substring in a JSON string.',
  },
  {
    group: 'JSON',
    label: 'JSON value type',
    syntax: 'json-type $.items array',
    description: 'Types: object, array, string, number, integer, boolean, or null.',
  },
  {
    group: 'JSON',
    label: 'JSON length',
    syntax: 'json-length $.items > 0',
    description: 'Array/string length or the number of keys in an object.',
  },
  {
    group: 'JSON',
    label: 'Array item',
    syntax: 'json-exists $[0].id',
    description: 'Paths support dot notation, array indices, and double-quoted bracket keys.',
  },
  {
    group: 'JSON',
    label: 'JSON value is one of',
    syntax: 'json $.status in ["active", "pending"]',
    description: 'The value equals one of a JSON array of values; not-in checks the opposite.',
  },
  {
    group: 'JSON',
    label: 'JSON number range',
    syntax: 'json $.price between 1 100',
    description: 'An inclusive range for a numeric JSON value.',
  },
  {
    group: 'JSON',
    label: 'JSON text pattern',
    syntax: 'json $.email matches /^[^@]+@example\\.com$/i',
    description:
      'Strings also support starts-with, ends-with, not-contains, and ignore-case checks.',
  },
  {
    group: 'JSON',
    label: 'JSON array contains',
    syntax: 'json $.tags contains "admin"',
    description:
      'For an array, an element equals the JSON value; not-contains checks the opposite.',
  },
  {
    group: 'JSON',
    label: 'Body matches a JSON Schema',
    syntax: 'json-schema {"type": "object", "required": ["id"]}',
    description:
      'Validate the body, or a path such as json-schema $.data {…}, against a JSON Schema.',
  },
  {
    group: 'Headers',
    label: 'Header pattern',
    syntax: 'header etag matches /^"[\\w-]+"$/',
    description: 'Headers support every text comparison, such as starts-with or not-contains.',
  },
  {
    group: 'Status',
    label: 'Excluded status codes',
    syntax: 'status not-in 401, 403',
    description: 'Response status is none of these codes.',
  },
  {
    group: 'Headers',
    label: 'Header format',
    syntax: 'header x-request-id is-uuid',
    description:
      'Also is-email, is-url, is-date, is-number, is-integer, is-empty, and is-not-empty.',
  },
  {
    group: 'JSON',
    label: 'JSON value format',
    syntax: 'json $.email is-email',
    description:
      'A string is a UUID, email, URL, date, or number; is-empty also checks arrays, objects, and null.',
  },
  {
    group: 'JSON',
    label: 'Array contains all',
    syntax: 'json $.roles contains-all ["read", "write"]',
    description: 'Every listed value is in the array; contains-any needs at least one.',
  },
  {
    group: 'JSON',
    label: 'Array items are unique',
    syntax: 'json $.ids is-unique',
    description: 'No item repeats; is-sorted and is-sorted-desc check the order.',
  },
  {
    group: 'Cookies',
    label: 'Cookie is set',
    syntax: 'cookie-exists session',
    description: 'The response set this cookie; cookie-not-exists checks the opposite.',
  },
  {
    group: 'Cookies',
    label: 'Cookie value',
    syntax: 'cookie theme equals "dark"',
    description: 'Cookies support every text comparison and format check.',
  },
  {
    group: 'Performance',
    label: 'Time to first byte',
    syntax: 'timing ttfb < 300',
    description: 'A network phase in ms: total, preparation, dns, tcp, tls, ttfb, or download.',
  },
  {
    group: 'Security',
    label: 'Certificate expiry',
    syntax: 'certificate-days-left > 30',
    description: 'Whole days until the server certificate expires.',
  },
] as const;
function comparison(actual: number, operator: string, expected: number): boolean {
  if (!Number.isFinite(expected)) throw new Error('Expected a finite number.');
  if (operator === '==' || operator === '=') return actual === expected;
  if (operator === '!=') return actual !== expected;
  if (operator === '<') return actual < expected;
  if (operator === '<=') return actual <= expected;
  if (operator === '>') return actual > expected;
  if (operator === '>=') return actual >= expected;
  throw new Error('Use ==, !=, <, <=, >, or >=.');
}
function textArgument(source: string): string {
  if (source.startsWith('"')) {
    const value: unknown = JSON.parse(source);
    if (typeof value !== 'string') throw new Error('Expected text or a quoted JSON string.');
    return value;
  }
  return source;
}
/** Comparisons of text: header values, the body, and JSON strings. */
export const TEXT_OPERATORS = [
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'starts-with',
  'not-starts-with',
  'ends-with',
  'not-ends-with',
  'equals-ignore-case',
  'contains-ignore-case',
  'matches',
  'not-matches',
] as const;
export type TextOperator = (typeof TEXT_OPERATORS)[number];
/** Checks of a value's form, with nothing to compare against: `json $.id is-uuid`. */
export const FORMAT_CHECKS = [
  'is-uuid',
  'is-email',
  'is-url',
  'is-date',
  'is-number',
  'is-integer',
  'is-empty',
  'is-not-empty',
] as const;
/** Checks of a JSON array's items: no repeats, or in order. */
export const LIST_CHECKS = ['is-unique', 'is-sorted', 'is-sorted-desc'] as const;
/** Comparisons of an array (or text) with a JSON list of values. */
export const LIST_OPERATORS = ['contains-all', 'contains-any'] as const;
const FORMAT_PATTERN = [...FORMAT_CHECKS].sort((a, b) => b.length - a.length).join('|');
const LIST_CHECK_PATTERN = [...LIST_CHECKS].sort((a, b) => b.length - a.length).join('|');
const FORMAT_REGEXES: Record<string, RegExp> = {
  'is-uuid': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'is-email': /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  'is-number': /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/,
  'is-integer': /^-?\d+$/,
};
/**
 * Whether text is an ISO 8601 date or date-time that exists on the calendar: Date.parse would
 * quietly read 2026-02-30 as 2 March, so the day is checked against its month.
 */
export function isCalendarDate(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    );
  if (!match) return false;
  const [year, month, day, hour = '0', minute = '0', second = '0'] = match.slice(1, 7);
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= days &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
}
/** Whether a value has a form: text for the patterns, and any JSON value for emptiness. */
export function formatPasses(value: unknown, check: (typeof FORMAT_CHECKS)[number]): boolean {
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length) ||
    (typeof value === 'object' && value !== null && !Object.keys(value).length);
  if (check === 'is-empty') return empty;
  if (check === 'is-not-empty') return !empty;
  if (typeof value === 'number')
    return check === 'is-number' || (check === 'is-integer' && Number.isInteger(value));
  if (typeof value !== 'string') return false;
  if (check === 'is-url') {
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (check === 'is-date') return isCalendarDate(value);
  return FORMAT_REGEXES[check].test(value);
}
/** Whether an array's items are unique, or sorted (numbers by value, the rest as text). */
function listCheckPasses(value: unknown, check: (typeof LIST_CHECKS)[number]): boolean {
  if (!Array.isArray(value)) throw new Error(`${check} needs a JSON array.`);
  if (check === 'is-unique')
    return new Set(value.map((item) => JSON.stringify(item))).size === value.length;
  const numbers = value.every((item) => typeof item === 'number');
  const order = (a: unknown, b: unknown) =>
    numbers ? (a as number) - (b as number) : JSON.stringify(a).localeCompare(JSON.stringify(b));
  return value.every(
    (item, index) =>
      index === 0 ||
      (check === 'is-sorted'
        ? order(value[index - 1], item) <= 0
        : order(value[index - 1], item) >= 0),
  );
}
/** Whether an array (or text) holds all, or any, of a JSON list of values. */
function listPasses(value: unknown, operator: string, source: string): boolean {
  const expected = jsonList(source);
  if (!expected.length) throw new Error('List at least one value.');
  const has = (item: unknown) =>
    Array.isArray(value)
      ? value.some((entry) => sameJSON(entry, item))
      : typeof value === 'string'
        ? value.includes(typeof item === 'string' ? item : JSON.stringify(item))
        : (() => {
            throw new Error(`${operator} needs a JSON array or string.`);
          })();
  return operator === 'contains-all' ? expected.every(has) : expected.some(has);
}
const TEXT_OPERATOR_PATTERN = [...TEXT_OPERATORS]
  // Longer names first, so `contains-ignore-case` is not read as `contains`.
  .sort((a, b) => b.length - a.length)
  .join('|');
/**
 * A regular expression argument: `/pattern/flags`, or a pattern as plain or quoted text. Flags
 * that make matching stateful (g, y) are ignored, so a check gives the same answer every time.
 */
export function regexArgument(source: string): RegExp {
  const literal = source.match(/^\/(.+)\/([a-z]*)$/s);
  const pattern = literal ? literal[1] : textArgument(source);
  const flags = literal ? literal[2] : '';
  if (/[^dgimsuvy]/.test(flags))
    throw new Error('Regular expression flags can be d, i, m, s, u, or v.');
  try {
    return untrustedRegExp(pattern, flags.replace(/[gy]/g, ''));
  } catch (error) {
    throw new Error(`Invalid regular expression: ${(error as Error).message}`, { cause: error });
  }
}
/** Whether `actual` passes a text comparison against its argument as written. */
function compareText(actual: string, operator: TextOperator, source: string): boolean {
  if (operator === 'matches' || operator === 'not-matches')
    return regexArgument(source).test(actual) === (operator === 'matches');
  const expected = textArgument(source);
  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'not-equals':
      return actual !== expected;
    case 'contains':
      return actual.includes(expected);
    case 'not-contains':
      return !actual.includes(expected);
    case 'starts-with':
      return actual.startsWith(expected);
    case 'not-starts-with':
      return !actual.startsWith(expected);
    case 'ends-with':
      return actual.endsWith(expected);
    case 'not-ends-with':
      return !actual.endsWith(expected);
    case 'equals-ignore-case':
      return actual.toLowerCase() === expected.toLowerCase();
    default:
      return actual.toLowerCase().includes(expected.toLowerCase());
  }
}
/** An inclusive numeric range, `min max`. */
function between(actual: number, min: string, max: string): boolean {
  const low = Number(min),
    high = Number(max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error('Expected finite numbers.');
  if (low > high) throw new Error('Range minimum must not exceed maximum.');
  return actual >= low && actual <= high;
}
/** A JSON array literal of allowed values, for `in` and `not-in`. */
function jsonList(source: string): unknown[] {
  let list: unknown;
  try {
    list = JSON.parse(source);
  } catch {
    throw new Error('Expected a JSON array of values, such as ["active", "pending"].');
  }
  if (!Array.isArray(list)) throw new Error('Expected a JSON array of values.');
  return list;
}
/** A JSON literal, or the text itself when it is not one (an unquoted string). */
function jsonOrText(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}
export function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJSON(left[key], right[key]))
  );
}
export function findValue(root: unknown, path: string): { exists: boolean; value: unknown } {
  if (path === '$') return { exists: true, value: root };
  let rest = path.startsWith('$') ? path.slice(1) : path;
  let value = root,
    exists = true,
    first = true;
  while (rest) {
    const match =
      rest.match(/^(?:\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/) ||
      (first && !path.startsWith('$') ? rest.match(/^([A-Za-z_$][\w$-]*)/) : null);
    if (!match) throw new Error('Use a JSON path such as $.data.items[0].id or $["field.name"].');
    const key = match[3] ? (JSON.parse(match[3]) as string) : match[1] || match[2];
    if (exists && value !== null && typeof value === 'object' && Object.hasOwn(value, key))
      value = (value as Record<string, unknown>)[key];
    else {
      exists = false;
      value = undefined;
    }
    rest = rest.slice(match[0].length);
    first = false;
  }
  if (first) throw new Error('Enter a JSON path.');
  return { exists, value };
}
export function validatePath(path: string): void {
  findValue({}, path);
}
function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? 'missing' : text.length > 180 ? text.slice(0, 180) + '…' : text;
}
export function run(source: string, response: HttpResponse): AssertionResult[] {
  let parsed: unknown,
    jsonParsed = false;
  const json = () => {
    if (!jsonParsed) {
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new Error('Response body is not valid JSON.');
      }
      jsonParsed = true;
    }
    return parsed;
  };
  const headers = new Map(
    Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  let caseName: string | undefined;
  return source.split(/\r?\n/).flatMap((raw, index) => {
    const label = raw.trim();
    if (label.startsWith('// @case ')) {
      try {
        const value: unknown = JSON.parse(label.slice('// @case '.length));
        caseName = typeof value === 'string' ? value : undefined;
      } catch {
        caseName = undefined;
      }
      return [];
    }
    if (label.startsWith('// @disabled ')) {
      caseName = undefined;
      return [];
    }
    if (!label || label.startsWith('//') || label.startsWith('#')) {
      caseName = undefined;
      return [];
    }
    const name = caseName;
    caseName = undefined;
    let pass: boolean;
    let message: string;
    try {
      let match: RegExpMatchArray | null;
      if ((match = label.match(/^status (\d{3})$/))) {
        pass = response.status === Number(match[1]);
        message = `Actual status: ${response.status}`;
      } else if ((match = label.match(/^status between (\d{3}) (\d{3})$/))) {
        const min = Number(match[1]),
          max = Number(match[2]);
        if (min > max) throw new Error('Range minimum must not exceed maximum.');
        pass = response.status >= min && response.status <= max;
        message = `Actual status: ${response.status}`;
      } else if ((match = label.match(/^status (in|not-in) (\d{3}(?:\s*,\s*\d{3})*)$/))) {
        const listed = match[2].split(',').map(Number).includes(response.status);
        pass = match[1] === 'in' ? listed : !listed;
        message = `Actual status: ${response.status}`;
      } else if (
        (match = label.match(
          /^(status|response-time|response-size|body-length) (?:(==|!=|<=|>=|<|>|=) (\S+)|between (\S+) (\S+))$/,
        ))
      ) {
        const actual =
          match[1] === 'status'
            ? response.status
            : match[1] === 'response-time'
              ? response.time
              : match[1] === 'response-size'
                ? response.size
                : response.body.length;
        pass = match[2]
          ? comparison(actual, match[2], Number(match[3]))
          : between(actual, match[4], match[5]);
        const unit = {
          'response-time': ' ms',
          'response-size': ' bytes',
          'body-length': ' characters',
        }[match[1]];
        message = `Actual: ${actual}${unit ?? ''}`;
      } else if (
        (match = label.match(
          /^(timing (\S+)|certificate-days-left) (?:(==|!=|<=|>=|<|>|=) (\S+)|between (\S+) (\S+))$/,
        ))
      ) {
        const actual = Number(
          match[2]
            ? timingCapture(response, match[2].toLowerCase())
            : certificateCapture(response, 'days-left'),
        );
        pass = match[3]
          ? comparison(actual, match[3], Number(match[4]))
          : between(actual, match[5], match[6]);
        message = match[2] ? `Actual: ${actual} ms` : `Actual: ${actual} days`;
      } else if ((match = label.match(/^(cookie-exists|cookie-not-exists) (\S+)$/))) {
        const exists = responseCookies(response).some((cookie) => cookie.name === match![2]);
        pass = match[1] === 'cookie-exists' ? exists : !exists;
        message = exists ? 'The response set the cookie.' : 'The response did not set the cookie.';
      } else if (
        (match = label.match(new RegExp(`^cookie (\\S+) (${FORMAT_PATTERN})$`))) ||
        (match = label.match(new RegExp(`^cookie (\\S+) (${TEXT_OPERATOR_PATTERN}) (.+)$`)))
      ) {
        const name = match[1];
        const actual = responseCookies(response)
          .filter((cookie) => cookie.name === name)
          .at(-1)?.value;
        pass =
          actual !== undefined &&
          (match[3] === undefined
            ? formatPasses(actual, match[2] as (typeof FORMAT_CHECKS)[number])
            : compareText(actual, match[2] as TextOperator, match[3]));
        message =
          actual === undefined
            ? 'The response did not set the cookie.'
            : `Actual: ${describe(actual)}`;
      } else if ((match = label.match(new RegExp(`^header (\\S+) (${FORMAT_PATTERN})$`)))) {
        const actual = headers.get(match[1].toLowerCase());
        pass =
          actual !== undefined && formatPasses(actual, match[2] as (typeof FORMAT_CHECKS)[number]);
        message = actual === undefined ? 'Header is absent.' : `Actual: ${describe(actual)}`;
      } else if ((match = label.match(/^(header-exists|header-not-exists) (\S+)$/))) {
        const exists = headers.has(match[2].toLowerCase());
        pass = match[1] === 'header-exists' ? exists : !exists;
        message = exists ? 'Header is present.' : 'Header is absent.';
      } else if (
        (match = label.match(new RegExp(`^header (\\S+) (${TEXT_OPERATOR_PATTERN}) (.+)$`)))
      ) {
        const actual = headers.get(match[1].toLowerCase());
        pass = actual !== undefined && compareText(actual, match[2] as TextOperator, match[3]);
        message = actual === undefined ? 'Header is absent.' : `Actual: ${describe(actual)}`;
      } else if ((match = label.match(/^content-type (\S+)$/))) {
        const actual = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        pass = actual === match[1].toLowerCase();
        message = `Actual media type: ${actual || 'missing'}`;
      } else if ((match = label.match(/^(body-contains|body-not-contains|body-equals) (.+)$/))) {
        const expected = textArgument(match[2]);
        pass =
          match[1] === 'body-contains'
            ? response.body.includes(expected)
            : match[1] === 'body-not-contains'
              ? !response.body.includes(expected)
              : response.body === expected;
        message = pass ? 'Body check passed.' : 'Body did not match the expected text check.';
      } else if ((match = label.match(new RegExp(`^body (${TEXT_OPERATOR_PATTERN}) (.+)$`)))) {
        pass = compareText(response.body, match[1] as TextOperator, match[2]);
        message = pass ? 'Body check passed.' : `Body did not pass "${match[1]}".`;
      } else if ((match = label.match(/^json-schema(?: (\$\S*))? (\{.*\})$/))) {
        let schema: unknown;
        try {
          schema = JSON.parse(match[2]);
        } catch {
          throw new Error('Expected a JSON Schema object.');
        }
        const found = findValue(json(), match[1] || '$');
        if (!found.exists) throw new Error('JSON path is missing.');
        const problems = validateJsonSchema(found.value, schema);
        pass = !problems.length;
        message = pass
          ? 'Matches the JSON Schema.'
          : problems
              .slice(0, 3)
              .map((problem) => `${problem.path || 'value'} ${problem.message}`)
              .join('; ') + (problems.length > 3 ? ` (and ${problems.length - 3} more)` : '');
      } else if (label === 'body-empty' || label === 'body-not-empty') {
        pass = label === 'body-empty' ? !response.body.trim() : Boolean(response.body.trim());
        message = `Body length: ${response.body.length} characters`;
      } else if (label === 'json-valid') {
        json();
        pass = true;
        message = 'Response is valid JSON.';
      } else if ((match = label.match(/^(json-exists|json-not-exists) (.+)$/))) {
        const found = findValue(json(), match[2]);
        pass = match[1] === 'json-exists' ? found.exists : !found.exists;
        message = found.exists ? `Actual: ${describe(found.value)}` : 'JSON path is missing.';
      } else if (
        (match = label.match(/^json-type (.+) (object|array|string|number|integer|boolean|null)$/))
      ) {
        const found = findValue(json(), match[1]);
        const actual =
          found.value === null ? 'null' : Array.isArray(found.value) ? 'array' : typeof found.value;
        pass =
          found.exists &&
          (match[2] === 'integer'
            ? typeof found.value === 'number' && Number.isInteger(found.value)
            : actual === match[2]);
        message = found.exists ? `Actual type: ${actual}` : 'JSON path is missing.';
      } else if (
        (match = label.match(
          /^json-length (.+?) (?:(==|!=|<=|>=|<|>|=) (\S+)|between (\S+) (\S+))$/,
        ))
      ) {
        const found = findValue(json(), match[1]);
        if (!found.exists) throw new Error('JSON path is missing.');
        const value = found.value;
        const length =
          typeof value === 'string' || Array.isArray(value)
            ? value.length
            : value && typeof value === 'object'
              ? Object.keys(value).length
              : undefined;
        if (length === undefined) throw new Error('Length requires a string, array, or object.');
        pass = match[2]
          ? comparison(length, match[2], Number(match[3]))
          : between(length, match[4], match[5]);
        message = `Actual length: ${length}`;
      } else if (
        (match = label.match(new RegExp(`^json (.+?) (${FORMAT_PATTERN}|${LIST_CHECK_PATTERN})$`)))
      ) {
        const found = findValue(json(), match[1]);
        if (!found.exists) throw new Error('JSON path is missing.');
        const check = match[2];
        pass = (FORMAT_CHECKS as readonly string[]).includes(check)
          ? formatPasses(found.value, check as (typeof FORMAT_CHECKS)[number])
          : listCheckPasses(found.value, check as (typeof LIST_CHECKS)[number]);
        message = `Actual: ${describe(found.value)}`;
      } else if ((match = label.match(/^json (.+?) (contains-all|contains-any) (\[.*\])$/))) {
        const found = findValue(json(), match[1]);
        if (!found.exists) throw new Error('JSON path is missing.');
        pass = listPasses(found.value, match[2], match[3]);
        message = `Actual: ${describe(found.value)}`;
      } else if (
        (match = label.match(
          new RegExp(
            `^json (.+?) (${TEXT_OPERATOR_PATTERN}|not-in|in|between|==|!=|<=|>=|<|>|=) (.+)$`,
          ),
        ))
      ) {
        const found = findValue(json(), match[1]);
        if (!found.exists) throw new Error('JSON path is missing.');
        const operator = match[2];
        if (operator === 'in' || operator === 'not-in') {
          const listed = jsonList(match[3]).some((item) => sameJSON(found.value, item));
          pass = operator === 'in' ? listed : !listed;
        } else if (operator === 'between') {
          const range = match[3].match(/^(\S+) (\S+)$/);
          if (!range) throw new Error('Use between with a minimum and a maximum.');
          if (typeof found.value !== 'number') throw new Error('A range requires a JSON number.');
          pass = between(found.value, range[1], range[2]);
        } else if (
          Array.isArray(found.value) &&
          (operator === 'contains' || operator === 'not-contains')
        ) {
          const expected = jsonOrText(match[3]);
          const included = found.value.some((item) => sameJSON(item, expected));
          pass = operator === 'contains' ? included : !included;
        } else if (
          (TEXT_OPERATORS as readonly string[]).includes(operator) &&
          !['equals', 'not-equals'].includes(operator)
        ) {
          if (typeof found.value !== 'string')
            throw new Error(
              operator.includes('contains')
                ? 'Contains requires a JSON string or array.'
                : 'This comparison requires a JSON string.',
            );
          pass = compareText(found.value, operator as TextOperator, match[3]);
        } else if (match[2] === 'equals' || match[2] === 'not-equals') {
          let expected: unknown;
          try {
            expected = JSON.parse(match[3]);
          } catch {
            throw new Error('Expected a valid JSON literal; quote string values.');
          }
          pass =
            match[2] === 'equals'
              ? sameJSON(found.value, expected)
              : !sameJSON(found.value, expected);
        } else {
          if (typeof found.value !== 'number')
            throw new Error('Numeric comparison requires a JSON number.');
          pass = comparison(found.value, match[2], Number(match[3]));
        }
        message = `Actual: ${describe(found.value)}`;
      } else throw new Error('Unknown assertion. Choose an example from the Tests tab.');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      pass = false;
    }
    return [{ label, pass, message, line: index + 1, ...(name ? { name } : {}) }];
  });
}
