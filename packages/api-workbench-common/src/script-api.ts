import type { ScriptPhase } from './scripts';

/**
 * A description of what request scripts can reach — the `aw` API built in `script-engine.ts`,
 * and the few globals beside it — for the script editor's suggestions. It is data only: the
 * engine is the authority, and a spec runs the engine to check that this list matches it.
 */

/** Values a script passes by name, which the editor can list for a string argument. */
export type ScriptArgumentKind =
  'variable' | 'module' | 'request-header' | 'response-header' | 'hash-algorithm';

export interface ScriptApiMember {
  name: string;
  kind: 'namespace' | 'property' | 'function';
  /** How it is called or what it holds, such as `(name: string) => string | undefined`. */
  signature: string;
  doc: string;
  /** Where it works, when that is only one phase. */
  phase?: ScriptPhase;
  /** The type of the property, or what the function returns, when it has members to offer. */
  type?: ScriptApiTypeName | 'json';
  /** What its first argument names, when the editor can list the choices. */
  argument?: ScriptArgumentKind;
}

export type ScriptApiTypeName =
  | 'aw'
  | 'request'
  | 'requestHeaders'
  | 'response'
  | 'responseHeaders'
  | 'vars'
  | 'crypto'
  | 'base64'
  | 'expectation';

const fn = (
  name: string,
  signature: string,
  doc: string,
  extra: Partial<ScriptApiMember> = {},
): ScriptApiMember => ({ name, kind: 'function', signature, doc, ...extra });
const prop = (
  name: string,
  signature: string,
  doc: string,
  extra: Partial<ScriptApiMember> = {},
): ScriptApiMember => ({ name, kind: 'property', signature, doc, ...extra });
const space = (name: string, type: ScriptApiTypeName, doc: string, phase?: ScriptPhase) => ({
  name,
  kind: 'namespace' as const,
  signature: type,
  doc,
  type,
  ...(phase ? { phase } : {}),
});

const ENCODING = "as?: 'hex' | 'base64' | 'base64url'";

