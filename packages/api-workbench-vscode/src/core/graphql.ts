import { jsonTokens } from './views';

/**
 * GraphQL over HTTP, as the app keeps it: a POST whose raw JSON body is `{"query", "variables",
 * "operationName"}`. The request editor shows such a body as a query and its variables; these
 * helpers read and write that body. They only parse text, never run it.
 */

export interface GraphqlParts {
  query: string;
  /** The variables as typed: JSON text, empty for none. */
  variables: string;
  operationName: string;
}

/** The query, variables, and operation of a GraphQL body, or nothing when it is not one. */
export function graphqlParts(body: string): GraphqlParts | undefined {
  if (!body.trim().startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const given = value as Record<string, unknown>;
  if (typeof given.query !== 'string') return undefined;
  // Only these keys: a JSON body that happens to have a `query` field among others is not GraphQL.
  if (Object.keys(given).some((key) => !['query', 'variables', 'operationName'].includes(key)))
    return undefined;
  const variables = given.variables;
  if (variables !== undefined && variables !== null && typeof variables !== 'object')
    return undefined;
  return {
    query: given.query,
    variables: variables && Object.keys(variables).length ? JSON.stringify(variables, null, 2) : '',
    operationName: typeof given.operationName === 'string' ? given.operationName : '',
  };
}

/**
 * The body for a query and its variables, or the reason the variables cannot be sent. Variables
 * may hold `{{environment}}` values inside strings, which stay as typed until it is sent.
 */
export function graphqlBody(parts: GraphqlParts): { body: string } | { error: string } {
  let variables: unknown = {};
  if (parts.variables.trim()) {
    try {
      variables = JSON.parse(parts.variables);
    } catch (error) {
      return { error: `The variables are not JSON: ${(error as Error).message}` };
    }
    if (!variables || typeof variables !== 'object' || Array.isArray(variables))
      return { error: 'The variables are a JSON object, such as {"id": 1}.' };
  }
  return {
    body: JSON.stringify(
      {
        query: parts.query,
        variables,
        ...(parts.operationName.trim() ? { operationName: parts.operationName.trim() } : {}),
      },
      null,
      2,
    ),
  };
}

/** The body a new GraphQL request starts with. */
export const GRAPHQL_STARTER = graphqlBody({
  query: 'query {\n  __typename\n}\n',
  variables: '',
  operationName: '',
}) as { body: string };

/** The named operations in a document: `query Orders`, `mutation AddOrder`, … */
export function graphqlOperations(query: string): { kind: string; name: string }[] {
  const operations: { kind: string; name: string }[] = [];
  for (const match of stripped(query).matchAll(
    /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/g,
  ))
    operations.push({ kind: match[1], name: match[2] });
  return operations;
}

/** The query without its strings and comments, so their text is never read as syntax. */
function stripped(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

/**
 * A likely mistake in a query — an unclosed or extra bracket, or a document with several named
 * operations and none chosen — or nothing. The server checks the rest.
 */
export function graphqlProblem(query: string, operationName = ''): string | undefined {
  const text = stripped(query);
  if (!text.trim()) return 'Write the query, such as { orders { id } }.';
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  const open: { char: string; line: number }[] = [];
  let line = 1;
  for (const char of text) {
    if (char === '\n') line++;
    else if (char === '{' || char === '(' || char === '[') open.push({ char, line });
    else if (pairs[char]) {
      const last = open.pop();
      if (!last || last.char !== pairs[char])
        return `Line ${line}: “${char}” closes ${last ? `the “${last.char}” on line ${last.line}` : 'nothing'}.`;
    }
  }
  const unclosed = open.pop();
  if (unclosed) return `Line ${unclosed.line}: “${unclosed.char}” is never closed.`;
  const operations = graphqlOperations(query);
  if (operations.length > 1 && !operationName.trim())
    return `It has ${operations.length} operations: choose which to run.`;
  if (operationName.trim() && !operations.some((item) => item.name === operationName.trim()))
    return `No operation is named “${operationName.trim()}”.`;
  return undefined;
}

/**
 * The GraphQL errors a response reports, as their messages: a server answers 200 OK with an
 * `errors` list when a query fails, so the status alone does not say so.
 */
export function graphqlErrors(body: string): string[] {
  if (!body.trim().startsWith('{')) return [];
  try {
    const value = JSON.parse(body) as { errors?: unknown };
    // A GraphQL response has only data, errors, and extensions; other APIs' `errors` are theirs.
    if (!Array.isArray(value?.errors)) return [];
    if (Object.keys(value).some((key) => !['data', 'errors', 'extensions'].includes(key)))
      return [];
    return value.errors.map((error) =>
      error &&
      typeof error === 'object' &&
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'An error without a message',
    );
  } catch {
    return [];
  }
}

export type GraphqlTokenKind =
  | 'keyword'
  | 'operation'
  | 'type'
  | 'field'
  | 'property'
  | 'variable'
  | 'directive'
  | 'string'
  | 'number'
  | 'constant'
  | 'comment'
  | 'punctuation';

/**
 * A query split into the pieces the Query editor colours, in order: joined, they are the query
 * exactly (spaces and anything unrecognized have no kind). It reads the text once, left to right,
 * and knows only enough context to tell a type (`$id: ID!`, `on Order`) from a value
 * (`status: OPEN`) and a field from an argument or alias (`first:`).
 */
export function graphqlTokens(query: string): { text: string; kind?: GraphqlTokenKind }[] {
  const tokens: { text: string; kind?: GraphqlTokenKind }[] = [];
  const pattern =
    /("""[\s\S]*?(?:"""|$))|("(?:[^"\\\n]|\\.)*(?:"|$))|(#[^\n]*)|(\$[_A-Za-z][_0-9A-Za-z]*)|(@[_A-Za-z][_0-9A-Za-z]*)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([_A-Za-z][_0-9A-Za-z]*)|(\.\.\.|[{}()[\]:!=,|&])|(\s+)|([\s\S])/gy;
  let braces = 0;
  let parens = 0;
  // Where the parentheses opened: an operation's variable definitions, or a field's arguments.
  let variablesOpen = false;
  let previous = '';
  let expectName: 'operation' | 'type' | undefined;
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    const text = match[0];
    const push = (kind?: GraphqlTokenKind) => tokens.push(kind ? { text, kind } : { text });
    if (match[1] || match[2]) push('string');
    else if (match[3]) push('comment');
    else if (match[4]) push('variable');
    else if (match[5]) push('directive');
    else if (match[6]) push('number');
    else if (match[7]) {
      const rest = query.slice(pattern.lastIndex);
      if (expectName) {
        push(expectName);
        expectName = undefined;
      } else if (
        braces === 0 &&
        parens === 0 &&
        ['query', 'mutation', 'subscription', 'fragment'].includes(text)
      ) {
        push('keyword');
        expectName = 'operation';
      } else if (text === 'on' && (previous === '...' || previous === 'operation-name')) {
        push('keyword');
        expectName = 'type';
      } else if (text === 'true' || text === 'false' || text === 'null') push('constant');
      else if (parens > 0 && variablesOpen && (previous === ':' || previous === '[')) push('type');
      else if (parens > 0 && (previous === ':' || previous === '[')) push('constant');
      else if (/^\s*:/.test(rest)) push('property');
      else if (braces === 0 && parens === 0 && previous === 'operation-name') push('keyword');
      else if (braces > 0 && parens === 0) push('field');
      else push();
      previous = tokens[tokens.length - 1].kind === 'operation' ? 'operation-name' : text;
      continue;
    } else if (match[8]) {
      push('punctuation');
      if (text === '{') braces++;
      else if (text === '}') braces = Math.max(0, braces - 1);
      else if (text === '(') {
        if (parens === 0) variablesOpen = braces === 0;
        parens++;
      } else if (text === ')') parens = Math.max(0, parens - 1);
      // After `...`, a name is a fragment spread unless it is `on`.
      if (text === '{' || text === '(') expectName = undefined;
    } else push();
    if (!match[9]) previous = text;
  }
  return tokens;
}

