import { REQUEST_PROTOCOLS } from './types';
import { bundleSpecification } from './collection-formats/bundle-spec';
import { parseDocument, stringify } from 'yaml';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { openAPICollection } from './collection-formats/openapi';
import { brunoJSON, brunoText, parseDefaults } from './collection-formats/bruno';
import { postman } from './collection-formats/postman';
import { insomnia } from './collection-formats/insomnia';
import {
  hoppscotch,
  isHoppscotchCollection,
  isHoppscotchEnvironment,
} from './collection-formats/hoppscotch';
import { openCollection } from './collection-formats/opencollection';
import { wsdl } from './collection-formats/wsdl';
import { curl, har, httpFile } from './collection-formats/text-formats';
import { methods, mergeDefaults, object, rows, text, variables } from './collection-formats/common';
import type { CollectionData, ImportResult, Obj, TransferFile } from './collection-formats/common';
export { openAPICollection };
export { exportCollection, exportFormats } from './collection-formats/exporters';
export type { CollectionData, ImportResult, TransferFile } from './collection-formats/common';
const FILE_LIMIT = 10 * 1024 * 1024,
  TOTAL_LIMIT = 50 * 1024 * 1024,
  COUNT_LIMIT = 1000;
export function parseImportDocument(source: string): unknown {
  if (strToU8(source).length > FILE_LIMIT)
    throw new Error('Import documents must be smaller than 10 MB.');
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc.toJS({ maxAliasCount: 100 });
}
function safePath(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (
    /^(\/|[A-Za-z]:)/.test(normalized) ||
    normalized.split('/').includes('..') ||
    /\p{Cc}/u.test(normalized)
  )
    throw new Error(`Unsafe archive path: ${name}`);
  return normalized.replace(/^\.\//, '');
}
export function expandFiles(input: TransferFile[]): TransferFile[] {
  const files: TransferFile[] = [];
  let total = 0,
    count = 0;
  const names = new Set<string>();
  const add = (name: string, data: Uint8Array): void => {
    name = safePath(name);
    if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.[^/]+$/.test(name)) return;
    if (++count > COUNT_LIMIT) throw new Error('Import at most 1,000 files at once.');
    if (data.length > FILE_LIMIT || (total += data.length) > TOTAL_LIMIT)
      throw new Error('Import limit: 10 MB per file and 50 MB total.');
    if (names.has(name)) throw new Error(`Duplicate import filename: ${name}`);
    names.add(name);
    files.push({ name, data });
  };
  if (input.length > COUNT_LIMIT) throw new Error('Import at most 1,000 files at once.');
  let compressedTotal = 0;
  for (const file of input) {
    if ((compressedTotal += file.data.length) > TOTAL_LIMIT)
      throw new Error('Import files exceed 50 MB.');
    if (/\.zip$/i.test(file.name) || (file.data[0] === 0x50 && file.data[1] === 0x4b)) {
      let declared = total,
        entries = count;
      const contents = unzipSync(file.data, {
        filter: (entry) => {
          safePath(entry.name);
          if (/\.zip$/i.test(entry.name)) throw new Error('Nested ZIP archives are not supported.');
          if (
            ++entries > COUNT_LIMIT ||
            entry.originalSize > FILE_LIMIT ||
            (declared += entry.originalSize) > TOTAL_LIMIT
          )
            throw new Error(
              'ZIP exceeds the 1,000 file, 10 MB per file, or 50 MB expanded limits.',
            );
          return true;
        },
      });
      for (const [name, data] of Object.entries(contents)) add(name, data);
    } else add(file.name, file.data);
  }
  return files;
}
function checked(data: CollectionData): CollectionData {
  if (!Array.isArray(data.requests)) throw new Error('Collection requests must be an array.');
  if (data.requests.length > 10000) throw new Error('Import at most 10,000 requests at once.');
  const validRows = (value: unknown): void => {
    if (value === undefined) return;
    if (
      !Array.isArray(value) ||
      value.some(
        (r) =>
          !r ||
          typeof r.key !== 'string' ||
          typeof r.value !== 'string' ||
          (r.description !== undefined && typeof r.description !== 'string'),
      )
    )
      throw new Error('Parameters, headers, and variables must have string keys and values.');
  };
  for (const r of data.requests) {
    if (!r || typeof r.url !== 'string' || !methods.includes(r.method || ''))
      throw new Error('Every imported request needs a URL and a supported method.');
    if (r.protocol && !REQUEST_PROTOCOLS.includes(r.protocol))
      throw new Error('Invalid request protocol.');
    validRows(r.params);
    validRows(r.headers);
    validRows(r.bodyFields);
    validRows(r.captures);
  }
  if (data.environments !== undefined && !Array.isArray(data.environments))
    throw new Error('Environments must be an array.');
  for (const e of data.environments || []) {
    if (!e || typeof e.name !== 'string' || !Array.isArray(e.variables))
      throw new Error('Every environment needs a name and variables array.');
    validRows(e.variables);
  }
  return data;
}
export function convertDocument(
  raw: unknown,
  warnings: string[] = [],
  context?: { fileName: string; readFile: (path: string) => string },
): { data: CollectionData; format: string } {
  const docs = Array.isArray(raw) ? raw.map(object) : [object(raw)];
  if (docs.length && docs.every((d) => isHoppscotchCollection(d) || isHoppscotchEnvironment(d)))
    return { data: hoppscotch(Array.isArray(raw) ? raw : [raw], warnings), format: 'Hoppscotch' };
  const doc = object(raw);
  if (Array.isArray(doc.requests))
    return { data: checked(doc as unknown as CollectionData), format: 'API Workbench' };
  if (doc.openapi || doc.swagger) {
    const data = openAPICollection(doc);
    warnings.push(
      'OpenAPI/Swagger imports operations and examples. Review generated bodies and configure authentication before sending.',
    );
    return { data, format: doc.swagger ? 'Swagger 2.0' : 'OpenAPI' };
  }
  if (doc.item || doc._postman_variable_scope || (doc.values && doc._postman_exported_at))
    return { data: postman(doc, warnings), format: 'Postman' };
  if (doc.resources || text(doc.type).includes('.insomnia.'))
    return { data: insomnia(doc, warnings), format: 'Insomnia' };
  if (doc.opencollection || doc.http || doc.graphql || doc.websocket || doc.grpc)
    return {
      data: openCollection(doc, warnings, context?.fileName, context?.readFile),
      format: 'OpenCollection',
    };
  if (doc.items && (doc.name || doc.version || doc.type === 'collection'))
    return { data: brunoJSON(doc, warnings), format: 'Bruno JSON' };
  if (object(doc.log).entries) return { data: har(doc), format: 'HAR' };
  if (doc.name && doc.variables && !doc.items)
    return {
      data: {
        requests: [],
        environments: [
          {
            name: text(doc.name),
            variables: Array.isArray(doc.variables)
              ? rows(doc.variables)
              : variables(doc.variables),
          },
        ],
      },
      format: 'Environment',
    };
  if (doc.environments && !doc.requests)
    return {
      data: { requests: [], environments: doc.environments as CollectionData['environments'] },
      format: 'API Workbench environments',
    };
  throw new Error(
    'Unrecognized collection. Choose API Workbench, Postman, Bruno, OpenCollection, Insomnia, Hoppscotch, OpenAPI, Swagger, WSDL, HAR, cURL, HTTP, or ZIP.',
  );
}
export function importFiles(input: TransferFile[]): ImportResult {
  const files = expandFiles(input),
    warnings: string[] = [],
    formats = new Set<string>();
  const data: CollectionData = { requests: [], environments: [] };
  const defaults = new Map<string, Obj>();
  for (const file of files.filter((f) => /(^|\/)(collection|folder)\.bru$/i.test(f.name))) {
    const d = parseDefaults(strFromU8(file.data));
    defaults.set(file.name.split('/').slice(0, -1).join('/'), d);
    if (object(d.auth).mode)
      warnings.push(`${file.name}: review inherited authentication after import.`);
  }
  const byName = new Map(files.map((f) => [f.name, f]));
  const relativeFile = (base: string, reference: string): TransferFile => {
    if (/^(?:[a-z]+:|\/|\\)/i.test(reference))
      throw new Error(`External reference is not a local file: ${reference}`);
    const parts = base.split('/').slice(0, -1);
    for (const part of reference.replace(/\\/g, '/').split('/')) {
      if (part === '..') {
        if (!parts.length) throw new Error('Reference escapes the imported archive.');
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
    const file = byName.get(parts.join('/'));
    if (!file) throw new Error(`Missing referenced file: ${reference}`);
    return file;
  };
  const readRelative = (base: string, reference: string): string =>
    strFromU8(relativeFile(base, reference).data);
  const specifications = new Map<string, Obj>(),
    dependencies = new Set<string>();
  for (const file of files.filter((f) => /\.(json|ya?ml)$/i.test(f.name))) {
    let doc: Obj;
    try {
      doc = object(parseImportDocument(strFromU8(file.data)));
    } catch {
      continue;
    }
    if (doc.openapi || doc.swagger)
      specifications.set(
        file.name,
        bundleSpecification(
          doc,
          (base, ref) => {
            const target = relativeFile(base, ref);
            return {
              name: target.name,
              document: object(parseImportDocument(strFromU8(target.data))),
            };
          },
          file.name,
          dependencies,
        ),
      );
  }
  for (const file of files) {
    const name = file.name;
    if (dependencies.has(name) && !specifications.has(name)) continue;
    if (/(^|\/)(bruno\.json|collection\.bru|folder\.bru)$/i.test(name) || /\.proto$/i.test(name))
      continue;
    if (!/\.(json|ya?ml|bru|wsdl|wdsl|xml|har|http|rest|curl|sh|txt)$/i.test(name)) {
      warnings.push(`Skipped non-collection file: ${name}`);
      continue;
    }
    try {
      const source = strFromU8(file.data).replace(/^\uFEFF/, '');
      let converted: { data: CollectionData; format: string };
      if (/\.bru$/i.test(name)) {
        let inherited: Obj = {};
        for (const [directory, config] of [...defaults].sort((a, b) => a[0].length - b[0].length))
          if (!directory || name.startsWith(directory + '/'))
            inherited = mergeDefaults(inherited, config);
        converted = {
          data: brunoText(source, name, warnings, inherited, (ref) => readRelative(name, ref)),
          format: 'Bruno',
        };
      } else if (/^\s*(?:<\?xml[^>]*>\s*)?</.test(source))
        converted = { data: wsdl(source, warnings), format: 'WSDL / SOAP' };
      else if (/^\s*curl\s/.test(source))
        converted = { data: curl(source, warnings), format: 'cURL' };
      else if (/\.(http|rest)$/i.test(name))
        converted = { data: httpFile(source), format: 'HTTP requests' };
      else {
        const parsed = specifications.get(name) || parseImportDocument(source);
        const doc = object(parsed);
        // Directory metadata is meaningful to its source tool but has no requests.
        if (
          /\.(ya?ml)$/i.test(name) &&
          /(^|\/)(folder|collection|opencollection)\.ya?ml$/i.test(name) &&
          !doc.items &&
          !doc.http &&
          !doc.opencollection
        )
          continue;
        converted = convertDocument(parsed, warnings, {
          fileName: name,
          readFile: (ref) => readRelative(name, ref),
        });
      }
      checked(converted.data);
      data.requests.push(...converted.data.requests);
      data.environments!.push(...(converted.data.environments || []));
      if (converted.data.settings) data.settings = converted.data.settings;
      if (converted.data.collectionHttpSettings)
        data.collectionHttpSettings = {
          ...data.collectionHttpSettings,
          ...converted.data.collectionHttpSettings,
        };
      if (converted.data.collectionScripts)
        data.collectionScripts = {
          ...data.collectionScripts,
          ...converted.data.collectionScripts,
        };
      if (converted.data.collectionTags)
        data.collectionTags = { ...data.collectionTags, ...converted.data.collectionTags };
      if (converted.data.scriptSnippets)
        data.scriptSnippets = [
          ...(data.scriptSnippets ?? []),
          ...converted.data.scriptSnippets.filter(
            (snippet) => !data.scriptSnippets?.some((other) => other.id === snippet.id),
          ),
        ];
      if (converted.data.scriptLibrary)
        data.scriptLibrary = [
          ...(data.scriptLibrary ?? []),
          ...converted.data.scriptLibrary.filter(
            (module) => !data.scriptLibrary?.some((other) => other.name === module.name),
          ),
        ];
      if (converted.data.workspaceScripts && !data.workspaceScripts)
        data.workspaceScripts = converted.data.workspaceScripts;
      formats.add(converted.format);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
  if (!data.requests.length && !data.environments!.length)
    throw new Error('No requests or environments found in the selected files.');
  checked(data);
  return {
    data,
    format: [...formats].join(', '),
    warnings: [...new Set(warnings)],
    files: files.length,
  };
}
export function archiveFiles(files: TransferFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [safePath(f.name), f.data])), { level: 6 });
}
// Used by the renderer when accepting pasted JSON/YAML without a file.
export function parseText(source: string): ImportResult {
  return importFiles([
    {
      name: /^\s*curl\s/.test(source)
        ? 'pasted.curl'
        : /^\s*</.test(source)
          ? 'pasted.wsdl'
          : 'pasted.yaml',
      data: strToU8(source),
    },
  ]);
}
export const yamlText = stringify;
