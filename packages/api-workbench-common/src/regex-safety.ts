/**
 * Regular expressions written in a workspace, a collection, a mock, or a specification are run
 * against responses and incoming requests, which anyone can shape. JavaScript's engine
 * backtracks, so some patterns take time that doubles with each character of input: `(a+)+$`
 * against thirty `a`s and a `!` runs for minutes, and freezes the app, a run, or a mock server
 * while it does. Those patterns are refused when they are compiled, with a message that says why.
 *
 * The check reads the pattern's structure without running it. It refuses:
 * - a repeated group that contains another repeat, such as `(a+)+`, `(\w+\.?)*`, `(a{1,9})+`;
 * - back-references, `\1` or `\k<name>`, which no engine can match in linear time;
 * - a repeated group that contains a lookaround, such as `((?=a)a+)+`.
 * A few safe patterns of the first shape are refused too, such as `^(\d+,)*\d+$`; they can be
 * written another way (`^\d+(,\d+)*$` is refused as well, `^[\d,]+$` is not).
 */

const REPEAT_HELP =
  'a repeated group that contains another repeat, such as (a+)+, can take minutes to match. Repeat once instead, such as a+ or [\\w.]+';

/** Outer repeats up to this many times are bounded: `(\d{1,3}\.){3}` takes at most a few steps. */
const BOUNDED_REPEAT = 10;

