/**
 * The Environments page, laid out as the app's: the workspace's environments on the left, the
 * one chosen on the right as a table of its variables — each on or off, with its value — to
 * add to, change, reorder in bulk, and save at once with `environment update`. A value the
 * command line hides (its name looks secret) is `<hidden>` here and kept unless replaced.
 */

export interface EnvironmentRow {
  key: string;
  value: string;
  enabled: boolean;
}

export interface EnvironmentsView {
  view: 'environments';
  workspace: string;
  /** Each environment, how many variables it has, and the one requests use. */
  environments: { name: string; variables: number; inUse: boolean }[];
  /** The environment shown, and its variables as saved. */
  selected?: string;
  variables: EnvironmentRow[];
  /** Whether the workspace is a team folder, whose shared files hold no secret values. */
  team: boolean;
  saving?: boolean;
  error?: string;
  /** Changes on each save or switch, so the page starts again from what is saved. */
  revision: number;
}

export const HIDDEN_VALUE = '<hidden>';

/** The rows a page posted, checked; or why they cannot be saved. */
export function environmentRowsFrom(value: unknown): EnvironmentRow[] | string {
  if (!Array.isArray(value) || value.length > 1000) return 'The variables could not be read.';
  const rows: EnvironmentRow[] = [];
  for (const item of value as unknown[]) {
    const { key, value: text, enabled } = (item ?? {}) as Record<string, unknown>;
    if (typeof key !== 'string' || typeof text !== 'string' || text.length > 64 * 1024)
      return 'The variables could not be read.';
    const name = key.trim();
    if (!name && !text) continue;
    if (!/^[^\s={}]+$/.test(name))
      return `“${name}” is not a variable name: no spaces, “=”, or braces.`;
    if (/[\r\n]/.test(text)) return `${name}'s value is one line.`;
    if (rows.some((row) => row.key === name)) return `“${name}” is there twice.`;
    rows.push({ key: name, value: text, enabled: enabled !== false });
  }
  return rows;
}

/** Whether saving `rows` over `saved` changes anything. */
export const environmentChanged = (
  saved: readonly EnvironmentRow[],
  rows: readonly EnvironmentRow[],
) => JSON.stringify(saved) !== JSON.stringify(rows);

/** What a name says about its value: secret-looking names are hidden by the command line. */
export const SECRET_LOOKING =
  /authorization|cookie|secret|token|password|passwd|api[-_]?key|credential|private[-_]?key|session/i;

/**
 * Variables whose values are typed unseen, with a button to reveal one: the app's own pattern for
 * environment variables, so both mask the same ones.
 */
export const SENSITIVE_VARIABLE = /secret|token|password|passwd|api[-_]?key|credential|private/i;
