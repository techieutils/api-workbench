import { fetch } from 'undici';
import type { LinkImport } from '@techieutils/api-workbench-common/types';
import { collectionLink, withoutCredentials } from '@techieutils/api-workbench-common/share-links';
import { transportErrorMessage } from './http';

/**
 * Downloads a collection from a link for the import dialog: a gist (every file in it), a file on
 * GitHub, GitLab, or Bitbucket (by its raw link), or any http(s) URL. The files go back to the app
 * as bytes and are parsed there like chosen files, by the same fixed-grammar importers; nothing in
 * them is run. Public links only: no credentials are sent.
 */

/** The same limit as files chosen in the import dialog. */
export const LINK_IMPORT_LIMIT = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_GIST_FILES = 100;

type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}>;

/** A response body, refusing it once it passes the limit (whatever Content-Length says). */
async function download(
  url: string,
  get: Fetch,
  signal: AbortSignal,
  accept = '*/*',
): Promise<Uint8Array> {
  let response;
  try {
    response = await get(url, {
      headers: { accept, 'user-agent': 'API-Workbench' },
      signal,
    });
  } catch (error) {
    throw new Error(
      signal.aborted
        ? 'The link took longer than 30 seconds to download.'
        : `Could not download the link: ${transportErrorMessage(error as Error)}`,
      { cause: error },
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 404 || response.status === 403 || response.status === 401
        ? `The link answered ${response.status}. Only public links can be imported; for a private repository, use Git sync or download the file.`
        : `The link answered ${response.status}.`,
    );
  if (Number(response.headers.get('content-length') ?? 0) > LINK_IMPORT_LIMIT)
    throw new Error('The file is larger than 10 MB.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > LINK_IMPORT_LIMIT) throw new Error('The file is larger than 10 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface GistFile {
  filename?: unknown;
  content?: unknown;
  truncated?: unknown;
  raw_url?: unknown;
}

export async function importLink(
  input: unknown,
  get: Fetch = fetch as unknown as Fetch,
): Promise<LinkImport> {
  if (typeof input !== 'string') throw new Error('Enter a link to a collection.');
  const link = collectionLink(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    if (link.kind === 'file')
      return {
        source: withoutCredentials(link.source),
        files: [{ name: link.name, data: await download(link.url, get, controller.signal) }],
      };
    const text = new TextDecoder().decode(
      await download(link.api, get, controller.signal, 'application/vnd.github+json'),
    );
    let gist: { files?: Record<string, GistFile> };
    try {
      gist = JSON.parse(text) as typeof gist;
    } catch {
      throw new Error('GitHub sent something other than a gist.');
    }
    const entries = Object.values(gist.files ?? {}).slice(0, MAX_GIST_FILES);
    if (!entries.length) throw new Error('The gist has no files.');
    const files: LinkImport['files'] = [];
    let total = 0;
    for (const entry of entries) {
      const name = typeof entry.filename === 'string' ? entry.filename : 'gist-file';
      // GitHub cuts long files short in the API answer; their raw link has the whole file.
      const data =
        entry.truncated === true || typeof entry.content !== 'string'
          ? typeof entry.raw_url === 'string' && /^https:\/\//.test(entry.raw_url)
            ? await download(entry.raw_url, get, controller.signal)
            : new Uint8Array()
          : new TextEncoder().encode(entry.content);
      total += data.byteLength;
      if (total > LINK_IMPORT_LIMIT) throw new Error('The gist is larger than 10 MB.');
      files.push({ name, data });
    }
    return { source: link.source, files };
  } finally {
    clearTimeout(timer);
  }
}
