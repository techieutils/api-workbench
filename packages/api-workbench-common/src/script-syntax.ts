import { parse } from 'acorn';

/**
 * Finds a syntax error in a request script or library module before it runs, for the editor to
 * underline. It only parses the text — nothing is run — with acorn, at the JavaScript version the
 * script engine (QuickJS) understands; a spec checks the two agree on what is an error.
 */

export interface ScriptSyntaxProblem {
  /** What is wrong, such as `Unexpected token`. */
  message: string;
  /** Where, from 1. */
  line: number;
  column: number;
  /** The text to underline, as offsets into the source. */
  from: number;
  to: number;
}

/**
 * The first syntax error in `source`, or undefined when it parses. A script runs as a script; a
 * library module runs inside a function (see `script-engine.ts`), so it may `return`.
 */
export function scriptSyntaxProblem(
  source: string,
  kind: 'script' | 'module' = 'script',
): ScriptSyntaxProblem | undefined {
  try {
    parse(source, {
      ecmaVersion: 2023,
      sourceType: 'script',
      allowReturnOutsideFunction: kind === 'module',
      allowHashBang: false,
    });
    return undefined;
  } catch (error) {
    const problem = error as SyntaxError & {
      pos?: number;
      loc?: { line: number; column: number };
    };
    if (!(problem instanceof SyntaxError) || problem.pos === undefined || !problem.loc) throw error;
    // The word or character the error is at; where acorn stopped reading can be well past it.
    // An error at the very end (an unclosed bracket or string) marks the last character.
    const from = Math.min(problem.pos, Math.max(0, source.length - 1));
    const token = /^(?:[\w$]+|\S)/.exec(source.slice(from))?.[0].length ?? 1;
    const to = Math.min(source.length, from + token);
    return {
      // acorn ends its messages with (line:column), which the editor shows its own way.
      message: problem.message.replace(/\s*\(\d+:\d+\)$/, ''),
      line: problem.loc.line,
      column: problem.loc.column + 1,
      from,
      to,
    };
  }
}
