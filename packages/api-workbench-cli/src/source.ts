import { normalizedLibrary, normalizedScripts } from '@techieutils/api-workbench-common/scripts';
import { normalizedFolderTags, normalizedTags } from '@techieutils/api-workbench-common/tags';
import { readScriptLibrary } from '@techieutils/api-workbench-electron/api-files';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCollectionFiles } from '@techieutils/api-workbench-electron/collection-files';
import { readTeamFiles, TEAM_FORMAT } from '@techieutils/api-workbench-electron/team-files';
import { importFiles } from '@techieutils/api-workbench-common/collection-transfer';
import { httpFileReferences } from '@techieutils/api-workbench-common/collection-formats/text-formats';
import { REQUEST_PROTOCOLS } from '@techieutils/api-workbench-common/types';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { UsageError } from './args';
import type { RequestTarget } from './target';

/** What a run works from: the workspace's requests, environments, and collection defaults. */
export interface Source {
  name: string;
  kind: 'team folder' | 'workspace folder' | 'collection file';
  workspace: Pick<
    WorkspaceState,
    | 'requests'
    | 'environments'
    | 'collectionAuth'
    | 'collectionHttpSettings'
    | 'collectionScripts'
    | 'workspaceScripts'
    | 'scriptLibrary'
    | 'collectionTags'
    | 'settings'
    | 'clientCertificates'
  > & { cookies: boolean };
  warnings: string[];
  /**
   * The files a `.http` file's requests send (`< ./path` bodies and multipart parts), by request
   * id: paths as written, with their `{{variables}}`, filled in and resolved against `folder`, the
   * file's own, when each request is sent. `templates` are those whose text gets its variables
   * filled too (`<@`): `''` for the body, else a field's name.
   */
  fileUploads?: Record<string, FileUploads>;
  /**
   * The app's credential vault, for requests with a saved credential: opened the first time one
   * is needed, with the vault's password. Absent for team folders and files, which keep none.
   */
  credentials?: {
    get(id: string): Promise<import('@techieutils/api-workbench-common/types').CredentialRecord>;
  };
}

/** A request with its scripts kept only as text, and no `scripts` key when it has none. */
function withCheckedScripts<T extends { scripts?: unknown; tags?: unknown }>(request: T): T {
  const { scripts: written, tags: writtenTags, ...fields } = request;
  const scripts = normalizedScripts(written);
  const tags = normalizedTags(writtenTags);
  return { ...fields, ...(scripts ? { scripts } : {}), ...(tags ? { tags } : {}) } as T;
}
const IMPORT_LIMIT = 10 * 1024 * 1024;
/** A request from an import, with what the app fills in for fields the format leaves out. */
export function completeRequest(item: Partial<ApiRequest>): ApiRequest {
  return {
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
    folder: 'Imported',
    name: 'Imported request',
    response: null,
    // Scripts are run, so only text is kept from a file.
    ...withCheckedScripts(item),
    id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
  } as ApiRequest;
}

