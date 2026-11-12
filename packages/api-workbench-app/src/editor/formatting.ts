import { format } from 'prettier/standalone';
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as html from 'prettier/plugins/html';
import * as postcss from 'prettier/plugins/postcss';
import * as yaml from 'prettier/plugins/yaml';
import * as graphql from 'prettier/plugins/graphql';
import * as markdown from 'prettier/plugins/markdown';
import * as typescript from 'prettier/plugins/typescript';
import type { MDI_ICON_NAMES } from '@techieutils/api-workbench-common/icon-names';

export interface EditorLanguage {
  id: string;
  label: string;
  /** The icon beside the language in select boxes. */
  icon: (typeof MDI_ICON_NAMES)[number];
  /** The Prettier parser that formats it; empty when it cannot be formatted. */
  parser: string;
}
export const languages: EditorLanguage[] = [
  {
    id: 'json',
    label: 'JSON',
    icon: 'code-json',
    parser: 'json-stringify',
  },
  {
    id: 'jsonc',
    label: 'JSON with comments',
    icon: 'comment-text-outline',
    parser: 'json',
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    icon: 'language-javascript',
    parser: 'babel',
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    icon: 'language-typescript',
    parser: 'typescript',
  },
  { id: 'xml', label: 'XML', icon: 'xml', parser: 'xml' },
  { id: 'html', label: 'HTML', icon: 'language-html5', parser: 'html' },
  { id: 'css', label: 'CSS', icon: 'language-css3', parser: 'css' },
  { id: 'scss', label: 'SCSS', icon: 'sass', parser: 'scss' },
  { id: 'yaml', label: 'YAML', icon: 'format-list-bulleted-square', parser: 'yaml' },
  { id: 'graphql', label: 'GraphQL', icon: 'graphql', parser: 'graphql' },
  {
    id: 'markdown',
    label: 'Markdown',
    icon: 'language-markdown-outline',
    parser: 'markdown',
  },
  {
    id: 'ndjson',
    label: 'NDJSON',
    icon: 'format-list-text',
    parser: 'ndjson',
  },
  { id: 'sql', label: 'SQL', icon: 'database-outline', parser: '' },
  { id: 'python', label: 'Python', icon: 'language-python', parser: '' },
  { id: 'shell', label: 'Shell', icon: 'console', parser: '' },
  { id: 'csv', label: 'CSV', icon: 'file-table-outline', parser: '' },
  {
    id: 'protobuf',
    label: 'Protocol Buffers',
    icon: 'file-cog-outline',
    parser: '',
  },
  { id: 'text', label: 'Plain text', icon: 'text', parser: '' },
];
export function detectLanguage(mime = '', content = ''): string {
  mime = mime.split(';')[0].trim().toLowerCase();
  if (mime.includes('ndjson') || mime.includes('jsonl')) return 'ndjson';
  if (mime.includes('json')) return 'json';
  if (mime.includes('typescript')) return 'typescript';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'javascript';
  if (mime.includes('html')) return 'html';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('graphql')) return 'graphql';
  if (mime.includes('yaml')) return 'yaml';
  if (mime.includes('css')) return 'css';
  if (mime.includes('markdown')) return 'markdown';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('sql')) return 'sql';
  if (mime.includes('python')) return 'python';
  if (mime.includes('shell') || mime.includes('x-sh')) return 'shell';
  if (!mime || mime === 'application/octet-stream' || mime === 'text/plain')
    return sniffLanguage(content);
  return 'text';
}
const isJSONLine = (line: string) => {
  try {
    return typeof JSON.parse(line) === 'object';
  } catch {
    return false;
  }
};
/**
 * The language of a body without a useful Content-Type, from how its first 64 KB start; 'text'
 * when it is unclear.
 */
function sniffLanguage(content: string): string {
  const start = content.slice(0, 65_536).trimStart();
  if (start.startsWith('{') || start.startsWith('[')) {
    // Several lines that are each a JSON value are NDJSON; anything else that opens like JSON is
    // shown as JSON, even if it does not parse, so a truncated document still highlights.
    const lines = start.split('\n', 21).filter((line) => line.trim());
    return lines.length > 1 && lines.slice(0, 20).every(isJSONLine) ? 'ndjson' : 'json';
  }
  if (/^(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(start)) return 'html';
  if (/^(?:<\?xml|<[A-Za-z_][\w.:-]*[\s/>])/.test(start)) return 'xml';
  if (/^(?:---(?:\s|$)|%YAML )/.test(start)) return 'yaml';
  if (start.startsWith('#!')) return 'shell';
  if (/^#{1,6} \S/.test(start)) return 'markdown';
  return 'text';
}
export function canFormat(language: string): boolean {
  return Boolean(languages.find((item) => item.id === language)?.parser);
}
export async function formatText(source: string, language: string): Promise<string> {
  const selected = languages.find((item) => item.id === language);
  if (!selected?.parser)
    throw new Error(`Formatting is not available for ${selected?.label || language}.`);
  if (!source.trim()) return source;
  if (source.length > 2_000_000) throw new Error('Format supports documents up to 2 MB.');
  if (language === 'json') JSON.parse(source);
  if (language === 'ndjson') {
    const lines = await Promise.all(
      source.split(/\r?\n/).map(async (line, index) => {
        if (!line.trim()) return '';
        try {
          JSON.parse(line);
          return (
            await format(line, {
              parser: 'json-stringify',
              plugins: [babel, estree],
              tabWidth: 2,
            })
          ).replace(/\n\s*/g, '');
        } catch {
          throw new Error(`Invalid NDJSON on line ${index + 1}.`);
        }
      }),
    );
    return lines.filter(Boolean).join('\n') + '\n';
  }
  let xmlWhitespaceSensitivity = 'ignore';
  if (language === 'xml' && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.querySelector('parsererror'))
      throw new Error('Invalid XML. Check matching tags and attribute quotes.');
    // Preserve whitespace when text and child elements are mixed in the same element.
    if (
      [...document.querySelectorAll('*')].some(
        (element) =>
          element.children.length &&
          [...element.childNodes].some(
            (node) => (node.nodeType === 3 || node.nodeType === 4) && node.textContent?.trim(),
          ),
      )
    )
      xmlWhitespaceSensitivity = 'strict';
  }
  const xml = (await import('@prettier/plugin-xml')).default;
  return format(source, {
    parser: selected.parser,
    plugins: [babel, estree, html, postcss, yaml, graphql, markdown, typescript, xml],
    tabWidth: 2,
    useTabs: false,
    printWidth: 80,
    endOfLine: 'lf',
    xmlWhitespaceSensitivity,
  });
}