/** The members of each type in the `aw` API. */
export const SCRIPT_API: Record<ScriptApiTypeName, ScriptApiMember[]> = {
  aw: [
    prop('phase', "'pre' | 'post'", 'Which script is running: pre-request or post-response.'),
    fn('log', '(...values: unknown[]) => void', 'Writes a line to the console.'),
    fn('info', '(...values: unknown[]) => void', 'Writes an information line to the console.'),
    fn('warn', '(...values: unknown[]) => void', 'Writes a warning to the console.'),
    fn('error', '(...values: unknown[]) => void', 'Writes an error line to the console.'),
    fn(
      'require',
      '(name: string) => unknown',
      'Loads a module from the workspace library (Scripts → Library) and returns its exports.',
      { argument: 'module' },
    ),
    space(
      'request',
      'request',
      'The request being sent. Changeable in a pre-request script, read-only after.',
    ),
    space(
      'response',
      'response',
      'The response that arrived. Undefined in a pre-request script.',
      'post',
    ),
    space('vars', 'vars', 'Variables of the active environment, and of the data row in a run.'),
    fn(
      'test',
      '(name: string, run: () => void) => void',
      'Records a test: it passes unless `run` throws. Shown with the request’s tests.',
    ),
    fn(
      'expect',
      '(actual: unknown) => Expectation',
      'Starts an expectation, such as `aw.expect(aw.response.status).toBe(200)`.',
      { type: 'expectation' },
    ),
    fn(
      'assert',
      '(condition: unknown, message?: string) => void',
      'Throws, failing the test it is in, when `condition` is falsy.',
    ),
    space('crypto', 'crypto', 'Hashes, HMAC signatures, and random values.'),
    space('base64', 'base64', 'Base64 of UTF-8 text.'),
    fn('uuid', '() => string', 'A random UUID (version 4).'),
  ],
  request: [
    prop('name', 'string', 'The request’s name.'),
    prop('method', 'string', 'The HTTP method. Can be set in a pre-request script.'),
    prop(
      'url',
      'string',
      'The URL, with {{variables}} not yet resolved. Can be set before sending.',
    ),
    prop(
      'body',
      'string',
      'The body text. Set it to a string, or to a value to send as JSON, before sending.',
    ),
    space('headers', 'requestHeaders', 'The request’s enabled headers.'),
  ],
  requestHeaders: [
    fn('get', '(name: string) => string | undefined', 'The value of a header, in any case.', {
      argument: 'request-header',
    }),
    fn('has', '(name: string) => boolean', 'Whether the header is set.', {
      argument: 'request-header',
    }),
    fn('set', '(name: string, value: unknown) => void', 'Adds or replaces a header.', {
      phase: 'pre',
      argument: 'request-header',
    }),
    fn('remove', '(name: string) => void', 'Removes a header.', {
      phase: 'pre',
      argument: 'request-header',
    }),
    fn('toObject', '() => Record<string, string>', 'The enabled headers as an object.'),
  ],
  response: [
    prop('status', 'number', 'The status code, such as 200.'),
    prop('statusText', 'string', 'The status text, such as OK.'),
    prop('time', 'number', 'How long the response took, in milliseconds.'),
    prop('size', 'number', 'The size of the response, in bytes.'),
    prop('url', 'string', 'The URL that answered, after any redirects.'),
    prop('body', 'string', 'The body as text.'),
    fn('text', '() => string', 'The body as text.'),
    fn('json', '() => any', 'The body parsed as JSON. Throws when it is not JSON.', {
      type: 'json',
    }),
    space('headers', 'responseHeaders', 'The response headers.'),
  ],
  responseHeaders: [
    fn('get', '(name: string) => string | undefined', 'The value of a header, in any case.', {
      argument: 'response-header',
    }),
    fn('has', '(name: string) => boolean', 'Whether the response has the header.', {
      argument: 'response-header',
    }),
    fn('toObject', '() => Record<string, string>', 'The headers as an object.'),
  ],
  vars: [
    fn('get', '(name: string) => string | undefined', 'The value of a variable.', {
      argument: 'variable',
    }),
    fn('has', '(name: string) => boolean', 'Whether the variable is defined.', {
      argument: 'variable',
    }),
    fn(
      'set',
      '(name: string, value: unknown) => void',
      'Saves a value in the active environment, for this request and later ones.',
      { argument: 'variable' },
    ),
    fn('unset', '(name: string) => void', 'Removes a variable from the active environment.', {
      argument: 'variable',
    }),
    fn('toObject', '() => Record<string, string>', 'Every variable, as an object.'),
  ],
  crypto: [
    fn(
      'hash',
      `(algorithm: string, text: string, ${ENCODING}) => string`,
      'A hash of the text, such as sha256 or md5, in hex unless asked otherwise.',
      { argument: 'hash-algorithm' },
    ),
    fn(
      'hmac',
      `(algorithm: string, key: string, text: string, ${ENCODING}) => string`,
      'An HMAC signature of the text with the key.',
      { argument: 'hash-algorithm' },
    ),
    fn('sha256', `(text: string, ${ENCODING}) => string`, 'The SHA-256 hash of the text.'),
    fn(
      'randomBytes',
      `(size: number, ${ENCODING}) => string`,
      'Random bytes, from 1 to 1024 of them, encoded as text.',
    ),
    fn('randomUUID', '() => string', 'A random UUID (version 4).'),
  ],
  base64: [
    fn('encode', '(text: string) => string', 'Base64 of the text’s UTF-8 bytes.'),
    fn('decode', '(text: string) => string', 'The UTF-8 text a Base64 string holds.'),
  ],
  expectation: [
    prop('not', 'Expectation', 'The same checks, expecting the opposite.', {
      type: 'expectation',
    }),
    fn('toBe', '(expected: unknown) => void', 'The same value, compared with Object.is.'),
    fn('toEqual', '(expected: unknown) => void', 'An equal value, compared deeply.'),
    fn(
      'toContain',
      '(expected: unknown) => void',
      'Text that includes it, or an array with an equal item.',
    ),
    fn(
      'toMatch',
      '(pattern: RegExp | string) => void',
      'Text that matches the pattern or contains the string.',
    ),
    fn('toBeGreaterThan', '(expected: number) => void', 'A number greater than expected.'),
    fn('toBeGreaterThanOrEqual', '(expected: number) => void', 'A number at least expected.'),
    fn('toBeLessThan', '(expected: number) => void', 'A number less than expected.'),
    fn('toBeLessThanOrEqual', '(expected: number) => void', 'A number at most expected.'),
    fn('toBeOneOf', '(values: unknown[]) => void', 'A value equal to one in the list.'),
    fn('toHaveLength', '(length: number) => void', 'Text or an array of that length.'),
    fn(
      'toHaveProperty',
      '(path: string, value?: unknown) => void',
      'An object with the dotted property path, and that value when given.',
    ),
    fn('toBeTruthy', '() => void', 'A value that is true in a condition.'),
    fn('toBeFalsy', '() => void', 'A value that is false in a condition.'),
    fn('toBeDefined', '() => void', 'Any value but undefined.'),
    fn('toBeUndefined', '() => void', 'Undefined.'),
    fn('toBeNull', '() => void', 'Null.'),
  ],
};