/** A team or workspace folder as saved by the app; the message says what is missing. */
async function readFolder(folder: string): Promise<Source> {
  const file = path.join(folder, 'workspace.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new UsageError(
      `${folder} has no workspace.json. Give a team workspace folder, a workspace folder, or a collection file.`,
    );
  }
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  // Saved before collections had their own files: everything is in workspace.json.
  if (Array.isArray(saved.requests)) {
    const state = saved as unknown as WorkspaceState;
    return {
      name: state.settings?.workspaceName || path.basename(folder),
      kind: 'workspace folder',
      workspace: {
        ...state,
        requests: state.requests.map(withCheckedScripts),
        scriptLibrary: normalizedLibrary(state.scriptLibrary),
        collectionTags: normalizedFolderTags(state.collectionTags),
        cookies: state.cookieJar?.enabled !== false,
      },
      warnings: [],
    };
  }
  const collections = await readCollectionFiles(folder, saved.collectionOrder);
  const team = saved.storage === TEAM_FORMAT;
  const environments = team
    ? // The member only decides whose history is "yours", which a run does not read.
      (await readTeamFiles(folder, saved.environmentOrder, { id: '', name: '' })).environments
    : ((saved.environments as WorkspaceState['environments']) ?? []);
  const settings = team ? undefined : (saved.settings as WorkspaceState['settings']);
  return {
    name:
      (team ? (saved.name as string) : settings?.workspaceName) ||
      path.basename(path.resolve(folder)),
    kind: team ? 'team folder' : 'workspace folder',
    workspace: {
      requests: collections.requests,
      environments,
      collectionAuth: collections.collectionAuth,
      collectionScripts: collections.collectionScripts,
      collectionTags: collections.collectionTags,
      // The workspace's scripts, kept in workspace.json in both kinds of folder.
      workspaceScripts: normalizedScripts(saved.workspaceScripts),
      scriptLibrary: (await readScriptLibrary(folder)).modules,
      collectionHttpSettings: collections.collectionHttpSettings,
      settings,
      cookies: (saved.cookieJar as WorkspaceState['cookieJar'])?.enabled !== false,
    },
    warnings: [],
  };
}
/** A collection file in any format the app imports. */
async function readFile(file: string): Promise<Source> {
  // One handle for the size check and the read, so the file cannot be swapped between them.
  const handle = await fs.open(file, 'r');
  let data: Buffer;
  try {
    if ((await handle.stat()).size > IMPORT_LIMIT)
      throw new UsageError('Collection files must be smaller than 10 MB.');
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  const result = importFiles([{ name: path.basename(file), data }]);
  const fileUploads = /\.(http|rest)$/i.test(file)
    ? uploadsOfHttpFile(data.toString('utf8'), path.dirname(path.resolve(file)))
    : undefined;
  // Formats without ids (.http, cURL) get their position, so a request can be named by it, and the
  // same file gives the same ids every time it is read.
  const requests = result.data.requests
    .filter((item) => !item.protocol || REQUEST_PROTOCOLS.includes(item.protocol))
    .map((item, index) => completeRequest({ ...item, id: item.id || String(index + 1) }));
  if (!requests.length) throw new UsageError(`${file} has no requests to run.`);
  return {
    name: path.basename(file).replace(/\.[^.]+$/, ''),
    kind: 'collection file',
    workspace: {
      requests,
      environments: result.data.environments ?? [],
      collectionHttpSettings: result.data.collectionHttpSettings,
      // Scripts are run, so only text is kept from a file.
      workspaceScripts: normalizedScripts(result.data.workspaceScripts),
      scriptLibrary: normalizedLibrary(result.data.scriptLibrary),
      collectionTags: normalizedFolderTags(result.data.collectionTags),
      collectionScripts: Object.fromEntries(
        Object.entries(result.data.collectionScripts ?? {}).flatMap(([folder, value]) => {
          const scripts = normalizedScripts(value);
          return scripts ? [[folder, scripts]] : [];
        }),
      ),
      settings: result.data.settings as WorkspaceState['settings'],
      cookies: true,
    },
    warnings: result.warnings,
    ...(fileUploads ? { fileUploads } : {}),
  };
}

/** A `.http` request's files: paths as written, and the folder they are relative to. */
export interface FileUploads {
  folder: string;
  binary?: string;
  fields: Record<string, string>;
  templates?: string[];
}

/** A `.http` file's `< ./path` references, by request id (its position). */
function uploadsOfHttpFile(text: string, folder: string): Source['fileUploads'] {
  const uploads: NonNullable<Source['fileUploads']> = {};
  httpFileReferences(text).forEach((references, index) => {
    if (references) uploads[String(index + 1)] = { folder, ...references };
  });
  return Object.keys(uploads).length ? uploads : undefined;
}
/** One of the app's workspaces, or a team folder, read the way the app reads it. */
export function sourceFromTarget(target: RequestTarget): Source {
  const { state } = target;
  return {
    name: target.name,
    kind:
      target.kind === 'team folder'
        ? 'team folder'
        : target.kind === 'collection file'
          ? 'collection file'
          : 'workspace folder',
    workspace: { ...state, cookies: state.cookieJar?.enabled !== false },
    warnings: [],
    ...(target.fileUploads ? { fileUploads: target.fileUploads } : {}),
  };
}
export async function readSource(source: string): Promise<Source> {
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new UsageError(`${source} was not found.`);
  }
  return stat.isDirectory() ? readFolder(source) : readFile(source);
}

/**
 * A collection file (`.http`, cURL, Postman, …) as a read-only workspace, for `request` commands
 * given `--file`: its requests, and its variables as the one environment. Nothing is saved.
 */
export async function openFileTarget(file: string, baseDir?: string): Promise<RequestTarget> {
  const source = await readSource(file);
  if (baseDir !== undefined) {
    if (
      !(await fs.stat(baseDir).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    )
      throw new UsageError(`--base-dir ${baseDir} is not a folder.`);
    for (const uploads of Object.values(source.fileUploads ?? {}))
      uploads.folder = path.resolve(baseDir);
  }
  if (source.kind !== 'collection file')
    throw new UsageError(`${file} is a folder: give it with --dir, or give a collection file.`);
  const { cookies: _cookies, ...workspace } = source.workspace;
  return {
    kind: 'collection file',
    name: source.name,
    ...(source.fileUploads ? { fileUploads: source.fileUploads } : {}),
    state: { ...workspace, tabs: [], environment: 0, history: [] } as WorkspaceState,
    save: () => {
      throw new UsageError('A collection file given with --file is only read, never changed.');
    },
  };
}
