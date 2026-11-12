import { ownValue, setOwnValue } from './own';

/**
 * Folders inside collections. A request's `folder` is a path: its collection, then any folders,
 * joined by "/" (`Shop/Orders/Refunds`), the same form the importers and exporters use. Folders
 * exist through the requests in them, so a folder with no requests anywhere beneath it is gone.
 */
export const FOLDER_SEPARATOR = '/';

/** The collection a folder path belongs to: its first segment. */
export const collectionOf = (folder: string): string => folder.split(FOLDER_SEPARATOR)[0];
/** The folder's own name: its last segment. */
export const folderName = (folder: string): string => folder.split(FOLDER_SEPARATOR).pop()!;
/** The folder that holds this one, or undefined for a collection. */
export function parentFolder(folder: string): string | undefined {
  const index = folder.lastIndexOf(FOLDER_SEPARATOR);
  return index < 0 ? undefined : folder.slice(0, index);
}
/** A path for display: `Shop/Orders` reads `Shop / Orders`. */
export const folderLabel = (folder: string): string => folder.split(FOLDER_SEPARATOR).join(' / ');
export const joinFolder = (parent: string, name: string): string =>
  `${parent}${FOLDER_SEPARATOR}${name}`;
/** The levels from the collection down to the folder itself: `A/B` gives `['A', 'A/B']`. */
export function folderChain(folder: string): string[] {
  const segments = folder.split(FOLDER_SEPARATOR);
  return segments.map((_, index) => segments.slice(0, index + 1).join(FOLDER_SEPARATOR));
}
/** True when `folder` is `ancestor` or sits anywhere inside it. */
export const isWithin = (folder: string, ancestor: string): boolean =>
  folder === ancestor || folder.startsWith(ancestor + FOLDER_SEPARATOR);
/** The path with `from` (and everything inside it) moved to `to`; other paths are unchanged. */
export const moveFolderPath = (folder: string, from: string, to: string): string =>
  isWithin(folder, from) ? to + folder.slice(from.length) : folder;
/**
 * What a map keyed by folder path (collection tags, scripts, auth) holds for exactly this folder.
 * Only the map's own entries count: a collection named "constructor" or "__proto__" must not
 * find Object's built-ins and treat them as its settings.
 */
export const folderEntry: <T>(
  map: Readonly<Record<string, T>> | undefined,
  folder: string,
) => T | undefined = ownValue;
/** Sets a folder's entry; defined rather than assigned, so "__proto__" is kept like any name. */
export const setFolderEntry: <T>(map: Record<string, T>, folder: string, value: T) => void =
  setOwnValue;
/** Why a folder or collection name cannot be used, or undefined when it can. */
export function folderNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'Enter a name.';
  if (name.length > 120) return 'Use 120 characters or fewer.';
  if (name.includes(FOLDER_SEPARATOR)) return `Names cannot contain “${FOLDER_SEPARATOR}”.`;
  return undefined;
}

export interface FolderNode<T> {
  /** The full path, such as `Shop/Orders`. */
  path: string;
  name: string;
  folders: FolderNode<T>[];
  /** The requests directly in this folder, in workspace order. */
  requests: T[];
  /** Requests here and in every folder inside. */
  total: number;
}

/**
 * The collections as a tree, in order of first appearance. A folder lists its folders before its
 * requests; folders with no requests of their own (only deeper ones) still appear.
 */
export function folderTree<T extends { folder: string }>(requests: readonly T[]): FolderNode<T>[] {
  const roots: FolderNode<T>[] = [];
  const nodes = new Map<string, FolderNode<T>>();
  const node = (path: string): FolderNode<T> => {
    let found = nodes.get(path);
    if (found) return found;
    found = { path, name: folderName(path), folders: [], requests: [], total: 0 };
    nodes.set(path, found);
    const parent = parentFolder(path);
    (parent === undefined ? roots : node(parent).folders).push(found);
    return found;
  };
  for (const request of requests) {
    node(request.folder).requests.push(request);
    for (
      let path: string | undefined = request.folder;
      path !== undefined;
      path = parentFolder(path)
    )
      node(path).total++;
  }
  return roots;
}

/** Every folder path, collections included, in tree order. */
export function folderPaths(roots: readonly FolderNode<unknown>[]): string[] {
  return roots.flatMap((root) => [root.path, ...folderPaths(root.folders)]);
}
