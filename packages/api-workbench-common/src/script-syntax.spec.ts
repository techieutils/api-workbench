import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './script-engine';
import { scriptSyntaxProblem } from './script-syntax';
import type { ScriptInput } from './scripts';

const input = (source: string, libraries?: ScriptInput['libraries']): ScriptInput => ({
  phase: 'pre',
  source,
  libraries,
  request: { name: 'r', method: 'GET', url: 'https://example.test', headers: [], body: '' },
  variables: {},
});
/** The engine's verdict: its syntax error, if running the script ended in one. */
async function engineSyntaxError(source: string): Promise<string | undefined> {
  const output = await runScript(input(source));
  return output.error?.startsWith('SyntaxError') ? output.error : undefined;
}

// Scripts that run (or fail for reasons other than syntax) must not be underlined, and modern
// syntax the engine understands must parse.
const VALID = [
  '',
  "aw.vars.set('a', 1);",
  'const { a, ...rest } = { a: 1, b: 2 }; const [x = 1] = [];',
  'const value = aw.response?.status ?? 0; let n = null; n ??= 5; n ||= 1; n &&= 2;',
  'class Counter { #count = 0; static zero = 0; get count() { return this.#count; } }',
  'async function later() { await null; } later();',
  'const big = 10n ** 3n; const parts = /(?<year>\\d{4})/u.exec("2026");',
  'outer: for (const item of [1, 2]) { for (;;) { break outer; } }',
  'const text = `line ${1 + 1}`; const fn = (a, b = a) => a + b;',
  '// only a comment',
  'function* steps() { yield 1; } [...steps()].at(-1);',
  'try { JSON.parse("{"); } catch { aw.log("not JSON"); }',
  'undefinedFunction();',
];
const INVALID: [source: string, line: number][] = [
  ["aw.vars.set('a', 1;", 1],
  ['const x = ;', 1],
  ['if (true) {\n  aw.log(1);\n', 3],
  ["aw.log('unclosed);", 1],
  ['const a = 1;\nconst a = 2;', 2],
  ['let let = 1;', 1],
  ['return 5;', 1],
  ['await aw.vars.get("a");', 1],
  ['function f() {\n  aw.log(1)\n}}', 3],
  ['const value = 1 +;\n', 1],
  ['aw.log(1)\naw.log(2))', 2],
  ['const o = { a: 1 b: 2 };', 1],
];

test('scripts that parse have no problem, as the engine agrees', async () => {
  for (const source of VALID) {
    assert.equal(scriptSyntaxProblem(source), undefined, source);
    assert.equal(await engineSyntaxError(source), undefined, `the engine runs: ${source}`);
  }
});

test('a syntax error is found on the line the engine reports it', async () => {
  for (const [source, line] of INVALID) {
    const problem = scriptSyntaxProblem(source);
    assert.ok(problem, `found in: ${source}`);
    assert.equal(problem.line, line, `line of the problem in: ${source}`);
    const engine = await engineSyntaxError(source);
    assert.ok(engine, `the engine fails too: ${source}`);
    const engineLine = /\(line (\d+)\)/.exec(engine)?.[1];
    if (engineLine) assert.equal(Number(engineLine), line, `the engine's line for: ${source}`);
  }
});

test('the problem says what and where, and marks text to underline', () => {
  const source = "aw.vars.set('a',\n  1;";
  const problem = scriptSyntaxProblem(source)!;
  assert.equal(problem.message, 'Unexpected token');
  assert.deepEqual([problem.line, problem.column], [2, 4]);
  assert.equal(source.slice(problem.from, problem.to), ';');
  assert.doesNotMatch(problem.message, /\(\d+:\d+\)/, 'the position is not repeated');
  // Only the name is marked, not what follows it.
  const twice = 'const a = 1;\nconst a = 2;';
  const redeclared = scriptSyntaxProblem(twice)!;
  assert.equal(twice.slice(redeclared.from, redeclared.to), 'a');
  const word = "aw.log('a') aw.log('b');";
  const missing = scriptSyntaxProblem(word)!;
  assert.equal(word.slice(missing.from, missing.to), 'aw');
});

test('an error at the end marks the last character', () => {
  const source = 'if (true) {';
  const problem = scriptSyntaxProblem(source)!;
  assert.equal(problem.to, source.length);
  assert.ok(problem.from < problem.to);
  assert.equal(scriptSyntaxProblem('(')!.from, 0);
});

test('a library module may return, as it runs inside a function', async () => {
  assert.equal(scriptSyntaxProblem('return 1;', 'module'), undefined);
  assert.ok(scriptSyntaxProblem('return 1;', 'script'));
  assert.ok(scriptSyntaxProblem('exports.a = (;', 'module'));
  // The engine agrees: a module with a broken line fails when required.
  const broken = await runScript(
    input("aw.require('m');", [{ name: 'm', source: 'exports.a = (;' }]),
  );
  assert.match(broken.error ?? '', /SyntaxError/);
  const fine = await runScript(input("aw.require('m');", [{ name: 'm', source: 'return;' }]));
  assert.equal(fine.ok, true, fine.error ?? '');
});
