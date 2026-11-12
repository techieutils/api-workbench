import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type {
  ApiSpec,
  MockServer,
  ScriptModule,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import { MODULE_NAME, normalizedLibrary } from '@techieutils/api-workbench-common/scripts';
import { normalizeMock } from '@techieutils/api-workbench-common/mocks';
import { specFormat } from '@techieutils/api-workbench-common/api-specs';
import { safeFileName, type CollectionFiles } from './collection-files';

/**
 * API specifications and mock servers on disk, beside the collections:
 *
 *   specs/
 *     Shop API.yaml   the specification exactly as written (or .json)
 *   mocks/
 *     Shop mock.yaml  one mock server: its port, CORS setting, and routes
 *   scripts/
 *     signing.js      a library module that request scripts load with aw.require('signing')
 *
 * A specification file holds only the specification, so other tools can open it; its id, name,
 * and linked collection are listed in the workspace file. A mock file holds everything about it.
 */
export const SPECS_DIRECTORY = 'specs';
export const MOCKS_DIRECTORY = 'mocks';
export const SCRIPTS_DIRECTORY = 'scripts';
const SPEC_EXTENSIONS = ['.yaml', '.yml', '.json'];

/** A specification's entry in the workspace file. */
export interface SpecEntry {
  id: string;
  name: string;
  /** The file name inside `specs/`. */
  file: string;
  collection?: string;
}
const posix = (...parts: string[]) => parts.join('/');
/** A name not yet taken, ignoring case, as disks on macOS and Windows usually do. */
function uniqueName(base: string, extension: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `${n === 1 ? base : `${base} ${n}`}${extension}`;
    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return name;
    }
  }
}

/** The spec and mock files for a workspace, and the spec entries for its workspace file. */
export function apiFiles(state: WorkspaceState): { files: CollectionFiles; specs: SpecEntry[] } {
  const files: CollectionFiles = new Map();
  const specs: SpecEntry[] = [];
  const specNames = new Set<string>();
  for (const spec of state.specs ?? []) {
    // Unique without the extension, so a YAML and a JSON spec never share a name.
    const file = uniqueName(safeFileName(spec.name), '', specNames) + `.${spec.format}`;
    files.set(posix(SPECS_DIRECTORY, file), spec.content);
    specs.push({
      id: spec.id,
      name: spec.name,
      file,
      ...(spec.collection ? { collection: spec.collection } : {}),
    });
  }
  const mockNames = new Set<string>();
  for (const mock of state.mocks ?? []) {
    const file = uniqueName(safeFileName(mock.name), '.yaml', mockNames);
    files.set(posix(MOCKS_DIRECTORY, file), stringify(mock, { lineWidth: 0 }));
  }
  // A module's name is already a safe file name (MODULE_NAME), so it is its file's name.
  for (const module of normalizedLibrary(state.scriptLibrary) ?? [])
    files.set(posix(SCRIPTS_DIRECTORY, `${module.name}.js`), module.source);
  return { files, specs };
}

async function list(directory: string, extensions: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
const withoutExtension = (file: string) => file.slice(0, -path.extname(file).length);

/**
 * Reads the specs and mocks under `root` (the workspace directory). Spec files added by hand are
 * named after the file; a mock file that is not valid YAML is an error naming it.
 */
export async function readApiFiles(
  root: string,
  entries: unknown,
): Promise<{
  specs: ApiSpec[];
  mocks: MockServer[];
  library: ScriptModule[];
  files: CollectionFiles;
}> {
  const files: CollectionFiles = new Map();
  const known = new Map(
    (Array.isArray(entries) ? (entries as Partial<SpecEntry>[]) : [])
      .filter((entry) => entry && typeof entry.file === 'string')
      .map((entry) => [entry.file!.toLowerCase(), entry]),
  );
  const specs: ApiSpec[] = [];
  const ids = new Set<string>();
  for (const file of await list(path.join(root, SPECS_DIRECTORY), SPEC_EXTENSIONS)) {
    const relative = posix(SPECS_DIRECTORY, file);
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    files.set(relative, content);
    const entry = known.get(file.toLowerCase());
    let id = typeof entry?.id === 'string' && entry.id ? entry.id : randomUUID();
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    const extension = path.extname(file).toLowerCase();
    specs.push({
      id,
      name:
        typeof entry?.name === 'string' && entry.name.trim() ? entry.name : withoutExtension(file),
      // The file's extension says how it is saved; a .yml file is saved again as .yaml.
      format: extension === '.json' ? 'json' : extension === '.yaml' ? 'yaml' : specFormat(content),
      content,
      ...(typeof entry?.collection === 'string' && entry.collection
        ? { collection: entry.collection }
        : {}),
    });
  }
  const mocks: MockServer[] = [];
  const mockIds = new Set<string>();
  for (const file of await list(path.join(root, MOCKS_DIRECTORY), ['.yaml', '.yml'])) {
    const relative = posix(MOCKS_DIRECTORY, file);
    const text = await fs.readFile(path.join(root, relative), 'utf8');
    let value: unknown;
    try {
      value = parse(text);
    } catch (error) {
      throw new Error(`Could not read ${file}: ${(error as Error).message}`, { cause: error });
    }
    const mock = normalizeMock(value, withoutExtension(file));
    if (!mock) continue;
    if (mockIds.has(mock.id)) mock.id = randomUUID();
    mockIds.add(mock.id);
    files.set(relative, text);
    mocks.push(mock);
  }
  const library = await readScriptLibrary(root);
  for (const [file, text] of library.files) files.set(file, text);
  return { specs, mocks, library: library.modules, files };
}

/**
 * The library modules under `root`'s scripts folder, by file name. A file whose name is not a
 * module name is left alone: it may belong to something else.
 */
export async function readScriptLibrary(
  root: string,
): Promise<{ modules: ScriptModule[]; files: CollectionFiles }> {
  const files: CollectionFiles = new Map();
  const found: ScriptModule[] = [];
  for (const file of await list(path.join(root, SCRIPTS_DIRECTORY), ['.js'])) {
    const name = withoutExtension(file);
    if (!MODULE_NAME.test(name)) continue;
    const relative = posix(SCRIPTS_DIRECTORY, file);
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    files.set(relative, source);
    found.push({ name, source });
  }
  return { modules: normalizedLibrary(found) ?? [], files };
}
