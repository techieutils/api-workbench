import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { openAPICollection } from './collection-formats/openapi';
import { buildDocument, serialize } from './documentation';
import { FOLDER_SEPARATOR } from './folders';
import type { ApiRequest, ApiSpec } from './types';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const SIZE_LIMIT = 10 * 1024 * 1024;
export const SPEC_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export interface SpecProblem {
  severity: 'error' | 'warning';
  message: string;
  /** The 1-based line the problem is on, when known. */
  line?: number;
}
export interface SpecEndpoint {
  method: string;
  path: string;
  summary: string;
  tag: string;
  deprecated: boolean;
}
export interface SpecAnalysis {
  /** The parsed document, when the text is valid YAML or JSON. */
  document?: ObjectValue;
  /** "OpenAPI 3.0.3" or "Swagger 2.0", when recognised. */
  version?: string;
  title?: string;
  problems: SpecProblem[];
  endpoints: SpecEndpoint[];
}

/**
 * Reads an OpenAPI 3 or Swagger 2 document in YAML or JSON: syntax errors with their lines, the
 * structure a specification needs, local references that point nowhere, and its operations.
 */
export function analyzeSpec(content: string): SpecAnalysis {
  const problems: SpecProblem[] = [];
  if (new TextEncoder().encode(content).length > SIZE_LIMIT)
    return {
      problems: [{ severity: 'error', message: 'Specifications must be smaller than 10 MB.' }],
      endpoints: [],
    };
  const lines = new LineCounter();
  const parsed = parseDocument(content, { lineCounter: lines, uniqueKeys: true });
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? undefined : lines.linePos(offset).line;
  for (const error of parsed.errors)
    problems.push({
      severity: 'error',
      message: error.message.split('\n')[0],
      line: lineAt(error.pos[0]),
    });
  if (problems.length) return { problems, endpoints: [] };
  // An alias with no anchor (`*a`), or too many aliases (a "billion laughs" document), is only
  // found here: a problem with the text, like a syntax error, not a failure of the editor.
  let value: unknown;
  try {
    value = parsed.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      problems: [{ severity: 'error', message: (error as Error).message.split('\n')[0] }],
      endpoints: [],
    };
  }
  const document = object(value);
  /** The line of the key (or list item) at a path in the document, when it is there. */
  const lineOf = (path: (string | number)[]) => {
    const parent = path.length > 1 ? parsed.getIn(path.slice(0, -1), true) : parsed.contents;
    const last = path[path.length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === last);
      const key = pair?.key as { range?: [number] } | undefined;
      return lineAt(key?.range?.[0]);
    }
    if (isSeq(parent) && typeof last === 'number')
      return lineAt((parent.items[last] as { range?: [number] } | undefined)?.range?.[0]);
    return undefined;
  };
  const add = (severity: SpecProblem['severity'], message: string, path?: (string | number)[]) =>
    problems.push({ severity, message, ...(path ? { line: lineOf(path) } : {}) });

  const swagger = document.swagger === '2.0';
  const openapi = typeof document.openapi === 'string' ? document.openapi : '';
  let version: string | undefined;
  if (swagger) version = 'Swagger 2.0';
  else if (/^3\.(0|1|2)(\.\d+)?$/.test(openapi)) version = `OpenAPI ${openapi}`;
  else if (!content.trim()) add('error', 'The specification is empty.');
  else
    add(
      'error',
      'Start with "openapi: 3.x" or "swagger: \'2.0\'"; other formats are not supported.',
      document.openapi !== undefined ? ['openapi'] : undefined,
    );
  const info = object(document.info);
  const title = typeof info.title === 'string' ? info.title : undefined;
  if (!document.info) add('error', 'Add an info object with a title and version.');
  else {
    if (!title) add('error', 'info.title is required.', ['info']);
    if (info.version === undefined) add('warning', 'info.version is missing.', ['info']);
  }
  const endpoints: SpecEndpoint[] = [];
  const paths = document.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths))
    add('error', 'Add a paths object; it lists the API’s operations.');
  else {
    const operationIds = new Map<string, string>();
    for (const [path, item] of Object.entries(paths as ObjectValue)) {
      if (!path.startsWith('/')) {
        add('error', `Path "${path}" must start with "/".`, ['paths', path]);
        continue;
      }
      for (const method of SPEC_METHODS) {
        const operation = object(object(item)[method]);
        if (!object(item)[method]) continue;
        const where = `${method.toUpperCase()} ${path}`;
        if (!operation.responses || typeof operation.responses !== 'object')
          add('warning', `${where} has no responses.`, ['paths', path, method]);
        if (typeof operation.operationId === 'string') {
          const earlier = operationIds.get(operation.operationId);
          if (earlier)
            add(
              'warning',
              `${where} reuses operationId "${operation.operationId}" from ${earlier}.`,
              ['paths', path, method, 'operationId'],
            );
          else operationIds.set(operation.operationId, where);
        }
        const tags = Array.isArray(operation.tags) ? operation.tags : [];
        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary:
            typeof operation.summary === 'string'
              ? operation.summary
              : typeof operation.operationId === 'string'
                ? operation.operationId
                : '',
          tag: typeof tags[0] === 'string' ? tags[0] : '',
          deprecated: operation.deprecated === true,
        });
      }
    }
    if (!Object.keys(paths).length) add('warning', 'paths is empty; add an operation.', ['paths']);
  }
  // Every local reference must point at something in the document.
  const resolves = (reference: string) => {
    let target: unknown = document;
    for (const part of reference.slice(2).split('/')) {
      target = object(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (target === undefined) return false;
    }
    return true;
  };
  const seen = new Set<string>();
  const visit = (value: unknown, path: (string | number)[], depth: number) => {
    if (depth > 64 || !value || typeof value !== 'object') return;
    if (Array.isArray(value))
      return value.forEach((item, index) => visit(item, [...path, index], depth + 1));
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') {
        if (seen.has(item)) continue;
        seen.add(item);
        if (item.startsWith('#/')) {
          if (!resolves(item)) add('error', `Reference ${item} points to nothing.`, [...path, key]);
        } else add('warning', `External reference ${item} is not resolved here.`, [...path, key]);
      } else visit(item, [...path, key], depth + 1);
    }
  };
  visit(document, [], 0);
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { document, version, title, problems, endpoints };
}

