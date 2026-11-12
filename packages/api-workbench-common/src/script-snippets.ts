import type { ScriptPhase } from './scripts';

/**
 * Ready-made code for request scripts, listed beside the script editor and inserted at the
 * cursor. Each says where it fits: before sending (`pre`), after the response (`post`), or in a
 * library module (`module`). script-engine.spec.ts runs every one, so none of them is broken.
 */
export type SnippetPlace = ScriptPhase | 'module';
export interface ScriptSnippet {
  id: string;
  group: string;
  title: string;
  /** One line on what it does, shown under the title. */
  description: string;
  places: readonly SnippetPlace[];
  code: string;
  /** Saved by someone in this workspace, rather than built in. */
  custom?: true;
}
/** A snippet saved in a workspace: what the person typed, with an id to edit it by. */
export interface UserSnippet {
  id: string;
  title: string;
  description?: string;
  places: SnippetPlace[];
  code: string;
}
export const SNIPPET_PLACES: readonly SnippetPlace[] = ['pre', 'post', 'module'];
export const SNIPPET_PLACE_LABELS: Record<SnippetPlace, string> = {
  pre: 'Pre-request',
  post: 'Post-response',
  module: 'Library module',
};
/** The group saved snippets are listed under, first. */
export const CUSTOM_GROUP = 'My snippets';
export const SNIPPET_LIMITS = { snippets: 200, title: 80, description: 200, code: 64 * 1024 };

/** Why a snippet cannot be saved, or nothing when it can. */
export function snippetProblem(snippet: Omit<UserSnippet, 'id'>): string | undefined {
  if (!snippet.title.trim()) return 'Give the snippet a title.';
  if (snippet.title.length > SNIPPET_LIMITS.title)
    return `Keep the title to ${SNIPPET_LIMITS.title} characters.`;
  if ((snippet.description ?? '').length > SNIPPET_LIMITS.description)
    return `Keep the description to ${SNIPPET_LIMITS.description} characters.`;
  if (!snippet.places.length) return 'Choose at least one place to use it.';
  if (!snippet.code.trim()) return 'Add the code to insert.';
  if (snippet.code.length > SNIPPET_LIMITS.code) return 'The code is longer than 64 KB.';
  return undefined;
}
/** Saved snippets as read from a file or an import: valid ones only, with unique ids. */
export function normalizedSnippets(value: unknown): UserSnippet[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const snippets: UserSnippet[] = [];
  for (const item of value as Partial<UserSnippet>[]) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string')
      continue;
    if (typeof item.code !== 'string' || !Array.isArray(item.places)) continue;
    if (snippets.some((snippet) => snippet.id === item.id)) continue;
    const snippet: UserSnippet = {
      id: item.id,
      title: item.title,
      ...(typeof item.description === 'string' && item.description
        ? { description: item.description }
        : {}),
      places: SNIPPET_PLACES.filter((place) => item.places!.includes(place)),
      code: item.code,
    };
    if (snippetProblem(snippet)) continue;
    snippets.push(snippet);
    if (snippets.length >= SNIPPET_LIMITS.snippets) break;
  }
  return snippets.length ? snippets : undefined;
}
const ANYWHERE: readonly SnippetPlace[] = ['pre', 'post', 'module'];
const SCRIPTS: readonly SnippetPlace[] = ['pre', 'post'];

/** The groups, in the order the panel lists them. */
export const SNIPPET_GROUPS = [
  CUSTOM_GROUP,
  'Variables',
  'Request',
  'Dynamic values',
  'Response tests',
  'Response values',
  'Crypto and encoding',
  'Logging',
  'Library',
] as const;

