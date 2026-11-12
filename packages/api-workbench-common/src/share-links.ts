/**
 * Links used to share collections: links to a collection file or gist to import, and Git remote
 * URLs for team folders. Shared by the app, which checks what a person types, and the main
 * process, which checks again before using it.
 */

/** Where to download a collection link from: a gist through GitHub's API, or a file. */
export type CollectionLink =
  | { kind: 'gist'; id: string; api: string; source: string }
  | { kind: 'file'; url: string; name: string; source: string };

const MAX_LINK = 2048;

/** Removes user names, passwords, and tokens written into URLs, wherever they are in `text`. */
export function withoutCredentials(text: string): string {
  return text.replace(/\b([a-z][\w+.-]*:\/\/)[^\s/@'"]+@/gi, '$1');
}

/** A file name from the last part of a URL's path. */
function fileName(url: URL): string {
  // eslint-disable-next-line no-control-regex -- Control characters are not allowed in file names.
  const unsafe = /[\\/:*?"<>|\u0000-\u001f]/g;
  const encoded = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  let last = encoded;
  try {
    last = decodeURIComponent(encoded);
  } catch {
    // A malformed escape: keep the name as written.
  }
  return last.replace(unsafe, '_') || 'collection';
}

/**
 * How to download a link to a collection, or an error saying what is wrong with it. Page links on
 * GitHub, GitLab, and Bitbucket become their raw file links, and gist links go through GitHub's
 * API so every file in the gist is imported.
 */
export function collectionLink(input: string): CollectionLink {
  const text = input.trim();
  if (!text) throw new Error('Enter a link to a collection.');
  if (text.length > MAX_LINK) throw new Error('Use a link of 2,048 characters or fewer.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Enter a full link, starting with https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only http:// and https:// links can be imported.');
  if (url.username || url.password)
    throw new Error('Remove the user name and password from the link.');
  url.hash = '';
  const source = url.href;
  const parts = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  // gist.github.com/<user>/<id>, gist.github.com/<id>, and their /raw links.
  if (host === 'gist.github.com') {
    const id = parts.find((part) => /^[0-9a-f]{20,40}$/i.test(part));
    if (!id) throw new Error('That gist link has no gist ID in it.');
    return { kind: 'gist', id, api: `https://api.github.com/gists/${id}`, source };
  }
  // github.com/<owner>/<repo>/blob/<ref>/<path> → raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  if (host === 'github.com' && parts.length > 4 && (parts[2] === 'blob' || parts[2] === 'raw')) {
    const raw = new URL(
      `https://raw.githubusercontent.com/${[parts[0], parts[1], ...parts.slice(3)].join('/')}`,
    );
    return { kind: 'file', url: raw.href, name: fileName(raw), source };
  }
  // GitLab (gitlab.com or a self-hosted one whose path has /-/blob/): /-/blob/ → /-/raw/
  const blob = parts.indexOf('-');
  if (blob > 1 && parts[blob + 1] === 'blob' && parts.length > blob + 3) {
    const raw = new URL(url.href);
    raw.pathname = `/${[...parts.slice(0, blob), '-', 'raw', ...parts.slice(blob + 2)].join('/')}`;
    return { kind: 'file', url: raw.href, name: fileName(raw), source };
  }
  // bitbucket.org/<workspace>/<repo>/src/<ref>/<path> → …/raw/<ref>/<path>
  if (host === 'bitbucket.org' && parts.length > 4 && parts[2] === 'src') {
    const raw = new URL(
      `https://bitbucket.org/${[parts[0], parts[1], 'raw', ...parts.slice(3)].join('/')}`,
    );
    return { kind: 'file', url: raw.href, name: fileName(raw), source };
  }
  return { kind: 'file', url: url.href, name: fileName(url), source };
}

/**
 * What is wrong with a Git remote URL, or an empty string when it can be used. Allowed: https,
 * http, ssh, and git URLs, `user@host:path`, file URLs, and absolute paths to a repository (a
 * network share). Refused: transports that run commands (`ext::`), anything git could read as an
 * option, and passwords or tokens in the URL, which belong in git's credential manager.
 */
export function gitRemoteProblem(input: string): string {
  const url = input.trim();
  if (!url) return 'Enter the repository’s URL.';
  if (url.length > MAX_LINK) return 'Use a URL of 2,048 characters or fewer.';
  // eslint-disable-next-line no-control-regex -- Spaces and control characters are refused.
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'Remove spaces from the URL.';
  if (url.startsWith('-'))
    return 'Enter a repository URL, such as https://github.com/team/api.git.';
  if (url.includes('::')) return 'That kind of Git URL is not supported.';
  const scheme = /^([a-z][\w+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['https', 'http', 'ssh', 'git', 'file'].includes(scheme))
      return `${scheme}:// repositories are not supported. Use https://, ssh://, or git@host:path.`;
    if (scheme !== 'file') {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return 'Enter a valid repository URL.';
      }
      if (!parsed.hostname) return 'Enter a valid repository URL.';
      if (parsed.password)
        return 'Remove the password or token from the URL. Git asks your credential manager or SSH key instead.';
    }
    return '';
  }
  // user@host:path, as GitHub and others show for SSH.
  if (/^[\w.-]+@[\w.-]+:[^\\]+$/.test(url)) return '';
  // An absolute path on this computer or a network share.
  if (url.startsWith('/') || /^[a-z]:[\\/]/i.test(url) || url.startsWith('\\\\')) return '';
  return 'Enter a repository URL, such as https://github.com/team/api.git or git@github.com:team/api.git.';
}

/** A folder name for a clone, from the repository's URL: `…/team/orders-api.git` → `orders-api`. */
export function repositoryName(url: string): string {
  const last =
    url
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .at(-1) ?? '';
  const name = last
    .replace(/\.git$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+/, '');
  return name.slice(0, 80) || 'team-workspace';
}