/** Names a script can use without `aw.`: the API itself, and Base64 as browsers name it. */
export const SCRIPT_GLOBALS: ScriptApiMember[] = [
  space('aw', 'aw', 'The API Workbench script API: the request, response, variables, and tests.'),
  fn('btoa', '(text: string) => string', 'Base64 of the text’s UTF-8 bytes.'),
  fn('atob', '(base64: string) => string', 'The UTF-8 text a Base64 string holds.'),
];

/** Hash algorithms to suggest; the engine accepts any Node.js supports. */
const HASH_ALGORITHMS = ['sha256', 'sha512', 'sha384', 'sha1', 'md5'];

/** What the editor knows about where a script runs, for suggestions beyond the API. */
export interface ScriptCompletionContext {
  /** The script being edited, or undefined for a library module, which runs in either. */
  phase?: ScriptPhase;
  /** Names of the variables the script can read. */
  variables: string[];
  /** Names of the workspace's library modules. */
  modules: string[];
  /** Names of the request's headers. */
  requestHeaders: string[];
  /** Names of the last response's headers. */
  responseHeaders: string[];
  /** The last response's body, parsed, when it was JSON. */
  responseJson?: unknown;
}

export interface ScriptSuggestion {
  label: string;
  kind: 'namespace' | 'property' | 'function' | 'variable' | 'text';
  detail?: string;
  doc?: string;
  /** Functions are inserted with their parentheses, the cursor between them. */
  call?: boolean;
  /** Lower for members of the other phase, which would fail if used here. */
  boost?: number;
}
export interface ScriptCompletionResult {
  /** Where the replaced text starts, as an offset into the text given. */
  from: number;
  options: ScriptSuggestion[];
  /** Whether the options are already narrowed to what was typed. */
  filtered: boolean;
}

/** What an expression evaluates to, as far as suggestions can tell. */
type Resolved =
  | { kind: 'type'; type: ScriptApiTypeName }
  | { kind: 'member'; member: ScriptApiMember }
  | { kind: 'json'; value: unknown };

type Segment = { kind: 'name'; name: string } | { kind: 'call' } | { kind: 'index'; key: string };

const IDENTIFIER = /[A-Za-z_$][\w$]*$/;
/** Text this far back is enough to read an expression and the assignments it relies on. */
const LOOK_BACK = 20_000;

/**
 * Reads the expression ending at `end` backwards — names, `.`, `?.`, calls, and `[…]` — and
 * returns its parts in order, or undefined when it is not one suggestions can follow.
 */
