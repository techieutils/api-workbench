import { setOwnValue } from './own';
import { parse as parseYAML } from 'yaml';
import { XMLParser } from 'fast-xml-parser';

/**
 * Data files for data-driven collection runs: each row is one iteration, and each column a
 * variable that requests and tests use as {{column}} during it. Files are parsed into text values,
 * never run.
 */
export type RunDataFormat = 'csv' | 'json' | 'yaml' | 'xml';
export interface RunData {
  /** The file's name, for the report. */
  name: string;
  format: RunDataFormat;
  /** Every column, in first-seen order. */
  columns: string[];
  rows: Record<string, string>[];
}

export const RUN_DATA_LIMITS = {
  bytes: 5 * 1024 * 1024,
  rows: 10_000,
  columns: 200,
} as const;
export const RUN_DATA_ACCEPT = '.csv,.tsv,.txt,.json,.yaml,.yml,.xml';

const FORMAT_NAMES: Record<RunDataFormat, string> = {
  csv: 'CSV',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
};
export const runDataFormatName = (format: RunDataFormat) => FORMAT_NAMES[format];

/** The format from the file name, or from how the text starts when the extension says nothing. */
export function runDataFormat(name: string, text: string): RunDataFormat {
  const extension = name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (extension === 'json') return 'json';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'xml') return 'xml';
  if (extension === 'csv' || extension === 'tsv') return 'csv';
  const start = text.replace(/^\uFEFF/, '').trimStart();
  if (start.startsWith('<')) return 'xml';
  if (start.startsWith('[') || start.startsWith('{')) return 'json';
  if (/^-\s/.test(start) || /^---/.test(start)) return 'yaml';
  return 'csv';
}

/** A column name usable as {{name}}: trimmed, without braces, and not too long. */
function columnName(value: string, where: string): string {
  const name = value.trim();
  if (!name) throw new Error(`${where} has an empty column name.`);
  if (/[{}]/.test(name)) throw new Error(`${where}: column “${name}” cannot contain { or }.`);
  if (name.length > 200) throw new Error(`${where}: a column name is longer than 200 characters.`);
  return name;
}
/** A value as the text a request receives: numbers and booleans as written, objects as JSON. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return JSON.stringify(value);
}

/**
 * CSV as in RFC 4180: a header row, then one row per iteration. Fields may be quoted, with ""
 * for a quote and line breaks inside quotes. The separator is the first of comma, semicolon, or
 * tab found in the header outside quotes, so spreadsheet exports from any locale work.
 */
export function parseCSV(source: string): { columns: string[]; rows: Record<string, string>[] } {
  const input = source.replace(/^\uFEFF/, '');
  const header = input.slice(0, input.search(/\r?\n|$/));
  let separator = ',';
  let quoted = false;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === ',' || char === ';' || char === '\t')) {
      separator = char;
      break;
    }
  }
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    record.push(field);
    // Blank lines are skipped, as spreadsheets often leave one at the end.
    if (record.length > 1 || record[0] !== '')
      records.push(Object.assign(record, { line: recordLine }));
    record = [];
    field = '';
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index++;
        } else inQuotes = false;
      } else {
        if (char === '\n') line++;
        field += char;
      }
    } else if (char === '"' && field === '') inQuotes = true;
    else if (char === separator) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      endRecord();
      line++;
      recordLine = line;
    } else field += char;
  }
  if (inQuotes) throw new Error(`CSV row ${recordLine} has a quote that is never closed.`);
  if (field !== '' || record.length) endRecord();
  if (!records.length) throw new Error('The CSV file is empty. Its first row names the columns.');
  const columns = records[0].map((name, index) =>
    columnName(name, `CSV header, column ${index + 1}`),
  );
  const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
  if (duplicate) throw new Error(`The CSV header names “${duplicate}” more than once.`);
  const rows = records.slice(1).map((cells) => {
    if (cells.length > columns.length)
      throw new Error(
        `CSV line ${(cells as string[] & { line: number }).line} has ${cells.length} values but the header has ${columns.length} columns.`,
      );
    return Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? '']));
  });
  return { columns, rows };
}

