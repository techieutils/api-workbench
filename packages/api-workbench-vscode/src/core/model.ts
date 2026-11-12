/**
 * What the extension shows, built from the command line's JSON: the sources (team workspace folders
 * in the editor's workspace, and the app's own workspaces), each with its collections, folders,
 * and requests in the order the app's explorer shows them.
 */

/** A team folder on disk, or one of the app's workspaces by id. */
export type Source =
  | {
      kind: 'team';
      folder: string;
      name: string;
      /** Open in the API Workbench app on this computer too: its saved credentials apply. */
      inApp?: boolean;
    }
  | { kind: 'app'; id: string; name: string; folder?: string };

/** A stable key for a source, for ids and remembered choices. */
export const sourceKey = (source: Source): string =>
  source.kind === 'team' ? `team:${source.folder}` : `app:${source.id}`;

/** The arguments that point a workspace command (`request`, `environment`) at a source. */
export const workspaceArgs = (source: Source): string[] =>
  source.kind === 'team' ? ['--dir', source.folder] : ['-w', source.id];

/** The arguments that point `run` and `list` at a source. */
export const runArgs = (source: Source): string[] =>
  source.kind === 'team' ? [source.folder] : ['-w', source.id];

/** `api-workbench list --json`. */
export interface ListOutput {
  name: string;
  kind: string;
  collections: string[];
  requests: ListedRequest[];
  environments: string[];
}
export interface ListedRequest {
  id: string;
  name: string;
  folder: string;
  method: string;
  protocol: string;
  runnable: boolean;
  tags?: string[];
}
/** `api-workbench environment list --json`. */
export interface ListedEnvironment {
  name: string;
  variables: number;
  active: boolean;
}
/** `api-workbench workspace list --json`. */
export interface ListedWorkspace {
  id: string;
  name: string;
  active: boolean;
  kind: 'local' | 'team';
  folder?: string;
}

export interface FolderNode {
  kind: 'folder';
  /** The full path, such as `Orders/Refunds`, as `-c` takes it. */
  path: string;
  name: string;
  children: Node[];
}
export interface RequestNode {
  kind: 'request';
  request: ListedRequest;
}
export type Node = FolderNode | RequestNode;

/**
 * Collections and their folders as a tree, keeping the requests' order. A request's folder path
 * (`Orders/Refunds`) makes its folders on the way; folders appear where their first request is.
 */
export function buildTree(list: ListOutput): FolderNode[] {
  const roots: FolderNode[] = [];
  const folders = new Map<string, FolderNode>();
  const folderAt = (path: string): FolderNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parts = path.split('/');
    const node: FolderNode = { kind: 'folder', path, name: parts[parts.length - 1], children: [] };
    folders.set(path, node);
    if (parts.length === 1) roots.push(node);
    else folderAt(parts.slice(0, -1).join('/')).children.push(node);
    return node;
  };
  // Collections first, in the app's order, so empty ones and their order survive.
  for (const collection of list.collections) if (!collection.includes('/')) folderAt(collection);
  for (const request of list.requests)
    folderAt(request.folder).children.push({ kind: 'request', request });
  return roots;
}

/** Every request under a node, in order. */
export function requestsUnder(node: Node): ListedRequest[] {
  return node.kind === 'request' ? [node.request] : node.children.flatMap(requestsUnder);
}

/** Every tag used in a source's requests, sorted, for the tag filter. */
export function tagsOf(list: ListOutput): string[] {
  return [...new Set(list.requests.flatMap((request) => request.tags ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** How a request is described beside its name: method or protocol, and its tags. */
export function requestDescription(request: ListedRequest): string {
  const kind = request.protocol === 'http' ? request.method : request.protocol;
  const tags = (request.tags ?? []).map((tag) => `#${tag}`).join(' ');
  return [kind, tags].filter(Boolean).join(' · ');
}

const BADGES = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
/**
 * The badge a request shows in the tree and on its editor tab (`media/methods/<badge>-<theme>.svg`):
 * its method, or its protocol for a live connection.
 */
export function badgeOf(request: Pick<ListedRequest, 'method' | 'protocol'>): string {
  if (request.protocol && request.protocol !== 'http') return request.protocol;
  const method = request.method.toLowerCase();
  return BADGES.has(method) ? method : 'other';
}