export const SCRIPT_SNIPPETS: readonly ScriptSnippet[] = [
  // Variables
  {
    id: 'get-variable',
    group: 'Variables',
    title: 'Get a variable',
    description: 'Read a variable from the environment, or the data row in a run.',
    places: ANYWHERE,
    code: "const value = aw.vars.get('variable_name');",
  },
  {
    id: 'set-variable',
    group: 'Variables',
    title: 'Set a variable',
    description: 'Save a value in the active environment for this and later requests.',
    places: ANYWHERE,
    code: "aw.vars.set('variable_name', 'value');",
  },
  {
    id: 'unset-variable',
    group: 'Variables',
    title: 'Remove a variable',
    description: 'Delete a variable from the active environment.',
    places: ANYWHERE,
    code: "aw.vars.unset('variable_name');",
  },
  {
    id: 'require-variable',
    group: 'Variables',
    title: 'Warn when a variable is missing',
    description: 'Write a warning to the console when a variable is not set.',
    places: ANYWHERE,
    code: "if (!aw.vars.has('token')) {\n  aw.warn('The token variable is not set');\n}",
  },
  {
    id: 'default-variable',
    group: 'Variables',
    title: 'Set a variable once',
    description: 'Give a variable a value only when it does not have one yet.',
    places: SCRIPTS,
    code: "if (!aw.vars.has('page_size')) aw.vars.set('page_size', '20');",
  },

  // Request
  {
    id: 'set-header',
    group: 'Request',
    title: 'Set a header',
    description: 'Add a header, or replace one with the same name.',
    places: ['pre'],
    code: "aw.request.headers.set('X-Request-Id', aw.uuid());",
  },
  {
    id: 'remove-header',
    group: 'Request',
    title: 'Remove a header',
    description: 'Leave a header out of what is sent.',
    places: ['pre'],
    code: "aw.request.headers.remove('X-Debug');",
  },
  {
    id: 'bearer-token',
    group: 'Request',
    title: 'Send a Bearer token from a variable',
    description: 'Set the Authorization header from the token variable.',
    places: ['pre'],
    code: "aw.request.headers.set('Authorization', 'Bearer ' + aw.vars.get('token'));",
  },
  {
    id: 'basic-auth',
    group: 'Request',
    title: 'Build a Basic auth header',
    description: 'Encode a username and password from variables.',
    places: ['pre'],
    code: "const credentials = aw.base64.encode(aw.vars.get('username') + ':' + aw.vars.get('password'));\naw.request.headers.set('Authorization', 'Basic ' + credentials);",
  },
  {
    id: 'query-parameter',
    group: 'Request',
    title: 'Add a query parameter',
    description: 'Append a parameter to the URL.',
    places: ['pre'],
    code: "const separator = aw.request.url.includes('?') ? '&' : '?';\naw.request.url = aw.request.url + separator + 'page=' + encodeURIComponent('1');",
  },
  {
    id: 'json-body',
    group: 'Request',
    title: 'Change a JSON body',
    description: 'Parse the body, change a field, and send it back as JSON.',
    places: ['pre'],
    code: "const body = JSON.parse(aw.request.body || '{}');\nbody.requestedAt = new Date().toISOString();\naw.request.body = body;",
  },
  {
    id: 'log-request',
    group: 'Request',
    title: 'Log the request',
    description: 'Write the method and URL to the console.',
    places: SCRIPTS,
    code: 'aw.log(aw.request.method, aw.request.url);',
  },

  // Dynamic values
  {
    id: 'timestamp',
    group: 'Dynamic values',
    title: 'Timestamp in milliseconds',
    description: 'Save the current time as a number of milliseconds.',
    places: ANYWHERE,
    code: "aw.vars.set('timestamp', String(Date.now()));",
  },
  {
    id: 'iso-date',
    group: 'Dynamic values',
    title: 'Date and time (ISO 8601)',
    description: 'Save the current time, such as 2026-01-31T12:00:00.000Z.',
    places: ANYWHERE,
    code: "aw.vars.set('now', new Date().toISOString());",
  },
  {
    id: 'uuid',
    group: 'Dynamic values',
    title: 'Random UUID',
    description: 'Save a new random UUID.',
    places: ANYWHERE,
    code: "aw.vars.set('request_id', aw.uuid());",
  },
  {
    id: 'random-number',
    group: 'Dynamic values',
    title: 'Random number',
    description: 'Save a whole number from 0 to 999.',
    places: ANYWHERE,
    code: "aw.vars.set('random_number', String(Math.floor(Math.random() * 1000)));",
  },
  {
    id: 'nonce',
    group: 'Dynamic values',
    title: 'Random nonce',
    description: 'Save 16 random bytes as hexadecimal text.',
    places: ANYWHERE,
    code: "aw.vars.set('nonce', aw.crypto.randomBytes(16, 'hex'));",
  },

  // Response tests
  {
    id: 'status-200',
    group: 'Response tests',
    title: 'Status is 200',
    description: 'Pass when the response status is exactly 200.',
    places: ['post'],
    code: "aw.test('status is 200', () => {\n  aw.expect(aw.response.status).toBe(200);\n});",
  },
  {
    id: 'status-success',
    group: 'Response tests',
    title: 'Status is a success (2xx)',
    description: 'Pass for any status from 200 to 299.',
    places: ['post'],
    code: "aw.test('status is a success', () => {\n  aw.expect(aw.response.status).toBeGreaterThanOrEqual(200);\n  aw.expect(aw.response.status).toBeLessThan(300);\n});",
  },
  {
    id: 'status-one-of',
    group: 'Response tests',
    title: 'Status is one of',
    description: 'Pass when the status is in a list.',
    places: ['post'],
    code: "aw.test('status is expected', () => {\n  aw.expect(aw.response.status).toBeOneOf([200, 201, 204]);\n});",
  },
  {
    id: 'response-time',
    group: 'Response tests',
    title: 'Response time is under a limit',
    description: 'Pass when the response took less than 500 ms.',
    places: ['post'],
    code: "aw.test('responds in under 500 ms', () => {\n  aw.expect(aw.response.time).toBeLessThan(500);\n});",
  },
  {
    id: 'header-present',
    group: 'Response tests',
    title: 'Header is present',
    description: 'Pass when the response has a header.',
    places: ['post'],
    code: "aw.test('has a request id', () => {\n  aw.expect(aw.response.headers.has('x-request-id')).toBeTruthy();\n});",
  },
  {
    id: 'content-type-json',
    group: 'Response tests',
    title: 'Content-Type is JSON',
    description: 'Pass when the response says it is JSON.',
    places: ['post'],
    code: "aw.test('returns JSON', () => {\n  aw.expect(aw.response.headers.get('content-type')).toContain('json');\n});",
  },
  {
    id: 'body-contains',
    group: 'Response tests',
    title: 'Body contains text',
    description: 'Pass when the body includes a piece of text.',
    places: ['post'],
    code: "aw.test('body mentions the id', () => {\n  aw.expect(aw.response.text()).toContain('id');\n});",
  },
  {
    id: 'json-value',
    group: 'Response tests',
    title: 'JSON value equals',
    description: 'Pass when a field in the JSON body has a value.',
    places: ['post'],
    code: "aw.test('status is active', () => {\n  aw.expect(aw.response.json().status).toBe('active');\n});",
  },
  {
    id: 'json-property',
    group: 'Response tests',
    title: 'JSON has a field',
    description: 'Pass when the body has a field, by a dotted path.',
    places: ['post'],
    code: "aw.test('has an id', () => {\n  aw.expect(aw.response.json()).toHaveProperty('id');\n});",
  },
  {
    id: 'json-types',
    group: 'Response tests',
    title: 'JSON fields have the right types',
    description: 'Check the type of each field you rely on.',
    places: ['post'],
    code: "aw.test('fields have the right types', () => {\n  const body = aw.response.json();\n  aw.expect(typeof body.id).toBe('number');\n  aw.expect(Array.isArray(body.items)).toBeTruthy();\n});",
  },
  {
    id: 'array-not-empty',
    group: 'Response tests',
    title: 'List is not empty',
    description: 'Pass when a list in the body has items.',
    places: ['post'],
    code: "aw.test('returns items', () => {\n  aw.expect(aw.response.json().items).not.toHaveLength(0);\n});",
  },
  {
    id: 'every-item',
    group: 'Response tests',
    title: 'Every item has a field',
    description: 'Check each item of a list.',
    places: ['post'],
    code: "aw.test('every item has a sku', () => {\n  for (const item of aw.response.json().items) {\n    aw.expect(item).toHaveProperty('sku');\n  }\n});",
  },
  {
    id: 'body-size',
    group: 'Response tests',
    title: 'Body is smaller than a limit',
    description: 'Pass when the response is under 100 KB.',
    places: ['post'],
    code: "aw.test('body is under 100 KB', () => {\n  aw.expect(aw.response.size).toBeLessThan(100 * 1024);\n});",
  },

  // Response values
  {
    id: 'save-json',
    group: 'Response values',
    title: 'Save a JSON value',
    description: 'Keep a value from the body for later requests.',
    places: ['post'],
    code: "aw.vars.set('order_id', aw.response.json().id);",
  },
  {
    id: 'save-header',
    group: 'Response values',
    title: 'Save a header',
    description: 'Keep a response header for later requests.',
    places: ['post'],
    code: "aw.vars.set('request_id', aw.response.headers.get('x-request-id') ?? '');",
  },
  {
    id: 'parse-safely',
    group: 'Response values',
    title: 'Read JSON safely',
    description: 'Parse the body, with an error in the console when it is not JSON.',
    places: ['post'],
    code: "let body;\ntry {\n  body = aw.response.json();\n} catch {\n  aw.error('The response is not JSON:', aw.response.text().slice(0, 200));\n}",
  },
  {
    id: 'log-response',
    group: 'Response values',
    title: 'Log the response',
    description: 'Write the status and body to the console.',
    places: ['post'],
    code: 'aw.log(aw.response.status, aw.response.text());',
  },

  // Crypto and encoding
  {
    id: 'hmac-body',
    group: 'Crypto and encoding',
    title: 'Sign the body with HMAC',
    description: 'Add an HMAC-SHA256 signature of the body as a header.',
    places: ['pre'],
    code: "const signature = aw.crypto.hmac('sha256', aw.vars.get('signing_key') ?? '', aw.request.body, 'hex');\naw.request.headers.set('X-Signature', signature);",
  },
  {
    id: 'sha256',
    group: 'Crypto and encoding',
    title: 'SHA-256 hash',
    description: 'Hash text, as hexadecimal.',
    places: ANYWHERE,
    code: "const digest = aw.crypto.sha256('text to hash');",
  },
  {
    id: 'hash',
    group: 'Crypto and encoding',
    title: 'Other hashes',
    description: 'SHA-1, SHA-512, MD5, and the others Node.js supports.',
    places: ANYWHERE,
    code: "const digest = aw.crypto.hash('sha512', 'text to hash', 'base64');",
  },
  {
    id: 'base64',
    group: 'Crypto and encoding',
    title: 'Base64 encode and decode',
    description: 'Encode UTF-8 text as Base64, and back.',
    places: ANYWHERE,
    code: "const encoded = aw.base64.encode('text');\nconst decoded = aw.base64.decode(encoded);",
  },
  {
    id: 'jwt-claims',
    group: 'Crypto and encoding',
    title: "Read a JWT's claims",
    description: 'Decode the payload of a token in a variable, without checking it.',
    places: ANYWHERE,
    code: "const [, payload = ''] = (aw.vars.get('token') ?? '').split('.');\nconst claims = payload ? JSON.parse(aw.base64.decode(payload.replace(/-/g, '+').replace(/_/g, '/'))) : {};\naw.log(claims);",
  },

  // Logging
  {
    id: 'log',
    group: 'Logging',
    title: 'Log a message',
    description: 'Write values to the console; objects are written as JSON.',
    places: ANYWHERE,
    code: "aw.log('message', { value: 1 });",
  },
  {
    id: 'warn-slow',
    group: 'Logging',
    title: 'Warn about a slow response',
    description: 'Write a warning when the response took over a second.',
    places: ['post'],
    code: "if (aw.response.time > 1000) aw.warn('Slow response:', aw.response.time, 'ms');",
  },
  {
    id: 'error-failed',
    group: 'Logging',
    title: 'Log a failed status',
    description: 'Write an error with the body when the status is 400 or above.',
    places: ['post'],
    code: "if (aw.response.status >= 400) {\n  aw.error('Request failed with', aw.response.status, aw.response.text());\n}",
  },

  // Library
  {
    id: 'require-module',
    group: 'Library',
    title: 'Use a library module',
    description: 'Load the functions a module exports.',
    places: ANYWHERE,
    code: "const helpers = aw.require('helpers');",
  },
  {
    id: 'export-function',
    group: 'Library',
    title: 'Export a function',
    description: 'Share a function with every script that requires this module.',
    places: ['module'],
    code: 'exports.functionName = (value) => {\n  return value;\n};',
  },
  {
    id: 'export-checks',
    group: 'Library',
    title: 'Export shared checks',
    description: 'A function that adds the same tests to any response.',
    places: ['module'],
    code: "exports.checkJSON = () => {\n  aw.test('returns JSON', () => {\n    aw.expect(aw.response.headers.get('content-type')).toContain('json');\n  });\n};",
  },
];

/**
 * The snippets for a place — the workspace's own first, then the built-in ones — matching every
 * word of a search in their title, description, or group.
 */
export function snippetsFor(
  place: SnippetPlace,
  query = '',
  custom: readonly UserSnippet[] = [],
): ScriptSnippet[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const saved: ScriptSnippet[] = custom.map((snippet) => ({
    id: snippet.id,
    group: CUSTOM_GROUP,
    title: snippet.title,
    description: snippet.description ?? '',
    places: snippet.places,
    code: snippet.code,
    custom: true,
  }));
  return [...saved, ...SCRIPT_SNIPPETS].filter(
    (snippet) =>
      snippet.places.includes(place) &&
      words.every((word) =>
        `${snippet.title} ${snippet.description} ${snippet.group}`.toLowerCase().includes(word),
      ),
  );
}

/**
 * The text to insert at a point in a script: on a line of its own, so it never joins the code
 * around it, and followed by a line break.
 */
export function snippetInsertion(text: string, at: number, code: string): string {
  const before = text.slice(0, at);
  const lineStart = before.lastIndexOf('\n') + 1;
  const prefix = before.slice(lineStart).trim() ? '\n' : '';
  return `${prefix}${code}\n`;
}