/** Rows from parsed JSON or YAML: an array of objects, or an object holding one such array. */
function rowsOf(value: unknown, format: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  throw new Error(
    `The ${format} file needs a list of rows, such as [{ "id": 1 }, { "id": 2 }], or one object holding such a list.`,
  );
}
/** Rows of objects into text records; each object's keys become columns. */
function records(items: unknown[], format: string) {
  const columns: string[] = [];
  const rows = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error(`${format} row ${index + 1} is not an object of named values.`);
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(item)) {
      const name = columnName(key, `${format} row ${index + 1}`);
      if (!columns.includes(name)) columns.push(name);
      setOwnValue(row, name, text(value));
    }
    return row;
  });
  // A column missing from some rows is empty there, like an empty CSV cell.
  for (const row of rows)
    for (const name of columns) if (!Object.hasOwn(row, name)) setOwnValue(row, name, '');
  return { columns, rows };
}

/**
 * XML: the root's repeated child elements are the rows, such as
 * `<rows><row><id>1</id></row><row id="2"/></rows>`. A row's attributes and child elements are
 * its columns; nested elements become JSON text. Entities are not expanded beyond XML's own.
 */
function parseXML(source: string) {
  if (/<!DOCTYPE/i.test(source)) throw new Error('XML files with a DOCTYPE are not supported.');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    textNodeName: '#text',
    processEntities: true,
    htmlEntities: false,
  });
  let document: Record<string, unknown>;
  try {
    document = parser.parse(source, true) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`The XML file could not be read: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const roots = Object.entries(document).filter(([key]) => !key.startsWith('?'));
  if (roots.length !== 1 || !roots[0][1] || typeof roots[0][1] !== 'object')
    throw new Error('The XML file needs one root element whose child elements are the rows.');
  const children = Object.entries(roots[0][1] as Record<string, unknown>).filter(
    ([key]) => key !== '#text',
  );
  if (children.length !== 1)
    throw new Error(
      'Each row in the XML file must use the same element name, such as <row> inside <rows>.',
    );
  // One row parses as an element rather than a list of them.
  const found = children[0][1];
  const items = (Array.isArray(found) ? found : [found]).map((item) =>
    item && typeof item === 'object'
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).map(([key, value]) => [
            key === '#text' ? 'value' : key,
            value &&
            typeof value === 'object' &&
            '#text' in value &&
            Object.keys(value).length === 1
              ? (value as Record<string, unknown>)['#text']
              : value,
          ]),
        )
      : { value: item },
  );
  return records(items, 'XML');
}

/** Reads a data file into rows of text values; the message says what is wrong and where. */
export function parseRunData(name: string, source: string): RunData {
  if (typeof source !== 'string') throw new Error('Choose a data file.');
  if (new TextEncoder().encode(source).length > RUN_DATA_LIMITS.bytes)
    throw new Error('Data files are limited to 5 MB.');
  const format = runDataFormat(name, source);
  const label = FORMAT_NAMES[format];
  let data: { columns: string[]; rows: Record<string, string>[] };
  if (format === 'csv') data = parseCSV(source);
  else if (format === 'xml') data = parseXML(source);
  else {
    let value: unknown;
    try {
      value =
        format === 'json'
          ? JSON.parse(source.replace(/^\uFEFF/, ''))
          : parseYAML(source, { maxAliasCount: 100 });
    } catch (error) {
      throw new Error(`The ${label} file could not be read: ${(error as Error).message}`, {
        cause: error,
      });
    }
    data = records(rowsOf(value, label), label);
  }
  if (!data.rows.length) throw new Error(`The ${label} file has no rows.`);
  if (data.rows.length > RUN_DATA_LIMITS.rows)
    throw new Error(`Data files are limited to ${RUN_DATA_LIMITS.rows.toLocaleString('en')} rows.`);
  if (data.columns.length > RUN_DATA_LIMITS.columns)
    throw new Error(`Data files are limited to ${RUN_DATA_LIMITS.columns} columns.`);
  return { name: name.slice(0, 200), format, ...data };
}

/**
 * Tests with {{column}} replaced by the row's values, so each row can carry its own expected
 * values. Only the data file's columns are replaced; anything else in braces is left as written.
 */
export function withRowValues(tests: string, row: Record<string, string>): string {
  return tests.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) =>
    Object.hasOwn(row, key.trim()) ? row[key.trim()] : match,
  );
}