function chainBefore(text: string, end: number): Segment[] | undefined {
  const segments: Segment[] = [];
  let at = end;
  for (;;) {
    while (at > 0 && /\s/.test(text[at - 1])) at--;
    const char = text[at - 1];
    if (char === ')' || char === ']') {
      const open = char === ')' ? '(' : '[';
      let depth = 0;
      let index = at - 1;
      for (; index >= 0; index--) {
        if (text[index] === char) depth++;
        else if (text[index] === open && --depth === 0) break;
      }
      if (index < 0) return undefined;
      if (char === ')') segments.unshift({ kind: 'call' });
      else {
        const inner = text.slice(index + 1, at - 1).trim();
        const key = /^(?:(\d+)|(['"])([^'"]*)\2)$/.exec(inner);
        if (!key) return undefined;
        segments.unshift({ kind: 'index', key: key[1] ?? key[3] });
      }
      at = index;
      continue;
    }
    const name = IDENTIFIER.exec(text.slice(Math.max(0, at - 200), at));
    if (!name) return undefined;
    segments.unshift({ kind: 'name', name: name[0] });
    at -= name[0].length;
    while (at > 0 && /\s/.test(text[at - 1])) at--;
    if (text[at - 1] === '.') {
      at -= text[at - 2] === '?' ? 2 : 1;
      continue;
    }
    // The first name stands alone: it must not be a property of something unreadable.
    return segments;
  }
}

/** The expression a `const`, `let`, or `var` gave a name, the last time before `end`. */
function assignment(text: string, name: string, end: number): Segment[] | undefined {
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*([^;\\n]+)`,
    'g',
  );
  let found: RegExpExecArray | null;
  let last: RegExpExecArray | undefined;
  while ((found = pattern.exec(text)) && found.index < end) last = found;
  if (!last) return undefined;
  const expression = last[1].trimEnd();
  const start = last.index + last[0].length - last[1].length;
  return chainBefore(text, start + expression.length);
}

function resolve(
  text: string,
  segments: Segment[],
  context: ScriptCompletionContext,
  end: number,
  depth = 0,
): Resolved | undefined {
  const [first, ...rest] = segments;
  if (first?.kind !== 'name') return undefined;
  let current: Resolved | undefined;
  const global = SCRIPT_GLOBALS.find((member) => member.name === first.name);
  if (global?.type && global.type !== 'json') current = { kind: 'type', type: global.type };
  else if (depth < 5) {
    // A name given to part of the API earlier in the script, as in `const body = aw.response.json()`.
    const assigned = assignment(text, first.name, end);
    current = assigned && resolve(text, assigned, context, end, depth + 1);
  }
  for (const segment of rest) {
    if (!current) return undefined;
    current = step(current, segment, context);
  }
  return current;
}

function step(
  current: Resolved,
  segment: Segment,
  context: ScriptCompletionContext,
): Resolved | undefined {
  if (current.kind === 'json') {
    const value = current.value;
    if (segment.kind === 'call' || value === null || typeof value !== 'object') return undefined;
    const key = segment.kind === 'name' ? segment.name : segment.key;
    return Object.prototype.hasOwnProperty.call(value, key)
      ? { kind: 'json', value: (value as Record<string, unknown>)[key] }
      : undefined;
  }
  if (current.kind === 'member') {
    // Calling a function gives what it returns; a property gives its type.
    if (segment.kind !== 'call' || current.member.kind !== 'function') return undefined;
    return typed(current.member.type, context);
  }
  if (segment.kind !== 'name') return undefined;
  const member = SCRIPT_API[current.type].find((item) => item.name === segment.name);
  if (!member) return undefined;
  return member.kind === 'function' ? { kind: 'member', member } : typed(member.type, context);
}

function typed(
  type: ScriptApiMember['type'],
  context: ScriptCompletionContext,
): Resolved | undefined {
  if (!type) return undefined;
  if (type === 'json')
    return context.responseJson === undefined
      ? undefined
      : { kind: 'json', value: context.responseJson };
  return { kind: 'type', type };
}

/** Suggestions for the members of an API type, marking those of the other phase. */
function members(list: ScriptApiMember[], phase: ScriptPhase | undefined): ScriptSuggestion[] {
  return list.map((member) => {
    const elsewhere = Boolean(phase && member.phase && member.phase !== phase);
    return {
      label: member.name,
      kind: member.kind,
      detail: member.signature,
      doc: elsewhere
        ? `${member.doc} Only in ${member.phase === 'pre' ? 'pre-request' : 'post-response'} scripts.`
        : member.doc,
      call: member.kind === 'function',
      ...(elsewhere ? { boost: -1 } : {}),
    };
  });
}

const valueKind = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? `array (${value.length})` : typeof value;

/** The keys of a value from the last response, with what each holds. */
function jsonMembers(value: unknown): ScriptSuggestion[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value))
    return [{ label: 'length', kind: 'property', detail: 'number', doc: 'How many items.' }];
  return Object.keys(value)
    .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key))
    .slice(0, 200)
    .map((key) => ({
      label: key,
      kind: 'property' as const,
      detail: valueKind((value as Record<string, unknown>)[key]),
      doc: 'From the last response.',
    }));
}

const startsWith = (name: string, lower: string) => name.toLowerCase().startsWith(lower);

function argumentChoices(kind: ScriptArgumentKind, context: ScriptCompletionContext): string[] {
  switch (kind) {
    case 'variable':
      return context.variables;
    case 'module':
      return context.modules;
    case 'request-header':
      return context.requestHeaders;
    case 'response-header':
      return context.responseHeaders;
    case 'hash-algorithm':
      return HASH_ALGORITHMS;
  }
}

/**
 * Suggestions for the script `text` with the cursor at its end: members after a `.` (the `aw` API,
 * names given to parts of it, and keys of the last JSON response), names of variables, modules,
 * and headers inside the first string argument of a call that takes one, and the API's globals
 * at the start of a name. `explicit` is a request for suggestions (Ctrl+Space) with nothing typed.
 */
export function scriptCompletions(
  source: string,
  context: ScriptCompletionContext,
  explicit = false,
): ScriptCompletionResult | null {
  const offset = Math.max(0, source.length - LOOK_BACK);
  const text = source.slice(offset);
  const end = text.length;

  // Inside the first string argument: aw.vars.get('na|
  const argument = /([A-Za-z_$][\w$.?]*)\(\s*(['"`])([^'"`\\\n]*)$/.exec(text);
  if (argument) {
    const segments = chainBefore(text, argument.index + argument[1].length);
    const target = segments && resolve(text, segments, context, argument.index);
    if (target?.kind !== 'member' || !target.member.argument) return null;
    const typed = argument[3];
    const lower = typed.toLowerCase();
    const options = [...new Set(argumentChoices(target.member.argument, context))]
      .filter((name) => name && name.toLowerCase().includes(lower))
      // Names that start with what was typed come before those that only contain it.
      .sort((a, b) => Number(!startsWith(a, lower)) - Number(!startsWith(b, lower)))
      .slice(0, 100)
      .map((name) => ({ label: name, kind: 'text' as const }));
    return options.length ? { from: offset + end - typed.length, options, filtered: true } : null;
  }

  const typed = IDENTIFIER.exec(text)?.[0] ?? '';
  let before = end - typed.length;
  while (before > 0 && /\s/.test(text[before - 1]) && text[before - 1] !== '\n') before--;
  // After a dot: aw.request.hea|
  if (text[before - 1] === '.' && text[before - 2] !== '.') {
    const receiverEnd = before - (text[before - 2] === '?' ? 2 : 1);
    const segments = chainBefore(text, receiverEnd);
    const target = segments && resolve(text, segments, context, receiverEnd);
    if (!target) return null;
    const options =
      target.kind === 'type'
        ? members(SCRIPT_API[target.type], context.phase)
        : target.kind === 'json'
          ? jsonMembers(target.value)
          : [];
    return options.length ? { from: offset + end - typed.length, options, filtered: false } : null;
  }
  // The start of a name, outside strings and comments, which the editor rules out.
  if (!typed && !explicit) return null;
  return {
    from: offset + end - typed.length,
    options: members(SCRIPT_GLOBALS, context.phase),
    filtered: false,
  };
}
