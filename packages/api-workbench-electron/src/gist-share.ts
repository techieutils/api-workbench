import { fetch } from 'undici';
import type {
  CredentialRecord,
  GistPublishInput,
  GistPublishResult,
} from '@techieutils/api-workbench-common/types';
import { transportErrorMessage } from './http';

/**
 * Publishes an export to a GitHub gist, or updates one. The token is a saved Bearer token
 * credential in the vault, restricted to GitHub's API origin (`https://api.github.com`, or a GitHub
 * Enterprise Server's own origin, whose API is under `/api/v3`); it is read here and sent only to
 * that origin, never to the app. What is published is the export the app built, which already
 * leaves out secrets; it is refused if the token itself appears in it.
 */

const MAX_FILES = 20;
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
export const GITHUB_API_ORIGIN = 'https://api.github.com';

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The GitHub API base for a credential's origin, or why it cannot be used for gists. */
export function gistAPI(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Choose a GitHub token whose allowed origin is https://api.github.com.');
  }
  if (url.protocol !== 'https:')
    throw new Error('GitHub tokens must be restricted to an https:// origin.');
  return url.origin === GITHUB_API_ORIGIN ? GITHUB_API_ORIGIN : `${url.origin}/api/v3`;
}

/** Checks what the app sent: files, description, visibility, and the gist to update. */
export function checkedGistInput(input: unknown): GistPublishInput {
  const value = (input ?? {}) as Partial<GistPublishInput>;
  if (typeof value.credentialId !== 'string' || !value.credentialId)
    throw new Error('Choose a GitHub token.');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES)
    throw new Error(`Publish from 1 to ${MAX_FILES} files.`);
  let size = 0;
  const names = new Set<string>();
  const files = value.files.map((file) => {
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    if (!name || name.length > 100 || /[\\/\p{Cc}]/u.test(name) || names.has(name))
      throw new Error('Each gist file needs its own name, without slashes.');
    if (typeof file.content !== 'string' || !file.content)
      throw new Error(`${name} is empty; gists cannot hold empty files.`);
    names.add(name);
    size += Buffer.byteLength(file.content);
    return { name, content: file.content };
  });
  if (size > MAX_BYTES) throw new Error('Gists published from the app must be under 10 MB.');
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  if (description.length > 1000) throw new Error('Use a description of 1,000 characters or fewer.');
  if (value.gistId !== undefined && !/^[0-9a-f]{20,40}$/i.test(String(value.gistId)))
    throw new Error('That is not a gist ID.');
  return {
    credentialId: value.credentialId,
    files,
    description,
    public: value.public === true,
    ...(value.gistId ? { gistId: String(value.gistId) } : {}),
  };
}

/** GitHub's reason, in words a person can act on. */
function failure(status: number, body: string, updating: boolean): Error {
  let message = '';
  try {
    message = String((JSON.parse(body) as { message?: unknown }).message ?? '');
  } catch {
    /* Not JSON. */
  }
  if (status === 401)
    return new Error('GitHub refused the token. Check that it is valid and has not expired.');
  if (status === 403 || (status === 404 && !updating))
    return new Error(
      'The token cannot create gists. Use a classic token with the “gist” scope, or a fine-grained token with Gists: read and write.',
    );
  if (status === 404)
    return new Error('That gist was not found, or it belongs to another account.');
  if (status === 422) return new Error(`GitHub did not accept the gist: ${message || 'invalid'}.`);
  return new Error(`GitHub answered ${status}${message ? `: ${message}` : ''}.`);
}

export async function publishGist(
  input: GistPublishInput,
  record: CredentialRecord,
  get: Fetch = fetch as unknown as Fetch,
): Promise<GistPublishResult> {
  if (record.kind !== 'bearer' || !record.secret)
    throw new Error('Choose a saved Bearer token credential for GitHub.');
  const api = gistAPI(record.allowedOrigin);
  const token = record.secret;
  if (input.files.some((file) => file.content.includes(token)))
    throw new Error('The export contains the GitHub token itself, so it was not published.');
  const updating = Boolean(input.gistId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await get(updating ? `${api}/gists/${input.gistId}` : `${api}/gists`, {
      method: updating ? 'PATCH' : 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'API-Workbench',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        description: input.description,
        // Visibility is fixed when a gist is created; GitHub ignores it on updates.
        ...(updating ? {} : { public: input.public }),
        files: Object.fromEntries(
          input.files.map((file) => [file.name, { content: file.content }]),
        ),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      controller.signal.aborted
        ? 'GitHub took longer than a minute to answer.'
        : `Could not reach GitHub: ${transportErrorMessage(error as Error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) throw failure(response.status, text, updating);
  const gist = JSON.parse(text) as { id?: unknown; html_url?: unknown; public?: unknown };
  if (typeof gist.id !== 'string' || typeof gist.html_url !== 'string')
    throw new Error('GitHub answered without a gist.');
  return { id: gist.id, url: gist.html_url, public: gist.public === true, updated: updating };
}
