import { folderChain, folderEntry, setFolderEntry } from './folders';

/**
 * Request tags: short labels such as `smoke`, `auth`, or `slow` on a request, for finding it and
 * for choosing what a collection run sends. A collection or folder can have tags too, which every
 * request inside it has as well. Tags compare without case, so `Smoke` and `smoke` are one tag;
 * each request or folder keeps the spelling it was given.
 */

/** A tag: a letter or digit, then letters, digits, `_`, `-`, `.`, `:`, or `/`; no spaces. */
export const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.:/-]{0,39}$/u;
export const TAG_LIMITS = { perRequest: 20, length: 40 };

/** Why a tag cannot be added to a request that has `existing` tags, or nothing when it can. */
export function tagProblem(tag: string, existing: readonly string[] = []): string | undefined {
  if (!tag) return 'Type a tag.';
  if (tag.length > TAG_LIMITS.length) return `Keep tags to ${TAG_LIMITS.length} characters.`;
  if (!TAG_PATTERN.test(tag))
    return 'Start with a letter or digit, then use letters, digits, - _ . : or /; no spaces.';
  const same = existing.find((other) => sameTag(other, tag));
  if (same) return `It is already tagged ${same}.`;
  if (existing.length >= TAG_LIMITS.perRequest)
    return `A request can have up to ${TAG_LIMITS.perRequest} tags.`;
  return undefined;
}
export const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Tags as read from a file or an import: valid ones only, without repeats, in order. */
export function normalizedTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/^#/, '');
    if (!tagProblem(tag, tags)) tags.push(tag);
  }
  return tags.length ? tags : undefined;
}
/** Tags typed into one field, separated by commas or spaces, with an optional leading #. */
export const parseTags = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean);

/** Which requests a run sends, by their tags. */
export interface TagFilter {
  /** Requests need these tags: any one of them, or all of them, as `mode` says. */
  include: string[];
  mode: 'any' | 'all';
  /** Requests with any of these are left out, whatever else they have. */
  exclude: string[];
}
export const emptyTagFilter = (): TagFilter => ({ include: [], mode: 'any', exclude: [] });
export const tagFilterActive = (filter: TagFilter | undefined): boolean =>
  Boolean(filter && (filter.include.length || filter.exclude.length));

/** Whether a request with these tags passes the filter; no filter passes everything. */
export function matchesTags(tags: readonly string[] | undefined, filter?: TagFilter): boolean {
  if (!filter) return true;
  const has = (tag: string) => (tags ?? []).some((own) => sameTag(own, tag));
  if (filter.exclude.some(has)) return false;
  if (!filter.include.length) return true;
  return filter.mode === 'all' ? filter.include.every(has) : filter.include.some(has);
}

/** The filter in words, for a run plan or report: "smoke or auth, not slow". */
export function describeTagFilter(filter: TagFilter): string {
  const parts: string[] = [];
  if (filter.include.length)
    parts.push(filter.include.join(filter.mode === 'all' ? ' and ' : ' or '));
  if (filter.exclude.length) parts.push(`not ${filter.exclude.join(' or ')}`);
  return parts.join(', ');
}

/**
 * Every tag on these requests with how many have it, by name without case; each is spelled as
 * it first appears.
 */
export function tagCounts(
  requests: readonly { tags?: readonly string[] }[],
): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const request of requests)
    for (const tag of request.tags ?? []) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tag, count: 1 });
    }
  return [...counts.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }),
  );
}

/** The parts of a workspace and a request that tags are read from. */
type TagSource = { collectionTags?: Record<string, string[]> };
type Tagged = { folder: string; tags?: string[] };

/** The tags a request has from its collection and folders, outermost first, with where each is from. */
export function inheritedTags(
  workspace: TagSource,
  folder: string,
): { tag: string; from: string }[] {
  const found: { tag: string; from: string }[] = [];
  for (const level of folderChain(folder))
    for (const tag of folderEntry(workspace.collectionTags, level) ?? [])
      if (!found.some((entry) => sameTag(entry.tag, tag))) found.push({ tag, from: level });
  return found;
}
/** Every tag a request has: its collection's and folders', then its own, each once. */
export function effectiveTags(workspace: TagSource, request: Tagged): string[] {
  const tags = inheritedTags(workspace, request.folder).map((entry) => entry.tag);
  for (const tag of request.tags ?? [])
    if (!tags.some((other) => sameTag(other, tag))) tags.push(tag);
  return tags;
}
/** Collection and folder tags as read from files or an import: valid ones only, by folder. */
export function normalizedFolderTags(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const tags: Record<string, string[]> = {};
  for (const [folder, list] of Object.entries(value as Record<string, unknown>)) {
    const valid = normalizedTags(list);
    if (folder && valid) setFolderEntry(tags, folder, valid);
  }
  return Object.keys(tags).length ? tags : undefined;
}

/** Where a tag stands in a filter: required, left out, or not used. */
export type TagFilterState = 'include' | 'exclude' | 'off';
export function tagFilterState(filter: TagFilter, tag: string): TagFilterState {
  if (filter.include.some((item) => sameTag(item, tag))) return 'include';
  if (filter.exclude.some((item) => sameTag(item, tag))) return 'exclude';
  return 'off';
}
/**
 * The filter after clicking a tag: off, to requiring it, to leaving it out, and back to off. The
 * same in the explorer and the Runner, so a tag behaves the same wherever it is clicked.
 */
export function cycleTagFilter(filter: TagFilter, tag: string): TagFilter {
  const state = tagFilterState(filter, tag);
  const without = (list: string[]) => list.filter((item) => !sameTag(item, tag));
  return {
    mode: filter.mode,
    include: state === 'off' ? [...filter.include, tag] : without(filter.include),
    exclude: state === 'include' ? [...filter.exclude, tag] : without(filter.exclude),
  };
}
/** The filter without tags no request has any more, as after a tag is removed everywhere. */
export function prunedTagFilter(filter: TagFilter, known: readonly string[]): TagFilter {
  const keep = (list: string[]) => list.filter((tag) => known.some((other) => sameTag(other, tag)));
  return { mode: filter.mode, include: keep(filter.include), exclude: keep(filter.exclude) };
}
