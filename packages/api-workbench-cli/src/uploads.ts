import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApiRequest, UploadData } from '@techieutils/api-workbench-common/types';
import { UsageError, suggest, type Uploads } from './args';

/**
 * Files sent with requests: read from disk for a send or a run, never saved in the workspace,
 * which keeps only their names, as the app does.
 */

/** The most a file sent with a request may be, as in the app. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** The type a file is sent as, by its extension, as a browser would choose it. */
const UPLOAD_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};
export async function readUpload(file: string): Promise<UploadData> {
  // Checked and read through one open handle, so the file cannot be swapped for another, larger
  // one between the check and the read.
  const handle = await fs.open(file, 'r').catch(() => undefined);
  if (!handle) throw new UsageError(`No file ${file}.`);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UsageError(`No file ${file}.`);
    if (info.size > MAX_UPLOAD_BYTES)
      throw new UsageError(
        `${path.basename(file)} is larger than 20 MB, the most a request sends.`,
      );
    const name = path.basename(file);
    const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const data = await handle.readFile();
    if (data.length > MAX_UPLOAD_BYTES)
      throw new UsageError(`${name} is larger than 20 MB, the most a request sends.`);
    return {
      name,
      type: UPLOAD_TYPES[extension] ?? 'application/octet-stream',
      base64: data.toString('base64'),
    };
  } finally {
    await handle.close();
  }
}

/**
 * The folder a shared file's paths must stay inside: the repository it is in (the nearest folder
 * above it holding `.git`), or its own folder when it is in none.
 */
export async function projectRoot(folder: string): Promise<string> {
  const start = await fs.realpath(folder).catch(() => path.resolve(folder));
  for (let at = start; ;) {
    if (
      await fs.stat(path.join(at, '.git')).then(
        () => true,
        () => false,
      )
    )
      return at;
    const parent = path.dirname(at);
    if (parent === at) return start;
    at = parent;
  }
}

/**
 * Reads a file that a `.http` file names. It comes with a repository, and is sent wherever the
 * request goes, so a path may not leave the project: not absolute
 * elsewhere, not `../` above it, and not through a link that points outside it, such as one to
 * `~/.ssh`. Files named on the command line itself (`--binary-file`, `--form-file`) are the
 * person's own choice, as is `--uploads`, and are read with `readUpload` directly.
 */
export async function readProjectUpload(folder: string, written: string): Promise<UploadData> {
  const root = await projectRoot(folder);
  const wanted = path.resolve(folder, written);
  const real = await fs.realpath(wanted).catch(() => undefined);
  if (!real) throw new UsageError(`No file ${wanted}.`);
  const inside = path.relative(root, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside))
    throw new UsageError(
      `${written} is outside ${root}: a file a request names must be in its project. Give it with --binary-file or --form-file instead.`,
    );
  return readUpload(real);
}

/**
 * The files a run sends, from a JSON file (`run --uploads <file>`): each request by name or id,
 * with the path of its file body, or an object of its form file fields' paths by field name.
 * Paths are relative to the JSON file's folder, so one checked in beside a workspace works anywhere:
 *
 *   { "Import": "export.csv", "Upload avatar": { "avatar": "photo.png" } }
 */
export async function uploadsFromFile(
  file: string,
  requests: readonly Pick<ApiRequest, 'id' | 'name'>[],
): Promise<Record<string, Uploads>> {
  let given: unknown;
  try {
    given = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new UsageError(
      `--uploads ${file}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : 'not JSON'}.`,
    );
  }
  if (!given || typeof given !== 'object' || Array.isArray(given))
    throw new UsageError(
      '--uploads reads JSON: {"<request>": "<path>"} for a file body, or {"<request>": {"<field>": "<path>"}} for form file fields.',
    );
  const folder = path.dirname(path.resolve(file));
  // The person names this file on the command line (VS Code writes one for files chosen in its
  // file dialog), so its paths are their choice, as --binary-file's are: read wherever they are.
  const at = (where: string) => readUpload(path.resolve(folder, where));
  const uploads: Record<string, Uploads> = {};
  for (const [wanted, value] of Object.entries(given as Record<string, unknown>)) {
    const request =
      requests.find((item) => item.id === wanted) ?? requests.find((item) => item.name === wanted);
    if (!request)
      throw new UsageError(
        `--uploads names no request “${wanted}”.${suggest(
          wanted,
          requests.map((item) => item.name),
        )}`,
      );
    const entry: Uploads = uploads[request.id] ?? { fields: {} };
    if (typeof value === 'string') entry.binary = await at(value);
    else if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [field, where] of Object.entries(value as Record<string, unknown>)) {
        if (typeof where !== 'string')
          throw new UsageError(`--uploads: “${wanted}” → “${field}” is a path.`);
        entry.fields[field] = await at(where);
      }
    else throw new UsageError(`--uploads: “${wanted}” is a path, or fields' paths by name.`);
    uploads[request.id] = entry;
  }
  return uploads;
}
