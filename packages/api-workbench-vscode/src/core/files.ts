import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Team workspace folders on disk: a folder whose `workspace.json` says `"storage": "team"`, as the
 * app writes it, with its requests as YAML files under `collections/`.
 */

/** Whether `workspaceJson` (a path to a workspace.json) belongs to a team workspace folder. */
export async function isTeamFolder(workspaceJson: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(workspaceJson, 'utf8')) as { storage?: unknown };
    return value.storage === 'team';
  } catch {
    return false;
  }
}

/** The team folder's name, as the app shows it: `workspace.json`'s name, else the folder's. */
export async function teamFolderName(folder: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path.join(folder, 'workspace.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof value.name === 'string' && value.name.trim()) return value.name;
  } catch {
    // Fall back to the folder's name.
  }
  return path.basename(folder);
}

/**
 * The YAML file of the request with `id` in a team folder, found by its `id:` line (file names
 * follow request names, which can repeat or change). Looks no deeper than the collections folder.
 */
export async function findRequestFile(folder: string, id: string): Promise<string | undefined> {
  const collections = path.join(folder, 'collections');
  const want = new RegExp(
    `^id:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`,
    'm',
  );
  const visit = async (directory: string, depth: number): Promise<string | undefined> => {
    if (depth > 12) return undefined;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(full, depth + 1);
        if (found) return found;
      } else if (/\.ya?ml$/.test(entry.name) && !entry.name.startsWith('_')) {
        const text = await readFile(full, 'utf8').catch(() => '');
        if (want.test(text.slice(0, 2000))) return full;
      }
    }
    return undefined;
  };
  return visit(collections, 0);
}
