import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { normalizedScripts } from '@techieutils/api-workbench-common/scripts';
import { normalizedTags } from '@techieutils/api-workbench-common/tags';
import type {
  ApiRequest,
  AuthConfig,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import {
  folderChain,
  folderEntry,
  folderName,
  parentFolder,
  setFolderEntry,
} from '@techieutils/api-workbench-common/folders';

/**
 * Collections on disk: a directory per collection and folder, and a YAML file per request.
 *
 *   collections/
 *     Posts/
 *       _collection.yaml    name, order of folders and requests, HTTP settings, default auth
 *       Get all posts.yaml  one request
 *       Drafts/
 *         _folder.yaml      the same, for a folder
 *
 * Names on disk are made safe for every platform; the real names are kept inside the files, so a
 * request called "a/b?" round-trips. The workspace file keeps everything else.
 */
export const COLLECTIONS_DIRECTORY = 'collections';
export const COLLECTION_FILE = '_collection.yaml';
export const FOLDER_FILE = '_folder.yaml';
const EXTENSION = '.yaml';
const FORMAT_VERSION = 1;

/** Per-collection and per-folder metadata, in `_collection.yaml` and `_folder.yaml`. */
interface FolderMetadata {
  version?: number;
  name?: string;
  /** Directory names of the folders inside, in explorer order. */
  folders?: string[];
  /** File names of the requests directly inside, in explorer order. */
  requests?: string[];
  httpSettings?: Partial<HTTPSettings>;
  auth?: AuthConfig;
  /** Scripts run around every request in the folder. */
  scripts?: { pre?: string; post?: string };
  /** Tags every request in the folder has. */
  tags?: string[];
}
/** A file's path relative to the workspace directory, with "/" separators. */
export type CollectionFiles = Map<string, string>;

// Characters Windows, macOS, or Linux reject in names, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** A name that every platform accepts as a file or directory name. */
export function safeFileName(name: string): string {
  let safe = name
    .replace(UNSAFE, '-')
    .trim()
    .replace(/[. ]+$/, '');
  if (!safe || safe === '.' || safe === '..') safe = 'Untitled';
  if (RESERVED.test(safe)) safe = `${safe}_`;
  return safe.slice(0, 80).replace(/[. ]+$/, '') || 'Untitled';
}
/**
 * A name not yet taken in a directory. Case is ignored, since macOS and Windows disks usually
 * treat "Users" and "users" as the same name.
 */
function uniqueName(base: string, extension: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `${n === 1 ? base : `${base} ${n}`}${extension}`;
    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return name;
    }
  }
}
const yaml = (value: unknown) => stringify(value, { lineWidth: 0 });
const posix = (...parts: string[]) => parts.join('/');

/** The request as saved: its folder comes from where the file is, its response stays out. */
function requestDocument(request: ApiRequest): Record<string, unknown> {
  const { folder, response, id, name, method, url, ...rest } = request;
  return { id, name, method, url, ...rest };
}

/**
 * The files for a workspace's collections, and each folder's directory. The collection order is
 * the directory names, in explorer order.
 */
export function collectionFiles(state: WorkspaceState): {
  files: CollectionFiles;
  directories: Map<string, string>;
  order: string[];
} {
  const files: CollectionFiles = new Map();
  const directories = new Map<string, string>();
  const metadata = new Map<string, FolderMetadata>();
  // Each directory's names in use, so siblings never collide.
  const taken = new Map<string, Set<string>>();
  const namesIn = (directory: string) => {
    let names = taken.get(directory);
    if (!names) taken.set(directory, (names = new Set([COLLECTION_FILE, FOLDER_FILE])));
    return names;
  };
  const order: string[] = [];
  /** The directory for a folder path, created (with its parents) the first time it is seen. */
  const directoryOf = (folder: string): string => {
    const known = directories.get(folder);
    if (known) return known;
    const parent = parentFolder(folder);
    const container = parent === undefined ? COLLECTIONS_DIRECTORY : directoryOf(parent);
    const name = uniqueName(safeFileName(folderName(folder)), '', namesIn(container));
    const directory = posix(container, name);
    directories.set(folder, directory);
    metadata.set(folder, {
      version: FORMAT_VERSION,
      name: folderName(folder),
      folders: [],
      requests: [],
    });
    if (parent === undefined) order.push(name);
    else metadata.get(parent)!.folders!.push(name);
    return directory;
  };
  for (const request of state.requests) {
    for (const folder of folderChain(request.folder)) directoryOf(folder);
    const directory = directoryOf(request.folder);
    const file = uniqueName(safeFileName(request.name), EXTENSION, namesIn(directory));
    metadata.get(request.folder)!.requests!.push(file);
    files.set(posix(directory, file), yaml(requestDocument(request)));
  }
  for (const [folder, data] of metadata) {
    const httpSettings = folderEntry(state.collectionHttpSettings, folder);
    const auth = folderEntry(state.collectionAuth, folder);
    const scripts = normalizedScripts(folderEntry(state.collectionScripts, folder));
    if (httpSettings && Object.keys(httpSettings).length) data.httpSettings = httpSettings;
    if (auth) data.auth = auth;
    if (scripts) data.scripts = scripts;
    const tags = normalizedTags(folderEntry(state.collectionTags, folder));
    if (tags) data.tags = tags;
    const file = parentFolder(folder) === undefined ? COLLECTION_FILE : FOLDER_FILE;
    files.set(posix(directories.get(folder)!, file), yaml(data));
  }
  return { files, directories, order };
}