/**
 * The Variables (JSON) editor's coloured pieces, in the Query's kinds so both read alike: keys,
 * strings, numbers, `true`/`false`/`null`, and `{{environment}}` values inside strings, which
 * are filled in when the request is sent. Joined, they are the text exactly.
 */
export function variablesTokens(text: string): { text: string; kind?: GraphqlTokenKind }[] {
  const kinds = {
    key: 'property',
    string: 'string',
    number: 'number',
    literal: 'constant',
    punctuation: 'punctuation',
  } as const;
  return jsonTokens(text).flatMap((token) => {
    const kind = kinds[token.kind];
    if (token.kind !== 'string' && token.kind !== 'key') return [{ text: token.text, kind }];
    return token.text
      .split(/(\{\{[^{}\n]*\}\})/)
      .filter(Boolean)
      .map((part) => ({ text: part, kind: /^\{\{/.test(part) ? 'variable' : kind }));
  });
}

/** An unclosed or extra bracket, outside strings and comments, or nothing. */
function bracketProblem(query: string): string | undefined {
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  const open: { char: string; line: number }[] = [];
  let line = 1;
  for (const token of graphqlTokens(query)) {
    if (token.kind === 'string' || token.kind === 'comment') {
      line += token.text.split('\n').length - 1;
      continue;
    }
    for (const char of token.text) {
      if (char === '\n') line++;
      else if (char === '{' || char === '(' || char === '[') open.push({ char, line });
      else if (pairs[char]) {
        const last = open.pop();
        if (!last || last.char !== pairs[char])
          return `Line ${line}: “${char}” closes ${last ? `the “${last.char}” on line ${last.line}` : 'nothing'}.`;
      }
    }
  }
  const unclosed = open.pop();
  return unclosed ? `Line ${unclosed.line}: “${unclosed.char}” is never closed.` : undefined;
}

/**
 * A query laid out as GraphQL is usually written: two spaces a level, one field a line,
 * arguments and variable definitions on the field's line, a blank line between definitions, and
 * comments on lines of their own. Strings and names stay exactly as written; commas between
 * fields, which GraphQL ignores, are dropped. A query with unbalanced brackets is not guessed at.
 */
export function formatGraphql(query: string): { text: string } | { error: string } {
  if (!query.trim()) return { text: '' };
  const problem = bracketProblem(query);
  if (problem) return { error: `${problem} Fix it, then format.` };
  const tokens = graphqlTokens(query).filter((token) => token.text.trim());
  const lines: string[] = [];
  let line = '';
  let depth = 0;
  let parens = 0;
  let previous = '';
  let blank = false;
  const indent = () => '  '.repeat(depth);
  const newLine = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = '';
  };
  const write = (text: string, space: boolean) => {
    if (!line) {
      if (blank && lines.length) lines.push('');
      blank = false;
      line = indent() + text;
    } else
      line += (space && !/[([]$/.test(line) && !/\($|[(:,]\s*\{$/.test(line) ? ' ' : '') + text;
  };
  for (const token of tokens) {
    const { text } = token;
    const nameLike = !token.kind || !['punctuation', 'comment'].includes(token.kind);
    if (token.kind === 'comment') {
      // Comments go on lines of their own, where nothing after them can become part of them.
      newLine();
      write(text, false);
      newLine();
      previous = '#';
      continue;
    }
    if (text === '{' && parens > 0) {
      // An input object in arguments, `{x: 1}`, stays on the field's line.
      write('{', true);
    } else if (text === '}' && parens > 0) {
      line = line.replace(/\s+$/, '') + '}';
    } else if (text === '{') {
      write('{', true);
      depth++;
      newLine();
    } else if (text === '}') {
      newLine();
      depth = Math.max(0, depth - 1);
      write('}', false);
      newLine();
      if (depth === 0) blank = true;
    } else if (text === '(') {
      line += '(';
      parens++;
    } else if (text === ')') {
      line = line.replace(/,?\s*$/, '') + ')';
      parens = Math.max(0, parens - 1);
    } else if (text === '[') write('[', true);
    else if (text === ']' || text === '!') line = line.replace(/\s+$/, '') + text;
    else if (text === ':') line = line.replace(/\s+$/, '') + ':';
    else if (text === ',') {
      if (parens > 0) line = line.replace(/\s+$/, '') + ',';
    } else if (text === '=') write('=', true);
    else if (text === '|' || text === '&') write(text, true);
    else if (text === '...') {
      if (depth > 0 && parens === 0) newLine();
      write('...', true);
    } else if (nameLike) {
      // In a selection set, a field begins a line unless it follows an alias, `...`, or `on`.
      const startsField =
        depth > 0 &&
        parens === 0 &&
        token.kind !== 'directive' &&
        previous !== ':' &&
        previous !== '...' &&
        previous !== 'on' &&
        !(previous === '' && line);
      if (startsField) newLine();
      // `...Fragment` is one word; `... on Type` is not.
      write(text, (previous !== '...' || text === 'on') && previous !== '[');
    } else write(text, true);
    previous = text;
  }
  newLine();
  return { text: `${lines.join('\n')}\n` };
}
