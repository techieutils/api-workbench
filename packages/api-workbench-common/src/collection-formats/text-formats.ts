import { object, array, text, request, rows } from './common';
import type { CollectionData, Obj } from './common';
import type { ApiRequest } from '../types';
export function har(doc: Obj): CollectionData {
  return {
    requests: array(object(doc.log).entries).map((entry, index) => {
      const s = object(entry.request);
      const r = request(s, text(entry.comment) || `Request ${index + 1}`, 'HAR');
      r.headers = rows(s.headers).filter((h) => !h.key.startsWith(':'));
      r.params = rows(s.queryString);
      const p = object(s.postData);
      r.body = text(p.text);
      r.rawContentType = text(p.mimeType);
      if (p.params) {
        r.bodyType = r.rawContentType.includes('multipart') ? 'form-data' : 'x-www-form-urlencoded';
        r.bodyFields = rows(p.params).map((v, i) => ({
          ...v,
          kind: array(p.params)[i].fileName ? 'file' : 'text',
          fileName: text(array(p.params)[i].fileName) || undefined,
        }));
      } else r.bodyType = r.body ? 'raw' : 'none';
      return r;
    }),
  };
}
/**
 * The files a `.http` file's requests send, by request (in order): a body that is one `< ./path`
 * line, and multipart parts whose content is one. Paths are as written — relative to the `.http`
 * file, and with any `{{variables}}`, which the sender fills in; reading them is the caller's.
 * `<@ ./path` also fills `{{variables}}` in the file's text when sent: `templates` lists those
 * (`''` for the body, else a field's name).
 */
export interface HttpFileReferences {
  binary?: string;
  fields: Record<string, string>;
  templates?: string[];
}
const FILE_LINE = /^<(@)?\s+(\S.*?)\s*$/;
const baseName = (file: string) => file.split(/[\\/]/).pop() || file;

