import { XMLParser } from 'fast-xml-parser';
import { parse as parseYAML } from 'yaml';
import { parseCSV } from './run-data';

/**
 * A response body read as data, whatever it is written in, so `body.user.id` works the same on
 * JSON, XML, YAML, form-encoded, NDJSON, and CSV bodies. Parsed by fixed grammars only.
 */
export type BodyFormat = 'json' | 'xml' | 'yaml' | 'form' | 'ndjson' | 'csv';
export const BODY_FORMAT_NAMES: Record<BodyFormat, string> = {
  json: 'JSON',
  xml: 'XML',
  yaml: 'YAML',
  form: 'form',
  ndjson: 'NDJSON',
  csv: 'CSV',
};

/** The format a body is in, from its Content-Type, or by looking at it when the type says little. */
export function bodyFormat(contentType: string | undefined, body: string): BodyFormat | undefined {
  const type = (contentType ?? '').toLowerCase().split(';')[0].trim();
  if (/[/+]json$/.test(type) && !/ndjson|jsonl|json-seq/.test(type)) return 'json';
  if (/ndjson|jsonl|json-seq/.test(type)) return 'ndjson';
  if (/[/+]xml$/.test(type)) return 'xml';
  if (/[/+-](yaml|yml)$/.test(type)) return 'yaml';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
  // HTML is read with the html source, and other declared types are not data.
  if (type && !['text/plain', 'application/octet-stream', 'binary/octet-stream'].includes(type))
    return undefined;
  const start = body.trimStart();
  if (/^[[{]/.test(start)) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      return start.includes('\n{') ? 'ndjson' : undefined;
    }
  }
  if (/^<\?xml|^<[A-Za-z_]/.test(start) && !/^<!doctype html|^<html/i.test(start)) return 'xml';
  if (/^(---\s*\n)?[\w"'-][^\n:]*:\s/.test(start)) return 'yaml';
  return undefined;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  // Values stay text, as written; numbers and booleans are a transform away.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
  trimValues: true,
});

/** The body as data, and the format it was read as. Throws, saying why, when it is not data. */
export function parseBody(
  body: string,
  contentType?: string,
): { format: BodyFormat; value: unknown } {
  const format = bodyFormat(contentType, body);
  if (!format)
    throw new Error(
      'The body is not JSON, XML, YAML, form, NDJSON, or CSV; read it with body, regex, between, or html.',
    );
  try {
    if (format === 'json') return { format, value: JSON.parse(body) };
    if (format === 'ndjson')
      return {
        format,
        value: body
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown),
      };
    if (format === 'xml') return { format, value: xml.parse(body) as unknown };
    if (format === 'yaml')
      // Aliases are capped, so a body cannot expand into a huge value.
      return { format, value: parseYAML(body, { maxAliasCount: 100 }) as unknown };
    if (format === 'form') {
      const value: Record<string, string | string[]> = {};
      for (const [name, item] of new URLSearchParams(body.trim())) {
        const current = value[name];
        value[name] =
          current === undefined
            ? item
            : Array.isArray(current)
              ? [...current, item]
              : [current, item];
      }
      return { format, value };
    }
    return { format, value: parseCSV(body).rows };
  } catch (error) {
    throw new Error(
      `The body is not valid ${BODY_FORMAT_NAMES[format]}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