/** Why a pattern could take exponential time to match, or undefined when it cannot. */
export function regexRisk(pattern: string): string | undefined {
  interface Frame {
    /** A repeat whose length can vary (`*`, `+`, `?`, `{1,3}`) somewhere inside. */
    varies: boolean;
    /** A lookaround somewhere inside, or this group is one. */
    lookaround: boolean;
    /**
     * How each `|` alternative starts: a literal character (lower case, as `i` may be set), or
     * `*` when it could start with many (a class, an escape, `.`, a group, or nothing).
     */
    starts: string[];
    /** The next atom is an alternative's first. */
    atStart: boolean;
    alternatives: boolean;
    /** Where the group's contents start in the pattern. */
    from: number;
  }
  interface Quantifier {
    next: number;
    /** It matches a varying number of times. */
    varies: boolean;
    /** It repeats without a small bound, so what it holds can be tried very many ways. */
    unbounded: boolean;
  }
  const frame = (lookaround: boolean, from: number): Frame => ({
    varies: false,
    lookaround,
    starts: [],
    atStart: true,
    alternatives: false,
    from,
  });
  const stack: Frame[] = [frame(false, 0)];
  /**
   * Whether a group's alternatives can split the same text more than one way. Plain words can
   * only when one is the start of another, such as `a|ab`; `GET|POST|PUT` cannot. Otherwise, as
   * far as can be told without running it, when two start with the same character or one could
   * start with many.
   */
  const ambiguous = (group: Frame, to: number): boolean => {
    const words = pattern.slice(group.from, to).split('|');
    if (words.every((word) => /^[^\\[\](){}|.*+?^$]+$/.test(word))) {
      const lower = words.map((word) => word.toLowerCase());
      return lower.some((word, i) => lower.some((other, j) => i !== j && other.startsWith(word)));
    }
    return group.starts.includes('*') || new Set(group.starts).size < group.starts.length;
  };
  /** Notes how the current alternative starts, if this is its first atom. */
  const starting = (token: string) => {
    const current = top();
    if (!current.atStart) return;
    current.starts.push(token);
    current.atStart = false;
  };
  const top = () => stack[stack.length - 1];
  /** The quantifier at `at` (and its lazy `?`), or none, which neither varies nor repeats. */
  const quantifier = (at: number): Quantifier => {
    let min: number, max: number, length: number;
    const char = pattern[at];
    if (char === '*' || char === '+') [min, max, length] = [char === '+' ? 1 : 0, Infinity, 1];
    else if (char === '?') [min, max, length] = [0, 1, 1];
    else {
      const counts = char === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at, at + 24)) : null;
      if (!counts) return { next: at, varies: false, unbounded: false };
      min = Number(counts[1]);
      max = counts[2] === undefined ? min : counts[3] ? Number(counts[3]) : Infinity;
      length = counts[0].length;
    }
    const next = at + length + (pattern[at + length] === '?' ? 1 : 0);
    return { next, varies: max > min, unbounded: max > BOUNDED_REPEAT };
  };

  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    let atomEnd: number;
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next !== undefined && /[1-9]/.test(next))
        return 'back-references such as \\1 can take minutes to match';
      if (next === 'k' && pattern[index + 2] === '<')
        return 'back-references such as \\k<name> can take minutes to match';
      // \u{…}, \p{…}, and \P{…} carry braces that are not a repeat count.
      if ((next === 'u' || next === 'p' || next === 'P') && pattern[index + 2] === '{') {
        const close = pattern.indexOf('}', index + 3);
        atomEnd = close < 0 ? pattern.length : close + 1;
      } else atomEnd = index + 2;
    } else if (char === '[') {
      // A character class is one atom, ended by the first unescaped `]`, as JavaScript reads it.
      atomEnd = index + 1;
      while (atomEnd < pattern.length && pattern[atomEnd] !== ']')
        atomEnd += pattern[atomEnd] === '\\' ? 2 : 1;
      atomEnd++;
    } else if (char === '|') {
      if (top().atStart) top().starts.push('*');
      top().alternatives = true;
      top().atStart = true;
      index++;
      continue;
    } else if (char === '(') {
      const lookaround = /^\(\?(?:=|!|<=|<!)/.test(pattern.slice(index, index + 4));
      starting('*');
      // Past `(?:`, `(?<name>`, `(?=`, and the rest, so their `?` is not read as a quantifier.
      const opener = /^\((?:\?(?:[:=!]|<[=!]|<[^>]*>|[a-z-]+:))?/i.exec(pattern.slice(index))![0];
      stack.push(frame(lookaround, index + opener.length));
      index += pattern[index + 1] === '?' ? 2 : 1;
      continue;
    } else if (char === ')') {
      const group = stack.length > 1 ? stack.pop()! : top();
      if (group.atStart) group.starts.push('*');
      const outer = quantifier(index + 1);
      if (outer.unbounded && group.varies) return REPEAT_HELP;
      // (a|a)* or (a|ab)*: each character can be matched by either alternative, so the ways to
      // split the text double with each one.
      if (outer.unbounded && group.alternatives && ambiguous(group, index))
        return 'a repeated group whose alternatives can start the same way, such as (a|a)* or (\\d|x)*, can take minutes to match. Use a character class instead, such as [ab]*';
      if (outer.unbounded && group.lookaround)
        return 'a repeated group that contains a lookaround, such as ((?=a)a+)+, can take minutes to match';
      const parent = top();
      parent.varies ||= group.varies || outer.varies;
      parent.lookaround ||= group.lookaround;
      index = Math.max(outer.next, index + 1);
      continue;
    } else atomEnd = index + 1;
    // A plain character starts an alternative with itself; anything else could start many ways.
    starting(
      atomEnd === index + 1 && !'.^$'.includes(char)
        ? char.toLowerCase()
        : char === '\\' && atomEnd === index + 2 && !/[a-zA-Z0-9]/.test(pattern[index + 1])
          ? pattern[index + 1]
          : '*',
    );
    const after = quantifier(atomEnd);
    if (after.varies) top().varies = true;
    index = Math.max(after.next, atomEnd);
  }
  return undefined;
}

/**
 * `new RegExp(pattern, flags)` for a pattern from a workspace, a collection, a mock, or a
 * specification: throws, as an invalid pattern does, when matching it could take minutes.
 */
export function untrustedRegExp(pattern: string, flags?: string): RegExp {
  const risk = regexRisk(pattern);
  if (risk) throw new SyntaxError(`/${pattern.slice(0, 80)}/ is not allowed: ${risk}.`);
  return new RegExp(pattern, flags);
}
