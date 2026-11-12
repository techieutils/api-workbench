import {
  describeTagFilter,
  effectiveTags,
  matchesTags,
  parseTags,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isWithin } from '@techieutils/api-workbench-common/folders';
import { specFromRequests } from '@techieutils/api-workbench-common/api-specs';
import {
  buildDocument,
  serialize,
  swaggerDocument,
} from '@techieutils/api-workbench-common/documentation';
import type { TeamGitResult } from '@techieutils/api-workbench-common/types';
import { TeamGit } from '@techieutils/api-workbench-electron/team-git';
import { sharedURL } from '@techieutils/api-workbench-electron/team-files';
import { UsageError, suggest } from './args';
import {
  confirm,
  findFolder,
  json,
  nameProblem,
  one,
  positionals,
  printable,
  table,
  type CommandContext,
  type Output,
  type Parsed,
} from './command-kit';
import type { Target } from './target';

/**
 * History, the cookie jar, team folder sync with git, and documentation: the parts of the app
 * that look after what a workspace has gathered, or share it.
 */

export async function historyCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  const { state } = target;
  if (sub === 'clear') {
    positionals(parsed, []);
    confirm(
      parsed,
      `${state.history.length} history ${state.history.length === 1 ? 'entry' : 'entries'}`,
    );
    // A team workspace's history is everyone's: only your own entries are yours to clear.
    state.history = state.history.filter((entry) => entry.author);
    await target.save();
    output.out('Cleared your history.');
    return 0;
  }
  positionals(parsed, []);
  const limitText = one(parsed, '--limit');
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1)
    throw new UsageError('--limit must be a whole number from 1.');
  const names = new Map(state.requests.map((request) => [request.id, request.name]));
  const rows = state.history.slice(0, limit).map((entry) => ({
    date: entry.date,
    method: entry.method,
    status: entry.status,
    timeMs: entry.time,
    url: sharedURL(entry.url),
    request: names.get(entry.requestId),
    ...(entry.author ? { author: entry.author.name } : {}),
  }));
  if (parsed.flags.has('--json')) return (json(output, rows), 0);
  table(
    [
      ['WHEN', 'METHOD', 'STATUS', 'TIME', 'URL'],
      ...rows.map((row) => [
        row.date.replace('T', ' ').slice(0, 19),
        row.method,
        row.status === undefined ? 'error' : String(row.status),
        row.timeMs === undefined ? '' : `${Math.round(row.timeMs)} ms`,
        `${row.url}${row.author ? `  (${row.author})` : ''}`,
      ]),
    ],
    output.out,
  );
  if (state.history.length > limit)
    output.out(`… ${state.history.length - limit} more; --limit shows more.`);
  return 0;
}

export async function cookieCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  const { state } = target;
  const jar = state.cookieJar ?? { enabled: true, cookies: [] };
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const domain = one(parsed, '--domain');
      // Cookie values are often sessions, so only their names and scope are shown.
      const rows = jar.cookies
        .filter(
          (cookie) => !domain || cookie.domain === domain || cookie.domain.endsWith(`.${domain}`),
        )
        .map((cookie) => ({
          domain: cookie.domain,
          name: cookie.name,
          path: cookie.path,
          expires: cookie.expires ? new Date(cookie.expires).toISOString() : 'session',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
        }));
      if (parsed.flags.has('--json'))
        return (json(output, { enabled: jar.enabled, cookies: rows }), 0);
      if (!jar.enabled) output.out('The cookie jar is off in this workspace.');
      table(
        [
          ['DOMAIN', 'NAME', 'PATH', 'EXPIRES'],
          ...rows.map((row) => [row.domain, row.name, row.path, row.expires]),
        ],
        output.out,
      );
      return 0;
    }
    case 'delete': {
      const [name] = positionals(parsed, ['name']);
      const domain = one(parsed, '--domain');
      const matches = jar.cookies.filter(
        (cookie) => cookie.name === name && (!domain || cookie.domain === domain),
      );
      if (!matches.length)
        throw new UsageError(
          `No cookie “${name}”.${suggest(
            name,
            jar.cookies.map((cookie) => cookie.name),
          )}`,
        );
      if (!domain && new Set(matches.map((cookie) => cookie.domain)).size > 1)
        throw new UsageError(
          `“${name}” is set for ${matches.map((cookie) => cookie.domain).join(', ')}: give --domain.`,
        );
      state.cookieJar = {
        ...jar,
        cookies: jar.cookies.filter((cookie) => !matches.includes(cookie)),
      };
      await target.save();
      output.out(`Deleted the cookie “${printable(name)}” for ${matches[0].domain}.`);
      return 0;
    }
    case 'clear': {
      positionals(parsed, []);
      confirm(parsed, `${jar.cookies.length} ${jar.cookies.length === 1 ? 'cookie' : 'cookies'}`);
      state.cookieJar = { ...jar, cookies: [] };
      await target.save();
      output.out('Cleared the cookie jar.');
      return 0;
    }
  }
  return 0;
}