/** Whether a specification's text is JSON rather than YAML. */
export const specFormat = (content: string): ApiSpec['format'] =>
  content.trimStart().startsWith('{') ? 'json' : 'yaml';

/** A small, valid OpenAPI 3 document to start from. */
export function blankSpec(name: string, format: ApiSpec['format'] = 'yaml'): string {
  return serialize(
    {
      openapi: '3.0.3',
      info: { title: name, version: '1.0.0' },
      servers: [{ url: 'http://localhost:4010' }],
      paths: {
        '/items': {
          get: {
            summary: 'List items',
            tags: ['Items'],
            responses: {
              '200': {
                description: 'The items',
                content: {
                  'application/json': { example: [{ id: 1, name: 'First item' }] },
                },
              },
            },
          },
        },
        '/items/{id}': {
          get: {
            summary: 'Get an item',
            tags: ['Items'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
            responses: {
              '200': {
                description: 'The item',
                content: { 'application/json': { example: { id: 1, name: 'First item' } } },
              },
              '404': { description: 'No such item' },
            },
          },
        },
      },
    },
    format === 'yaml',
  );
}

/** An OpenAPI 3 document describing a collection's saved HTTP requests. */
export const specFromRequests = (
  name: string,
  requests: ApiRequest[],
  format: ApiSpec['format'] = 'yaml',
): string => serialize(buildDocument(name, requests), format === 'yaml');

/**
 * The requests a specification describes, in a collection named `collection`: operations with a
 * tag go in a folder named after it.
 */
export function requestsFromSpec(document: ObjectValue, collection: string): Partial<ApiRequest>[] {
  const title = typeof object(document.info).title === 'string' ? object(document.info).title : '';
  return openAPICollection(document).requests.map((request) => {
    const tag = request.folder && request.folder !== title && request.folder !== 'Imported API';
    return {
      ...request,
      folder: tag
        ? `${collection}${FOLDER_SEPARATOR}${request.folder!.replaceAll(FOLDER_SEPARATOR, '-')}`
        : collection,
    };
  });
}
