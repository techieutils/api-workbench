import {
  FORMAT_CHECKS,
  LIST_CHECKS,
  LIST_OPERATORS,
  TEXT_OPERATORS,
  regexArgument,
  validatePath,
} from './assertions';
import { TIMING_PHASES } from './response-values';
export type RuleKind =
  | 'status'
  | 'response-time'
  | 'response-size'
  | 'header'
  | 'content-type'
  | 'body'
  | 'body-length'
  | 'json-valid'
  | 'json-field'
  | 'json'
  | 'json-type'
  | 'json-length'
  | 'json-schema'
  | 'cookie'
  | 'timing'
  | 'certificate-days-left'
  | 'custom';
export interface TestRule {
  kind: RuleKind;
  operator: string;
  target: string;
  value: string;
  valueType: string;
  secondValue: string;
}
export interface DesignedCase {
  name: string;
  enabled: boolean;
  assertion: string;
  rule: TestRule;
  line: number;
  start: number;
}
export const ruleKinds: { id: RuleKind; label: string }[] = [
  { id: 'status', label: 'Status code' },
  { id: 'response-time', label: 'Response time (ms)' },
  { id: 'response-size', label: 'Response size (bytes)' },
  { id: 'header', label: 'Response header' },
  { id: 'content-type', label: 'Content type' },
  { id: 'body', label: 'Response body' },
  { id: 'body-length', label: 'Body length (characters)' },
  { id: 'json-valid', label: 'Valid JSON' },
  { id: 'json-field', label: 'JSON field presence' },
  { id: 'json', label: 'JSON value' },
  { id: 'json-type', label: 'JSON value type' },
  { id: 'json-length', label: 'JSON length' },
  { id: 'json-schema', label: 'JSON Schema' },
  { id: 'cookie', label: 'Response cookie' },
  { id: 'timing', label: 'Network timing (ms)' },
  { id: 'certificate-days-left', label: 'Certificate days left' },
  { id: 'custom', label: 'Custom assertion' },
];
const numeric = ['equals', 'not-equals', '<', '<=', '>', '>='];
const text: string[] = [...TEXT_OPERATORS];
/** Network timings a `timing` check reads. */
export const TIMING_TARGETS = ['total', 'ttfb', 'preparation', ...TIMING_PHASES] as const;
/** Comparisons with nothing to enter: a value's form, or an array's order and repeats. */
export const VALUELESS_OPERATORS: readonly string[] = [...FORMAT_CHECKS, ...LIST_CHECKS];
const formats: string[] = [...FORMAT_CHECKS];
/** Comparisons whose expected value is a number (or, for between, two). */
export const NUMERIC_OPERATORS = ['<', '<=', '>', '>=', 'between'];
export function operators(kind: RuleKind): string[] {
  if (kind === 'status') return [...numeric, 'between', 'in', 'not-in'];
  if (
    [
      'response-time',
      'response-size',
      'json-length',
      'body-length',
      'timing',
      'certificate-days-left',
    ].includes(kind)
  )
    return [...numeric, 'between'];
  if (kind === 'header' || kind === 'cookie') return ['exists', 'not-exists', ...text, ...formats];
  if (kind === 'body') return [...text, 'empty', 'not-empty'];
  if (kind === 'json-field') return ['exists', 'not-exists'];
  if (kind === 'json')
    return [
      ...numeric,
      'between',
      'in',
      'not-in',
      ...text.filter((operator) => !['equals', 'not-equals'].includes(operator)),
      ...LIST_OPERATORS,
      ...formats,
      ...LIST_CHECKS,
    ];
  return [];
}
export function defaultRule(kind: RuleKind = 'status'): TestRule {
  return {
    kind,
    operator: operators(kind)[0] || '',
    target:
      kind === 'header'
        ? 'content-type'
        : kind === 'cookie'
          ? 'session'
          : kind === 'timing'
            ? 'ttfb'
            : kind === 'json-schema'
              ? '$'
              : '$.id',
    value:
      kind === 'status'
        ? '200'
        : kind === 'response-time'
          ? '3000'
          : kind === 'response-size'
            ? '1048576'
            : kind === 'timing'
              ? '500'
              : kind === 'certificate-days-left'
                ? '30'
                : kind === 'json-length' || kind === 'body-length'
                  ? '0'
                  : kind === 'content-type'
                    ? 'application/json'
                    : kind === 'json-type'
                      ? 'string'
                      : kind === 'json'
                        ? '1'
                        : kind === 'json-schema'
                          ? '{\n  "type": "object",\n  "required": ["id"]\n}'
                          : '',
    valueType: kind === 'json' ? 'number' : 'string',
    secondValue: '299',
    ...(kind === 'response-time' ? { operator: '<' } : {}),
    ...(kind === 'body-length' || kind === 'certificate-days-left' ? { operator: '>' } : {}),
    ...(kind === 'timing' ? { operator: '<' } : {}),
  };
}
function plain(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}
function comparisonName(operator: string): string {
  return operator === '==' || operator === '='
    ? 'equals'
    : operator === '!='
      ? 'not-equals'
      : operator;
}
const TEXT_PATTERN = [...TEXT_OPERATORS].sort((a, b) => b.length - a.length).join('|');
/** The value a text comparison is edited as: a regular expression keeps its /slashes/flags. */
function textValue(operator: string, source: string): string {
  return operator === 'matches' || operator === 'not-matches'
    ? source.startsWith('"')
      ? plain(source)
      : source
    : plain(source);
}
/** A regular expression as written in an assertion: `/pattern/flags`, checked to compile. */
function regexLiteral(value: string): string {
  const literal = /^\/.+\/[a-z]*$/s.test(value.trim()) ? value.trim() : `/${value}/`;
  if (!value.trim()) throw new Error('Enter a regular expression.');
  regexArgument(literal);
  return literal;
}
/** A text comparison's argument: a regular expression literal, or the text as a JSON string. */
function textArgumentFor(operator: string, value: string): string {
  return operator === 'matches' || operator === 'not-matches'
    ? regexLiteral(value)
    : JSON.stringify(value);
}
/** The values of an `in` list, written comma separated: JSON values, or plain text. */
function listValues(value: string): unknown[] {
  if (!value.trim()) throw new Error('Enter at least one value.');
  try {
    const list: unknown = JSON.parse(`[${value}]`);
    if (Array.isArray(list)) return list;
  } catch {
    /* Plain text values follow. */
  }
  return value.split(',').map((item) => item.trim());
}
const FORMAT_ALTERNATIVES = [...FORMAT_CHECKS].sort((a, b) => b.length - a.length).join('|');
const LIST_CHECK_ALTERNATIVES = [...LIST_CHECKS].sort((a, b) => b.length - a.length).join('|');
export function ruleFromAssertion(source: string): TestRule {
  const value = source.trim();
  let match: RegExpMatchArray | null;
  if ((match = value.match(/^(timing (\S+)|certificate-days-left) (==|=|!=|<=|>=|<|>) (\S+)$/)))
    return {
      ...defaultRule(match[2] ? 'timing' : 'certificate-days-left'),
      ...(match[2] ? { target: match[2] } : {}),
      operator: comparisonName(match[3]),
      value: match[4],
    };
  if ((match = value.match(/^(timing (\S+)|certificate-days-left) between (\S+) (\S+)$/)))
    return {
      ...defaultRule(match[2] ? 'timing' : 'certificate-days-left'),
      ...(match[2] ? { target: match[2] } : {}),
      operator: 'between',
      value: match[3],
      secondValue: match[4],
    };
  if ((match = value.match(/^cookie-(exists|not-exists) (\S+)$/)))
    return { ...defaultRule('cookie'), operator: match[1], target: match[2] };
  if ((match = value.match(new RegExp(`^(header|cookie) (\\S+) (${FORMAT_ALTERNATIVES})$`))))
    return {
      ...defaultRule(match[1] as RuleKind),
      target: match[2],
      operator: match[3],
      value: '',
    };
  if ((match = value.match(new RegExp(`^cookie (\\S+) (${TEXT_PATTERN}) (.+)$`))))
    return {
      ...defaultRule('cookie'),
      target: match[1],
      operator: match[2],
      value: textValue(match[2], match[3]),
    };
  if (
    (match = value.match(
      new RegExp(`^json (.+?) (${FORMAT_ALTERNATIVES}|${LIST_CHECK_ALTERNATIVES})$`),
    ))
  )
    return {
      ...defaultRule('json'),
      target: match[1],
      operator: match[2],
      valueType: 'string',
      value: '',
    };
  if ((match = value.match(/^json (.+?) (contains-all|contains-any) (\[.*\])$/))) {
    try {
      const list: unknown = JSON.parse(match[3]);
      if (!Array.isArray(list)) throw new Error('Not a list.');
      return {
        ...defaultRule('json'),
        target: match[1],
        operator: match[2],
        valueType: 'string',
        value: list.map((item) => JSON.stringify(item)).join(', '),
      };
    } catch {
      return { ...defaultRule('custom'), value: source };
    }
  }
  if ((match = value.match(/^status (\d{3})$/))) return { ...defaultRule(), value: match[1] };
  if ((match = value.match(/^status between (\d{3}) (\d{3})$/)))
    return { ...defaultRule(), operator: 'between', value: match[1], secondValue: match[2] };
  if ((match = value.match(/^status (in|not-in) (.+)$/)))
    return { ...defaultRule(), operator: match[1], value: match[2] };
  if (
    (match = value.match(
      /^(status|response-time|response-size|body-length) (==|=|!=|<=|>=|<|>) (\S+)$/,
    ))
  )
    return {
      ...defaultRule(match[1] as RuleKind),
      operator: comparisonName(match[2]),
      value: match[3],
    };
  if ((match = value.match(/^(response-time|response-size|body-length) between (\S+) (\S+)$/)))
    return {
      ...defaultRule(match[1] as RuleKind),
      operator: 'between',
      value: match[2],
      secondValue: match[3],
    };
  if ((match = value.match(/^(header-exists|header-not-exists) (\S+)$/)))
    return {
      ...defaultRule('header'),
      operator: match[1] === 'header-exists' ? 'exists' : 'not-exists',
      target: match[2],
    };
  if ((match = value.match(new RegExp(`^header (\\S+) (${TEXT_PATTERN}) (.+)$`))))
    return {
      ...defaultRule('header'),
      target: match[1],
      operator: match[2],
      value: textValue(match[2], match[3]),
    };
  if ((match = value.match(/^content-type (\S+)$/)))
    return { ...defaultRule('content-type'), value: match[1] };
  if ((match = value.match(/^body-(contains|not-contains|equals) (.+)$/)))
    return { ...defaultRule('body'), operator: match[1], value: plain(match[2]) };
  if ((match = value.match(new RegExp(`^body (${TEXT_PATTERN}) (.+)$`))))
    return { ...defaultRule('body'), operator: match[1], value: textValue(match[1], match[2]) };
  if ((match = value.match(/^json-schema(?: (\$\S*))? (\{.*\})$/))) {
    try {
      const schema: unknown = JSON.parse(match[2]);
      return {
        ...defaultRule('json-schema'),
        target: match[1] || '$',
        value: JSON.stringify(schema, null, 2),
      };
    } catch {
      return { ...defaultRule('custom'), value: source };
    }
  }
  if (value === 'body-empty' || value === 'body-not-empty')
    return { ...defaultRule('body'), operator: value.slice(5) };
  if (value === 'json-valid') return defaultRule('json-valid');
  if ((match = value.match(/^(json-exists|json-not-exists) (.+)$/)))
    return {
      ...defaultRule('json-field'),
      operator: match[1] === 'json-exists' ? 'exists' : 'not-exists',
      target: match[2],
    };
  if ((match = value.match(/^json-type (.+) (object|array|string|number|integer|boolean|null)$/)))
    return { ...defaultRule('json-type'), target: match[1], value: match[2] };
  if ((match = value.match(/^json-length (.+?) (==|=|!=|<=|>=|<|>) (\S+)$/)))
    return {
      ...defaultRule('json-length'),
      target: match[1],
      operator: comparisonName(match[2]),
      value: match[3],
    };
  if ((match = value.match(/^json-length (.+?) between (\S+) (\S+)$/)))
    return {
      ...defaultRule('json-length'),
      target: match[1],
      operator: 'between',
      value: match[2],
      secondValue: match[3],
    };
  if ((match = value.match(/^json (.+?) between (\S+) (\S+)$/)))
    return {
      ...defaultRule('json'),
      target: match[1],
      operator: 'between',
      value: match[2],
      secondValue: match[3],
    };
  if ((match = value.match(/^json (.+?) (in|not-in) (\[.*\])$/))) {
    try {
      const list: unknown = JSON.parse(match[3]);
      if (!Array.isArray(list)) throw new Error('Not a list.');
      return {
        ...defaultRule('json'),
        target: match[1],
        operator: match[2],
        valueType: 'string',
        value: list.map((item) => JSON.stringify(item)).join(', '),
      };
    } catch {
      return { ...defaultRule('custom'), value: source };
    }
  }
  if (
    (match = value.match(
      new RegExp(
        `^json (.+?) (${TEXT_OPERATORS.filter((operator) => !['equals', 'not-equals'].includes(operator)).join('|')}) (.+)$`,
      ),
    )) &&
    !/^contains$|^not-contains$/.test(match[2])
  )
    return {
      ...defaultRule('json'),
      target: match[1],
      operator: match[2],
      valueType: 'string',
      value: textValue(match[2], match[3]),
    };
  if ((match = value.match(/^json (.+?) not-contains (.+)$/)))
    return {
      ...defaultRule('json'),
      target: match[1],
      operator: 'not-contains',
      valueType: 'string',
      value: plain(match[2]),
    };
  if ((match = value.match(/^json (.+?) (equals|not-equals|contains|==|=|!=|<=|>=|<|>) (.+)$/))) {
    const rule = {
      ...defaultRule('json'),
      target: match[1],
      operator: comparisonName(match[2]),
      value: match[3],
    };
    if (match[2] === 'equals' || match[2] === 'not-equals') {
      try {
        const parsed: unknown = JSON.parse(match[3]);
        rule.valueType = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
        rule.value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
      } catch {
        return { ...defaultRule('custom'), value: source };
      }
    } else if (match[2] === 'contains') {
      rule.valueType = 'string';
      rule.value = plain(match[3]);
    }
    return rule;
  }
  return { ...defaultRule('custom'), value: source };
}
function finite(value: string): string {
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error('Enter a finite numeric expected value.');
  return String(Number(value));
}
/** An inclusive range, `min max`, with the minimum first. */
function range(min: string, max: string): string {
  const low = finite(min),
    high = finite(max);
  if (Number(low) > Number(high)) throw new Error('Minimum must not exceed maximum.');
  return `${low} ${high}`;
}
export function buildAssertion(rule: TestRule): string {
  const { kind, operator, target, value } = rule;
  const op = operator === 'equals' ? '==' : operator === 'not-equals' ? '!=' : operator;
  if (operators(kind).length && !operators(kind).includes(operator))
    throw new Error('Choose a valid comparison.');
  if (kind === 'status') {
    const code = (text: string) => {
      if (!/^[1-5]\d{2}$/.test(text.trim()))
        throw new Error('Status codes must be between 100 and 599.');
      return text.trim();
    };
    if (operator === 'between') {
      const min = code(value),
        max = code(rule.secondValue);
      if (Number(min) > Number(max)) throw new Error('Minimum status must not exceed maximum.');
      return `status between ${min} ${max}`;
    }
    if (operator === 'in' || operator === 'not-in')
      return `status ${operator} ` + value.split(',').map(code).join(', ');
    return operator === 'equals' ? `status ${code(value)}` : `status ${op} ${code(value)}`;
  }
  if (kind === 'response-time' || kind === 'response-size' || kind === 'body-length')
    return operator === 'between'
      ? `${kind} between ${range(value, rule.secondValue)}`
      : `${kind} ${op} ${finite(value)}`;
  if (kind === 'header' || kind === 'cookie') {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(target))
      throw new Error(`Enter a valid ${kind === 'header' ? 'response header' : 'cookie'} name.`);
    if (operator === 'exists' || operator === 'not-exists') return `${kind}-${operator} ${target}`;
    if (formats.includes(operator)) return `${kind} ${target} ${operator}`;
    return `${kind} ${target} ${operator} ${textArgumentFor(operator, value)}`;
  }
  if (kind === 'timing' || kind === 'certificate-days-left') {
    if (kind === 'timing' && !(TIMING_TARGETS as readonly string[]).includes(target))
      throw new Error(`Choose a timing: ${TIMING_TARGETS.join(', ')}.`);
    const subject = kind === 'timing' ? `timing ${target}` : kind;
    return operator === 'between'
      ? `${subject} between ${range(value, rule.secondValue)}`
      : `${subject} ${op} ${finite(value)}`;
  }
  if (kind === 'content-type') {
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value.trim()))
      throw new Error('Enter a media type such as application/json.');
    return `content-type ${value.trim()}`;
  }
  if (kind === 'body') {
    if (operator === 'empty' || operator === 'not-empty') return `body-${operator}`;
    // The original checks keep their own names; the others use the general body form.
    return ['contains', 'not-contains', 'equals'].includes(operator)
      ? `body-${operator} ${JSON.stringify(value)}`
      : `body ${operator} ${textArgumentFor(operator, value)}`;
  }
  if (kind === 'json-valid') return 'json-valid';
  if (kind === 'custom') {
    if (!value.trim() || /[\r\n]/.test(value) || /^\s*(#|\/\/)/.test(value))
      throw new Error('Enter one assertion, without comments or newlines.');
    return value.trim();
  }
  validatePath(target);
  if (kind === 'json-schema') {
    let schema: unknown;
    try {
      schema = JSON.parse(value);
    } catch {
      throw new Error('Enter the JSON Schema as a JSON object.');
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
      throw new Error('Enter the JSON Schema as a JSON object.');
    return `json-schema ${target === '$' ? '' : `${target} `}${JSON.stringify(schema)}`;
  }
  if (kind === 'json-field') return `json-${operator} ${target}`;
  if (kind === 'json-type') {
    if (!['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(value))
      throw new Error('Choose a JSON type.');
    return `json-type ${target} ${value}`;
  }
  if (kind === 'json-length')
    return operator === 'between'
      ? `json-length ${target} between ${range(value, rule.secondValue)}`
      : `json-length ${target} ${op} ${finite(value)}`;
  if (kind === 'json') {
    if (operator === 'between') return `json ${target} between ${range(value, rule.secondValue)}`;
    if (
      operator === 'in' ||
      operator === 'not-in' ||
      (LIST_OPERATORS as readonly string[]).includes(operator)
    )
      return `json ${target} ${operator} ${JSON.stringify(listValues(value))}`;
    if (VALUELESS_OPERATORS.includes(operator)) return `json ${target} ${operator}`;
    if ((TEXT_OPERATORS as readonly string[]).includes(operator) && !operator.endsWith('equals'))
      return `json ${target} ${operator} ${textArgumentFor(operator, value)}`;
    if (!['equals', 'not-equals'].includes(operator))
      return `json ${target} ${op} ${finite(value)}`;
    let expected: unknown;
    if (rule.valueType === 'string') expected = value;
    else if (rule.valueType === 'number') expected = Number(finite(value));
    else if (rule.valueType === 'null') expected = null;
    else if (rule.valueType === 'boolean') {
      if (!['true', 'false'].includes(value)) throw new Error('Choose true or false.');
      expected = value === 'true';
    } else {
      try {
        expected = JSON.parse(value);
      } catch {
        throw new Error('Enter valid JSON for the expected object or array.');
      }
      if (
        rule.valueType === 'array'
          ? !Array.isArray(expected)
          : !expected || typeof expected !== 'object' || Array.isArray(expected)
      )
        throw new Error(`Expected a JSON ${rule.valueType}.`);
    }
    return `json ${target} ${operator} ${JSON.stringify(expected)}`;
  }
  throw new Error('Choose a test check.');
}
export function parseCases(source: string): DesignedCase[] {
  const lines = source.split(/\r?\n/);
  return lines.flatMap((raw, line) => {
    const text = raw.trim(),
      disabled = text.startsWith('// @disabled ');
    if (!text || (!disabled && (text.startsWith('//') || text.startsWith('#')))) return [];
    const assertion = disabled ? text.slice('// @disabled '.length) : text;
    let name = '',
      start = line;
    if (line > 0 && lines[line - 1].trim().startsWith('// @case ')) {
      try {
        const parsed: unknown = JSON.parse(lines[line - 1].trim().slice('// @case '.length));
        if (typeof parsed === 'string') {
          name = parsed;
          start = line - 1;
        }
      } catch {
        /* Preserve unrecognized comments. */
      }
    }
    return [
      { name, enabled: !disabled, assertion, rule: ruleFromAssertion(assertion), line, start },
    ];
  });
}
function caseLines(name: string, assertion: string, enabled: boolean): string[] {
  return [
    ...(name.trim() ? ['// @case ' + JSON.stringify(name.trim())] : []),
    (enabled ? '' : '// @disabled ') + assertion,
  ];
}
export function writeCase(
  source: string,
  index: number | null,
  name: string,
  rule: TestRule,
  enabled = true,
): string {
  const assertion = buildAssertion(rule),
    lines = source ? source.split(/\r?\n/) : [];
  const next = caseLines(name, assertion, enabled);
  if (index === null) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(...next);
  } else {
    const entry = parseCases(source)[index];
    if (!entry) throw new Error('Test case no longer exists.');
    lines.splice(entry.start, entry.line - entry.start + 1, ...next);
  }
  return lines.join('\n');
}
export function toggleCase(source: string, index: number, enabled: boolean): string {
  const entry = parseCases(source)[index];
  if (!entry) throw new Error('Test case no longer exists.');
  const lines = source.split(/\r?\n/);
  lines[entry.line] = (enabled ? '' : '// @disabled ') + entry.assertion;
  return lines.join('\n');
}
export function removeCase(source: string, index: number): string {
  const entry = parseCases(source)[index];
  if (!entry) return source;
  const lines = source.split(/\r?\n/);
  lines.splice(entry.start, entry.line - entry.start + 1);
  return lines.join('\n');
}
export function duplicateCase(source: string, index: number): string {
  const entry = parseCases(source)[index];
  if (!entry) return source;
  const lines = source.split(/\r?\n/);
  lines.splice(
    entry.line + 1,
    0,
    ...caseLines(entry.name ? entry.name + ' (copy)' : '', entry.assertion, entry.enabled),
  );
  return lines.join('\n');
}
export function moveCase(source: string, index: number, direction: -1 | 1): string {
  const entries = parseCases(source),
    other = index + direction;
  if (!entries[index] || !entries[other]) return source;
  const first = entries[Math.min(index, other)],
    second = entries[Math.max(index, other)],
    lines = source.split(/\r?\n/);
  return [
    ...lines.slice(0, first.start),
    ...lines.slice(second.start, second.line + 1),
    ...lines.slice(first.line + 1, second.start),
    ...lines.slice(first.start, first.line + 1),
    ...lines.slice(second.line + 1),
  ].join('\n');
}
