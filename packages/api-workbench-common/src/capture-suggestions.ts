import { FORMAT_CHECKS, LIST_CHECKS, LIST_OPERATORS, TEXT_OPERATORS } from './assertions';

// Captures suggested from what is clicked or selected in a response body.

type Segment = string | number;

/** A JSON path for keys and indexes, such as `$.data.items[0]["first name"]`. */
export function formatJSONPath(segments: readonly Segment[]): string {
  return (
    '$' +
    segments
      .map((segment) =>
        typeof segment === 'number'
          ? `[${segment}]`
          : /^[A-Za-z_$@#][\w$-]*$/.test(segment)
            ? `.${segment}`
            : `[${JSON.stringify(segment)}]`,
      )
      .join('')
  );
}

interface Located {
  path: Segment[];
  start: number;
  end: number;
}

/** Deeper than any real API's JSON; a body nested further gets no suggested path. */
export const MAX_JSON_DEPTH = 512;

/**
 * The path of the innermost JSON value that holds `from`–`to` in `text`; a click on a property's
 * key or colon belongs to its value, and space outside every value to the whole document (`$`).
 * Undefined when the text is not JSON, or is nested deeper than `MAX_JSON_DEPTH`.
 */
export function jsonPathAt(text: string, from: number, to = from): string | undefined {
  const found: Located[] = [];
  let index = 0;
  const space = () => {
    while (index < text.length && /\s/.test(text[index])) index++;
  };
  const fail = (): never => {
    throw new SyntaxError('Not JSON');
  };
  const string = (): string => {
    const start = index;
    index++;
    while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    if (index >= text.length) fail();
    index++;
    return JSON.parse(text.slice(start, index)) as string;
  };
  // Each value records its span; a property also spans its key, so a click there selects it.
  const value = (path: Segment[], spanStart: number): void => {
    // Each level copies its path, so memory grows with the square of the depth: a response of a
    // few thousand `[` would otherwise exhaust the window's memory when clicked.
    if (path.length > MAX_JSON_DEPTH) fail();
    space();
    const start = index;
    const char = text[index];
    if (char === '{') {
      index++;
      space();
      if (text[index] === '}') index++;
      else
        for (;;) {
          space();
          const keyStart = index;
          if (text[index] !== '"') fail();
          const key = string();
          space();
          if (text[index] !== ':') fail();
          index++;
          value([...path, key], keyStart);
          space();
          if (text[index] === ',') index++;
          else if (text[index] === '}') {
            index++;
            break;
          } else fail();
        }
    } else if (char === '[') {
      index++;
      space();
      if (text[index] === ']') index++;
      else
        for (let item = 0; ; item++) {
          value([...path, item], -1);
          space();
          if (text[index] === ',') index++;
          else if (text[index] === ']') {
            index++;
            break;
          } else fail();
        }
    } else if (char === '"') string();
    else {
      const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        text.slice(index, index + 400),
      );
      if (!literal) fail();
      index += literal![0].length;
    }
    found.push({ path, start: spanStart >= 0 ? spanStart : start, end: index });
  };
  try {
    value([], -1);
    space();
    if (index !== text.length) return undefined;
  } catch {
    return undefined;
  }
  // The innermost value is the shortest span that holds the click or selection.
  const holding = found
    .filter((item) => item.start <= from && to <= item.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  // Space around the document belongs to the whole document.
  return holding.length ? formatJSONPath(holding[0].path) : '$';
}

/**
 * A `between "start" "end"` capture that reads `body[from, to)` from the body: the shortest
 * markers before and after it whose first occurrences find exactly that text. Undefined when no
 * markers up to 40 characters do.
 */
export function betweenCaptureFor(body: string, from: number, to: number): string | undefined {
  if (from >= to || from <= 0 || to > body.length) return undefined;
  for (let size = 1; size <= Math.min(40, from); size++) {
    const start = body.slice(from - size, from);
    // The first occurrence of the start marker must be this one.
    if (body.indexOf(start) !== from - size) continue;
    for (let after = 1; after <= Math.min(40, body.length - to); after++) {
      const end = body.slice(to, to + after);
      if (body.indexOf(end, from) === to)
        return `between ${JSON.stringify(start)} ${JSON.stringify(end)}`;
    }
    return undefined;
  }
  return undefined;
}

/**
 * A variable name for a capture: the last key of a JSON path, or `fallback`, as snake_case,
 * numbered when the name is taken.
 */
export function captureVariableName(
  path: string | undefined,
  taken: readonly string[],
  fallback = 'value',
): string {
  const key = path?.match(/(?:\.([A-Za-z_$@#][\w$-]*)|\["((?:[^"\\]|\\.)*)"\])(?:\[\d+\])*$/);
  const base =
    (key?.[1] ?? (key?.[2] !== undefined ? (JSON.parse(`"${key[2]}"`) as string) : fallback))
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback;
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let number = 2;
  while (names.has(`${base}_${number}`)) number++;
  return `${base}_${number}`;
}

/**
 * The path of the value on a line (1-based) of JSON text, as shown in a diff: from the line's
 * first character that is not a space, so a key's line names its value.
 */
export function jsonPathAtLine(text: string, line: number): string | undefined {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const start = lines.slice(0, line - 1).reduce((offset, item) => offset + item.length + 1, 0);
  const indent = lines[line - 1].length - lines[line - 1].trimStart().length;
  return jsonPathAt(text, start + indent);
}

/** The comparisons of a `json` assertion, longest first so none is read as a shorter one. */
const JSON_OPERATORS = [
  ...TEXT_OPERATORS,
  ...LIST_OPERATORS,
  'not-in',
  'in',
  'between',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '=',
]
  .sort((a, b) => b.length - a.length)
  .join('|');
/** A JSON path as captures write it, starting at `$`; tests may leave the `$` out. */
const capturePath = (path: string) =>
  path.startsWith('$') ? path : path.startsWith('[') ? `$${path}` : `$.${path}`;

/**
 * The capture that reads the value a test assertion checks, such as `$.id` for
 * `json $.id equals 7` or `header etag` for `header etag matches /…/`, with the JSON path it is
 * named after or a variable name. Undefined for checks with no single value (`json-valid`).
 */
export function captureSourceForAssertion(
  assertion: string,
): { source: string; path?: string; name?: string } | undefined {
  const text = assertion.trim();
  let match: RegExpMatchArray | null;
  if (/^status\b/.test(text)) return { source: 'status', name: 'status' };
  if (/^response-time\b/.test(text)) return { source: 'time', name: 'time_ms' };
  if (/^response-size\b/.test(text)) return { source: 'size', name: 'size_bytes' };
  if (/^body-length\b/.test(text)) return { source: 'body | length', name: 'body_length' };
  if (/^content-type\b/.test(text)) return { source: 'header content-type', name: 'content_type' };
  if ((match = text.match(/^timing\s+(\S+)/)))
    return { source: `timing ${match[1]}`, name: `${match[1]}_ms` };
  if (/^certificate-days-left\b/.test(text))
    return { source: 'certificate days-left', name: 'certificate_days_left' };
  if ((match = text.match(/^cookie(?:-exists|-not-exists)?\s+(\S+)/)))
    return { source: `cookie ${JSON.stringify(match[1])}`, name: match[1] };
  if ((match = text.match(/^header(?:-exists|-not-exists)?\s+(\S+)/)))
    return { source: `header ${match[1]}`, name: match[1] };
  if (/^body(?:-|\s)/.test(text)) return { source: 'body', name: 'body' };
  if ((match = text.match(/^json-schema(?:\s+(\$\S*))?\s+\{/))) {
    const path = match[1] || '$';
    return { source: path, path };
  }
  if ((match = text.match(/^json-length\s+(.+?)\s+(?:==|!=|<=|>=|<|>|=|between)\s/))) {
    const path = capturePath(match[1]);
    return { source: `${path} | length`, path };
  }
  if (
    (match =
      text.match(/^json-(?:exists|not-exists)\s+(.+)$/) ??
      text.match(/^json-type\s+(.+)\s+\w+$/) ??
      text.match(new RegExp(`^json\\s+(.+?)\\s+(?:${JSON_OPERATORS})\\s`)) ??
      text.match(
        new RegExp(`^json\\s+(.+?)\\s+(?:${[...FORMAT_CHECKS, ...LIST_CHECKS].join('|')})$`),
      ))
  ) {
    const path = capturePath(match[1]);
    return { source: path, path };
  }
  return undefined;
}
