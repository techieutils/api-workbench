import type { HistoryEntry } from './types';

/**
 * History cut to `limit` of your own entries. In a team workspace, teammates' entries (those with
 * an author) do not count against your limit and are kept as they are: each person's own limit
 * applies to their own history file.
 */
export function trimHistory(history: HistoryEntry[], limit: number): HistoryEntry[] {
  let own = 0;
  return history.filter((entry) => Boolean(entry.author) || own++ < limit);
}
/** Your own entries only, as "Clear history" leaves teammates' history in place. */
export const teammateHistory = (history: HistoryEntry[]): HistoryEntry[] =>
  history.filter((entry) => Boolean(entry.author));
