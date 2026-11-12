export type DiffOp = { type: 'equal' | 'delete' | 'insert'; text: string };
export interface DiffRow {
  kind: 'equal' | 'change' | 'delete' | 'insert';
  left?: { line: number; text: string };
  right?: { line: number; text: string };
}
export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when the inputs differ too much to diff precisely; rows then show both sides in full. */
  truncated: boolean;
}

/** Myers' O((N+M)D) line diff. Returns undefined when the edit distance exceeds `maxEdits`. */
export function diffLines(a: string[], b: string[], maxEdits = 4000): DiffOp[] | undefined {
  const n = a.length,
    m = b.length,
    max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v: Int32Array = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return undefined;
  trace.push(v);
  // Walk the trace backwards to recover the edit script.
  const ops: DiffOp[] = [];
  let x = n,
    y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    v = trace[d];
    const k = x - y;
    const previousK =
      k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ type: 'equal', text: a[--x] });
      y--;
    }
    if (d === 0) break;
    if (x === previousX) ops.push({ type: 'insert', text: b[--y] });
    else ops.push({ type: 'delete', text: a[--x] });
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', text: a[--x] });
    y--;
  }
  return ops.reverse();
}

/** Pairs deletions with following insertions so changed lines sit side by side. */
export function sideBySide(a: string, b: string, maxEdits?: number): DiffResult {
  const left = a.split(/\r?\n/),
    right = b.split(/\r?\n/);
  const ops = diffLines(left, right, maxEdits);
  if (!ops) {
    const length = Math.max(left.length, right.length);
    return {
      rows: Array.from({ length }, (_, index) => ({
        kind:
          left[index] === right[index]
            ? 'equal'
            : left[index] === undefined
              ? 'insert'
              : right[index] === undefined
                ? 'delete'
                : 'change',
        left: left[index] === undefined ? undefined : { line: index + 1, text: left[index] },
        right: right[index] === undefined ? undefined : { line: index + 1, text: right[index] },
      })),
      added: right.length,
      removed: left.length,
      truncated: true,
    };
  }
  const rows: DiffRow[] = [];
  let leftLine = 0,
    rightLine = 0,
    added = 0,
    removed = 0;
  for (let index = 0; index < ops.length;) {
    if (ops[index].type === 'equal') {
      rows.push({
        kind: 'equal',
        left: { line: ++leftLine, text: ops[index].text },
        right: { line: ++rightLine, text: ops[index].text },
      });
      index++;
      continue;
    }
    const deletes: string[] = [],
      inserts: string[] = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      (ops[index].type === 'delete' ? deletes : inserts).push(ops[index].text);
      index++;
    }
    removed += deletes.length;
    added += inserts.length;
    for (let pair = 0; pair < Math.max(deletes.length, inserts.length); pair++) {
      const before = deletes[pair],
        after = inserts[pair];
      rows.push({
        kind:
          before !== undefined && after !== undefined
            ? 'change'
            : before !== undefined
              ? 'delete'
              : 'insert',
        left: before !== undefined ? { line: ++leftLine, text: before } : undefined,
        right: after !== undefined ? { line: ++rightLine, text: after } : undefined,
      });
    }
  }
  return { rows, added, removed, truncated: false };
}

/** The differing middle of two lines, for highlighting within a changed row. */
export function changedSpan(a: string, b: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return { prefix, suffix };
}

/** Rows to show when only changes are wanted: changed rows plus `context` lines around them. */
export function foldRows(
  rows: DiffRow[],
  context = 3,
): (DiffRow | { kind: 'fold'; hidden: number })[] {
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.kind === 'equal') return;
    for (
      let near = Math.max(0, index - context);
      near <= Math.min(rows.length - 1, index + context);
      near++
    )
      keep[near] = true;
  });
  const output: (DiffRow | { kind: 'fold'; hidden: number })[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (hidden) output.push({ kind: 'fold', hidden });
      hidden = 0;
      output.push(row);
    } else hidden++;
  });
  if (hidden) output.push({ kind: 'fold', hidden });
  return output;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}
/** Pretty-prints JSON bodies (optionally with sorted keys) so diffs reflect content, not formatting. */
export function normalizeBody(body: string, sortJSONKeys = false): { text: string; json: boolean } {
  try {
    const value: unknown = JSON.parse(body);
    return { text: JSON.stringify(sortJSONKeys ? sortKeys(value) : value, null, 2), json: true };
  } catch {
    return { text: body, json: false };
  }
}

export interface HeaderChange {
  name: string;
  kind: 'added' | 'removed' | 'changed' | 'same';
  before?: string;
  after?: string;
}
/** Compares headers case-insensitively, ignoring headers that change on every response when asked. */
export function diffHeaders(
  before: Record<string, string>,
  after: Record<string, string>,
  ignore: string[] = [],
): HeaderChange[] {
  const lower = (headers: Record<string, string>) =>
    new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const a = lower(before),
    b = lower(after),
    skip = new Set(ignore.map((name) => name.toLowerCase()));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((name) => !skip.has(name))
    .sort()
    .map((name): HeaderChange => {
      const was = a.get(name),
        now = b.get(name);
      return {
        name,
        before: was,
        after: now,
        kind:
          was === undefined
            ? 'added'
            : now === undefined
              ? 'removed'
              : was === now
                ? 'same'
                : 'changed',
      };
    });
}

/** A unified diff for copying or downloading. */
export function unifiedDiff(rows: DiffRow[], beforeLabel: string, afterLabel: string): string {
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const row of rows) {
    if (row.kind === 'equal') lines.push(` ${row.left!.text}`);
    if (row.left && row.kind !== 'equal') lines.push(`-${row.left.text}`);
    if (row.right && row.kind !== 'equal') lines.push(`+${row.right.text}`);
  }
  return lines.join('\n');
}