/** A multipart body's parts, as form fields: text, or a file named by a `< ./path` line. */
function multipartFields(
  body: string,
  boundary: string,
):
  | {
      fields: NonNullable<ApiRequest['bodyFields']>;
      files: Record<string, string>;
      templates: string[];
    }
  | undefined {
  const fields: NonNullable<ApiRequest['bodyFields']> = [];
  const files: Record<string, string> = {};
  const templates: string[] = [];
  const parts = body.split(
    new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*$`, 'm'),
  );
  for (const part of parts.slice(1)) {
    const text = part.replace(/^\n/, '');
    if (!text.trim()) continue;
    const split = text.indexOf('\n\n');
    const head = split < 0 ? text : text.slice(0, split);
    const content = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
    const disposition = /^content-disposition:\s*form-data;(.*)$/im.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) return undefined;
    const fileName = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const line = FILE_LINE.exec(content.trim());
    const file = line?.[2];
    if (file) {
      files[name] = file;
      if (line[1]) templates.push(name);
      fields.push({
        enabled: true,
        key: name,
        value: '',
        kind: 'file',
        fileName: fileName || baseName(file),
      });
    } else fields.push({ enabled: true, key: name, value: content, kind: 'text' });
  }
  return { fields, files, templates };
}

export function httpFile(source: string): CollectionData {
  return parseHttpFile(source).data;
}

/** The files each of a `.http` file's requests sends, in the order `httpFile` gives them. */
export function httpFileReferences(source: string): (HttpFileReferences | undefined)[] {
  return parseHttpFile(source).references;
}

function parseHttpFile(source: string): {
  data: CollectionData;
  references: (HttpFileReferences | undefined)[];
} {
  const references: (HttpFileReferences | undefined)[] = [];
  const requests: Partial<ApiRequest>[] = [];
  const env: Record<string, string> = {};
  for (const m of source.matchAll(/^@([\w.-]+)\s*=\s*(.*)$/gm)) env[m[1]] = m[2];
  const chunks = source.replace(/^@[\w.-]+\s*=.*$/gm, '').split(/^\s*###\s*/m);
  for (const chunk of chunks) {
    const lines = chunk.replace(/\r\n/g, '\n').split('\n');
    const lineIndex = lines.findIndex((l) =>
      /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+)?(?:https?:\/\/|\{\{)/i.test(
        l.trim(),
      ),
    );
    if (lineIndex < 0) continue;
    const match = lines[lineIndex].trim().match(
      // `s`, so a stray carriage return or line separator in the line is part of the URL
      // rather than leaving nothing to match.
      /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+)?(.+?)(?:\s+HTTP\/\S+)?$/is,
    )!;
    const r = request(
      { url: match[2], method: match[1] || 'GET' },
      lines
        .slice(0, lineIndex)
        .find((l) => l.trim() && !l.startsWith('#'))
        ?.trim() || `Request ${requests.length + 1}`,
      'HTTP files',
    );
    let index = lineIndex + 1;
    for (; index < lines.length && lines[index].trim(); index++) {
      if (/^\s*(#|\/\/)/.test(lines[index])) continue;
      const h = lines[index].match(/^([^:]+):\s*(.*)$/);
      if (!h) throw new Error(`Invalid HTTP header: ${lines[index]}`);
      r.headers!.push({ key: h[1], value: h[2], enabled: true });
    }
    r.body = lines
      .slice(index + 1)
      .join('\n')
      .replace(/\n+$/, '');
    r.bodyType = r.body ? 'raw' : 'none';
    let files: HttpFileReferences | undefined;
    // A body of one `< ./path` line is that file, sent as it is.
    const line = FILE_LINE.exec(r.body.trim());
    const file = line?.[2];
    const type = r.headers!.find((h) => h.key.trim().toLowerCase() === 'content-type');
    const boundary = /multipart\/form-data;.*boundary="?([^";]+)"?/i.exec(type?.value ?? '')?.[1];
    if (file && !r.body.trim().includes('\n')) {
      r.bodyType = 'binary';
      r.binaryName = baseName(file);
      r.body = '';
      files = { binary: file, fields: {}, ...(line?.[1] ? { templates: [''] } : {}) };
    } else if (boundary) {
      // A multipart body is its form: text fields, and files named by `< ./path` lines. The
      // boundary is chosen again when it is sent, so the header given goes.
      const form = multipartFields(r.body, boundary);
      if (form) {
        r.bodyType = 'form-data';
        r.bodyFields = form.fields;
        r.body = '';
        r.headers = r.headers!.filter((h) => h !== type);
        if (Object.keys(form.files).length)
          files = {
            fields: form.files,
            ...(form.templates.length ? { templates: form.templates } : {}),
          };
      }
    }
    references.push(files);
    requests.push(r);
  }
  const data = {
    requests,
    environments: Object.keys(env).length
      ? [
          {
            name: 'HTTP file variables',
            variables: Object.entries(env).map(([key, value]) => ({ key, value, enabled: true })),
          },
        ]
      : [],
  };
  return { data, references };
}
/** Shell tokenization only. Never evaluates or executes imported commands. */
function shellTokens(source: string): string[] {
  const result: string[] = [];
  let token = '',
    quote = '',
    started = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") {
      if (source[i + 1] === '\n') {
        i++;
        continue;
      }
      token += source[++i] || '';
      started = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else token += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        result.push(token);
        token = '';
        started = false;
      }
    } else {
      token += c;
      started = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in cURL command.');
  if (started) result.push(token);
  return result;
}
export function curl(source: string, warnings: string[]): CollectionData {
  const requests: Partial<ApiRequest>[] = [];
  const commands = source.trim().split(/\n(?=curl\s)/);
  for (const command of commands) {
    const tokens = shellTokens(command);
    if (tokens.shift() !== 'curl') throw new Error('Expected a cURL command.');
    let url = '',
      method = '',
      payload = '';
    const headers: ApiRequest['headers'] = [],
      fields: NonNullable<ApiRequest['bodyFields']> = [];
    let username = '',
      password = '',
      encoded = false;
    for (let i = 0; i < tokens.length; i++) {
      const arg = tokens[i],
        eq = arg.indexOf('=');
      const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
      const take = (): string => {
        const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : tokens[++i];
        if (value === undefined) throw new Error(`Missing cURL value for ${flag}.`);
        return value;
      };
      if (flag === '-X' || flag === '--request') method = take();
      else if (flag === '--url') url = take();
      else if (flag === '-H' || flag === '--header') {
        const h = take();
        const j = h.indexOf(':');
        if (j < 1) throw new Error('Invalid cURL header.');
        headers.push({ key: h.slice(0, j), value: h.slice(j + 1).trim(), enabled: true });
      } else if (
        ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json'].includes(flag)
      ) {
        const value = take();
        if (value.startsWith('@') && flag !== '--data-raw')
          throw new Error(
            'cURL file references must be replaced with inline content before import.',
          );
        const j = value.indexOf('=');
        const encodedValue =
          flag === '--data-urlencode'
            ? j < 0
              ? encodeURIComponent(value)
              : value.slice(0, j + 1) + encodeURIComponent(value.slice(j + 1))
            : value;
        payload += (payload ? '&' : '') + encodedValue;
        if (flag === '--json')
          headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
        if (flag === '--data-urlencode' || flag === '-d' || flag === '--data') encoded = true;
      } else if (flag === '-F' || flag === '--form' || flag === '--form-string') {
        const value = take(),
          j = value.indexOf('=');
        if (j < 1) throw new Error('Invalid cURL form field.');
        const v = value.slice(j + 1),
          file = v.startsWith('@') && flag !== '--form-string';
        fields.push({
          key: value.slice(0, j),
          value: file ? '' : v,
          kind: file ? 'file' : 'text',
          fileName: file ? v.slice(1) : undefined,
          enabled: true,
        });
      } else if (flag === '-u' || flag === '--user') {
        const parts = take().split(':');
        username = parts.shift() || '';
        password = parts.join(':');
      } else if (flag === '-I' || flag === '--head') method = 'HEAD';
      else if (
        [
          '-L',
          '--location',
          '-s',
          '--silent',
          '-S',
          '--show-error',
          '--compressed',
          '--insecure',
          '-k',
          '--globoff',
        ].includes(flag)
      ) {
        if (flag === '-k' || flag === '--insecure')
          warnings.push('cURL TLS verification bypass was not imported.');
      } else if (flag.startsWith('-'))
        throw new Error(`Unsupported cURL option ${flag}. Remove it before import.`);
      else if (!url && /^(https?:|\{\{)/.test(arg)) url = arg;
      else throw new Error(`Unexpected cURL argument ${arg}.`);
    }
    const r = request(
      { url, method: method || (payload || fields.length ? 'POST' : 'GET') },
      `cURL ${requests.length + 1}`,
      'cURL',
    );
    r.headers = headers;
    r.body = payload;
    r.bodyType = fields.length ? 'form-data' : payload ? 'raw' : 'none';
    r.bodyFields = fields;
    if (encoded && !headers.some((h) => h.key.toLowerCase() === 'content-type'))
      r.headers.push({
        key: 'Content-Type',
        value: 'application/x-www-form-urlencoded',
        enabled: true,
      });
    if (username) {
      r.auth = 'Basic auth';
      r.username = username;
      r.password = password;
    }
    requests.push(r);
  }
  return { requests };
}