/** A YAML file's text and its parsed value; a parse error names the file. */
async function readYAML(file: string): Promise<{ text: string; value: unknown }> {
  const text = await fs.readFile(file, 'utf8');
  try {
    return { text, value: parse(text) };
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
/** Names listed first, then any others found on disk, in alphabetical order. */
const ordered = (listed: unknown, found: string[]) => {
  const names = Array.isArray(listed) ? listed.filter((name) => found.includes(name)) : [];
  return [...new Set(names), ...found.filter((name) => !names.includes(name)).sort()];
};

/**
 * Reads the collections under `root` (the workspace directory) in explorer order. Request files
 * and folders added by hand are picked up after the listed ones; a request file without an id,
 * or with one already used, gets a new id.
 */
export async function readCollectionFiles(
  root: string,
  order: unknown,
): Promise<{
  requests: ApiRequest[];
  collectionHttpSettings: Record<string, Partial<HTTPSettings>>;
  collectionAuth: Record<string, AuthConfig>;
  collectionScripts: NonNullable<WorkspaceState['collectionScripts']>;
  collectionTags: Record<string, string[]>;
  files: CollectionFiles;
  directories: Map<string, string>;
  /** Request files given a new id, with their new text, for the caller to write back. */
  repaired: CollectionFiles;
}> {
  const requests: ApiRequest[] = [];
  const repaired: CollectionFiles = new Map();
  const collectionHttpSettings: Record<string, Partial<HTTPSettings>> = {};
  const collectionAuth: Record<string, AuthConfig> = {};
  const collectionScripts: NonNullable<WorkspaceState['collectionScripts']> = {};
  const collectionTags: Record<string, string[]> = {};
  const files: CollectionFiles = new Map();
  const directories = new Map<string, string>();
  const ids = new Set<string>();
  const list = async (directory: string) => {
    const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
    return {
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      requests: entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(EXTENSION) &&
            entry.name !== COLLECTION_FILE &&
            entry.name !== FOLDER_FILE,
        )
        .map((entry) => entry.name),
    };
  };
  const readFolder = async (directory: string, parent: string | undefined, depth: number) => {
    if (depth > 25) throw new Error('Collection folders exceed the supported depth.');
    const metadataFile = posix(directory, parent === undefined ? COLLECTION_FILE : FOLDER_FILE);
    let data: FolderMetadata = {};
    try {
      const { text, value } = await readYAML(path.join(root, metadataFile));
      files.set(metadataFile, text);
      data = (value as FolderMetadata) || {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const own = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
    const name = (own || path.posix.basename(directory)).replaceAll('/', '-');
    const folder = parent === undefined ? name : `${parent}/${name}`;
    directories.set(folder, directory);
    if (data.httpSettings && typeof data.httpSettings === 'object')
      setFolderEntry(collectionHttpSettings, folder, data.httpSettings);
    if (data.auth && typeof data.auth === 'object')
      setFolderEntry(collectionAuth, folder, data.auth);
    const scripts = normalizedScripts(data.scripts);
    if (scripts) setFolderEntry(collectionScripts, folder, scripts);
    const folderTags = normalizedTags(data.tags);
    if (folderTags) setFolderEntry(collectionTags, folder, folderTags);
    const found = await list(directory);
    // Folders before requests, the order the explorer shows (and the Runner runs) them in.
    for (const child of ordered(data.folders, found.folders))
      await readFolder(posix(directory, child), folder, depth + 1);
    for (const file of ordered(data.requests, found.requests)) {
      const relative = posix(directory, file);
      const { text, value } = await readYAML(path.join(root, relative));
      const document = value as Partial<ApiRequest> | null;
      if (!document || typeof document !== 'object') continue;
      let id = typeof document.id === 'string' && document.id ? document.id : '';
      if (!id || ids.has(id)) {
        // Give the file its own id, changing only that line, so it keeps it from now on.
        const repairedId = randomUUID();
        const fixed = id
          ? text.replace(/^id:.*$/m, `id: ${repairedId}`)
          : `id: ${repairedId}\n${text}`;
        repaired.set(relative, fixed);
        files.set(relative, fixed);
        id = repairedId;
      } else files.set(relative, text);
      ids.add(id);
      // Scripts are run, so only text is kept: anything else in a hand-edited file is dropped.
      const { scripts: written, tags: writtenTags, ...fields } = document;
      const scripts = normalizedScripts(written);
      const tags = normalizedTags(writtenTags);
      requests.push({
        params: [],
        headers: [],
        body: '',
        auth: 'None',
        token: '',
        username: '',
        password: '',
        tests: '',
        method: 'GET',
        url: '',
        ...fields,
        ...(scripts ? { scripts } : {}),
        ...(tags ? { tags } : {}),
        name: typeof document.name === 'string' ? document.name : file.slice(0, -EXTENSION.length),
        id,
        folder,
        response: null,
      } as ApiRequest);
    }
  };
  let collections: string[] = [];
  try {
    collections = (await list(COLLECTIONS_DIRECTORY)).folders;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const directory of ordered(order, collections))
    await readFolder(posix(COLLECTIONS_DIRECTORY, directory), undefined, 0);
  return {
    requests,
    collectionHttpSettings,
    collectionAuth,
    collectionScripts,
    collectionTags,
    files,
    directories,
    repaired,
  };
}

/**
 * Writes a file through a temporary file, so a crash never leaves it half written. Files are
 * private to you, except in a team folder (`shared`), where teammates on a network drive must be
 * able to read them, so the system's usual permissions apply.
 */
export async function writeAtomically(
  file: string,
  content: string,
  shared = false,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, ...(shared ? {} : { mode: 0o700 }) });
  await fs.writeFile(file + '.tmp', content, shared ? {} : { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}
/** Writes one collection file (a path relative to the workspace directory) atomically. */
export const writeCollectionFile = (root: string, file: string, content: string, shared = false) =>
  writeAtomically(path.join(root, file), content, shared);

/**
 * Brings the files on disk from `previous` to `next`: writes new and changed files, then removes
 * files the app wrote before that are no longer wanted, and directories left empty. Files the
 * app did not write are never touched.
 */
export async function syncCollectionFiles(
  root: string,
  previous: CollectionFiles,
  next: CollectionFiles,
  /** Files changed outside the app since it last saw them: neither written nor removed. */
  skip: ReadonlySet<string> = new Set(),
  /** A team folder: files keep the system's usual permissions so teammates can read them. */
  shared = false,
): Promise<void> {
  for (const [file, content] of next)
    if (previous.get(file) !== content && !skip.has(file))
      await writeAtomically(path.join(root, file), content, shared);
  // On disks that ignore case, "Users.yaml" and "users.yaml" are one file: a rename that only
  // changes case has just been written, so removing the old name would delete it.
  const kept = new Set([...next.keys()].map((file) => file.toLowerCase()));
  const emptied = new Set<string>();
  for (const file of previous.keys())
    if (!kept.has(file.toLowerCase()) && !skip.has(file)) {
      await fs.rm(path.join(root, file), { force: true });
      emptied.add(path.posix.dirname(file));
    }
  // Remove directories left empty, deepest first, up to the collections directory.
  const candidates = [...emptied].flatMap((directory) => {
    const chain: string[] = [];
    for (
      let current = directory;
      current.startsWith(COLLECTIONS_DIRECTORY + '/');
      current = path.posix.dirname(current)
    )
      chain.push(current);
    return chain;
  });
  for (const directory of [...new Set(candidates)].sort((a, b) => b.length - a.length))
    await fs.rmdir(path.join(root, directory)).catch(() => {});
}