function printGit(result: TeamGitResult, parsed: Parsed, output: Output): number {
  if (parsed.flags.has('--json')) return (json(output, result), result.conflicts?.length ? 1 : 0);
  const { status } = result;
  if (result.message) output.out(result.message);
  output.out(
    `${status.branch ?? 'no branch'}${status.upstream ? ` → ${status.upstream}` : ''}${status.ahead ? ` · ${status.ahead} to push` : ''}${status.behind ? ` · ${status.behind} to pull` : ''}`,
  );
  for (const change of status.changes)
    output.out(`  ${change.kind.padEnd(9)} ${printable(change.path)}`);
  if (status.changeCount > status.changes.length)
    output.out(`  … ${status.changeCount - status.changes.length} more`);
  for (const file of result.conflicts ?? []) output.out(`  conflict  ${printable(file)}`);
  if (result.conflicts?.length)
    output.out('Pull again with --keep mine or --keep theirs to choose.');
  return result.conflicts?.length ? 1 : 0;
}

export async function teamCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const folder = target.folder;
  if (!folder)
    throw new UsageError(
      `“${target.name}” is not a team workspace. Give a team workspace with -w, or its folder with --dir.`,
    );
  const git = new TeamGit();
  const member = await target.store.member();
  const keep = one(parsed, '--keep');
  if (keep !== undefined && keep !== 'mine' && keep !== 'theirs')
    throw new UsageError('--keep is mine or theirs.');
  const message = one(parsed, '--message');
  try {
    switch (sub) {
      case 'status': {
        positionals(parsed, []);
        const status = await git.status(folder);
        if (!status.available)
          throw new UsageError('git was not found. Install it to sync team folders.');
        if (!status.repository) throw new UsageError(`${folder} is not in a Git repository.`);
        return printGit({ status, message: '' }, parsed, output);
      }
      case 'commit':
        positionals(parsed, []);
        if (!message) throw new UsageError('Give a commit message with -m.');
        return printGit(await git.commit(folder, message, member), parsed, output);
      case 'pull':
        positionals(parsed, []);
        return printGit(await git.pull(folder, member, keep), parsed, output);
      case 'push':
        positionals(parsed, []);
        return printGit(await git.push(folder), parsed, output);
      case 'sync':
        positionals(parsed, []);
        if (!message) throw new UsageError('Give a commit message with -m for your changes.');
        return printGit(await git.sync(folder, message, member, keep), parsed, output);
    }
  } catch (error) {
    // git's own explanation, already stripped of credentials, is the message to show.
    if (error instanceof UsageError) throw error;
    output.err(`api-workbench: ${(error as Error).message}`);
    return 1;
  }
  return 0;
}

/** API documentation for a collection, as OpenAPI 3 (or Swagger 2): to print, save, or keep. */
export async function collectionDocs(
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  const [wanted] = positionals(parsed, ['collection']);
  const folder = findFolder(target.state, wanted);
  const format = one(parsed, '--format') ?? 'openapi';
  if (format !== 'openapi' && format !== 'swagger')
    throw new UsageError(
      `Documentation is openapi or swagger.${suggest(format, ['openapi', 'swagger'])}`,
    );
  // --tag and --exclude-tag document part of the collection, as a tag filter does in the app.
  const filter: TagFilter = {
    include: (parsed.values.get('--tag') ?? []).flatMap(parseTags),
    mode: parsed.flags.has('--all-tags') ? 'all' : 'any',
    exclude: (parsed.values.get('--exclude-tag') ?? []).flatMap(parseTags),
  };
  const requests = target.state.requests.filter(
    (request) =>
      isWithin(request.folder, folder) && matchesTags(effectiveTags(target.state, request), filter),
  );
  if (!requests.length)
    throw new UsageError(`No request in “${folder}” is tagged ${describeTagFilter(filter)}.`);
  // Operations carry each request's tags, with its collection's and folders', as the app's Docs do.
  const document = buildDocument(folder, requests, {
    tagsOf: (request) => effectiveTags(target.state, request),
  });
  const file = one(parsed, '--output');
  const asJson = parsed.flags.has('--json') || Boolean(file && /\.json$/i.test(file));
  const text = serialize(format === 'swagger' ? swaggerDocument(document) : document, !asJson);
  if (file) {
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fs.writeFile(file, text.endsWith('\n') ? text : `${text}\n`);
    output.err(
      `Wrote ${format === 'swagger' ? 'Swagger 2' : 'OpenAPI 3'} documentation for “${printable(folder)}” to ${file}.`,
    );
  } else output.out(text.trimEnd());
  return 0;
}

/** A specification made from a collection's requests, kept in the workspace beside it. */
export async function specFromCollection(
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  positionals(parsed, []);
  const wanted = one(parsed, '--collection');
  if (!wanted) throw new UsageError('Give the collection to describe with -c.');
  const folder = findFolder(target.state, wanted);
  const name = (one(parsed, '--name') ?? folder).trim();
  nameProblem(name, 'specification');
  const state = target.state;
  state.specs ??= [];
  if (state.specs.some((spec) => spec.name.toLowerCase() === name.toLowerCase()))
    throw new UsageError(`There is already a specification “${name}”. Give another with --name.`);
  const format = one(parsed, '--format') ?? 'yaml';
  if (format !== 'yaml' && format !== 'json') throw new UsageError('--format is yaml or json.');
  const content = specFromRequests(
    name,
    state.requests.filter((request) => isWithin(request.folder, folder)),
    format,
  );
  state.specs.push({ id: randomUUID(), name, format, content, collection: folder });
  await target.save();
  output.out(`Created the specification “${printable(name)}” from “${printable(folder)}”.`);
  return 0;
}
