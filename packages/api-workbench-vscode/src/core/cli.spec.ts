import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  builtInEngine,
  CliError,
  findRuntime,
  parseJson,
  runCli,
  supportsCli,
  type Runtime,
} from './cli';

// The extension's tests run under a Node.js new enough for the command line (as CI and Electron's
// Node are), so this process is a runtime that works.
const self: Runtime = {
  command: process.execPath,
  env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  version: process.versions.node,
};

test('Node.js 22.19 or later runs the command line', () => {
  for (const version of ['22.19.0', 'v22.19.1', '22.21.0', '23.0.0', '24.11.1'])
    assert.ok(supportsCli(version), version);
  for (const version of ['22.18.9', 'v22.13.0', '20.19.5', '18.0.0', 'nonsense', ''])
    assert.equal(supportsCli(version), false, version);
});

test('a runtime that is too old or missing is explained', async () => {
  await assert.rejects(findRuntime({ configured: '/no/such/node' }), (error: Error) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /\/no\/such\/node.*could not be run.*22\.19/);
    return true;
  });
});

test('the editor’s own runtime is used when it is new enough', async () => {
  // A command that is not on PATH leaves only the fallback.
  const runtime = await findRuntime({ configured: undefined, fallback: process.execPath }).catch(
    () => undefined,
  );
  assert.ok(runtime, 'a runtime is found');
  assert.ok(supportsCli(runtime.version));
});

test('exit codes 0 and 1 are results; others are errors with the command line’s message', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-cli-'));
  try {
    const script = path.join(folder, 'fake.cjs');
    await writeFile(
      script,
      `const code = Number(process.argv[2]);
       process.stdout.write(JSON.stringify({ code, color: process.env.NO_COLOR }));
       if (code > 1) process.stderr.write('api-workbench: No environment “Nope”. Run with --allow-scripts or --skip-scripts.\\n');
       process.exit(code);`,
    );
    const ok = await runCli(self, script, ['0']);
    assert.equal(ok.code, 0);
    assert.deepEqual(parseJson(ok), { code: 0, color: '1' }, 'output is plain');
    assert.equal(
      (await runCli(self, script, ['1'])).code,
      1,
      'a failed test still gives its output',
    );
    await assert.rejects(runCli(self, script, ['2']), (error: CliError) => {
      assert.equal(error.code, 2);
      assert.equal(
        error.message,
        'No environment “Nope”. Run with --allow-scripts or --skip-scripts.',
      );
      assert.ok(error.needsScriptChoice);
      return true;
    });
    await assert.rejects(
      runCli(self, path.join(folder, 'missing.cjs'), []),
      /The command line is missing/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('output that is not JSON is explained', () => {
  assert.throws(
    () => parseJson({ stdout: 'Usage: api-workbench …', stderr: '', code: 0 }),
    /did not answer with JSON: Usage: api-workbench/,
  );
  assert.equal(new CliError('No request named “x”', 2).needsScriptChoice, false);
});

test('inside VS Code, an older Node.js is reported so the extension can use a process instead', () => {
  let loaded = false;
  const load = () => {
    loaded = true;
    return { main: async () => 0 };
  };
  assert.throws(
    () => builtInEngine(__filename, load, '22.13.0'),
    (error: unknown) => error instanceof CliError && error.unsupportedRuntime,
  );
  assert.equal(loaded, false);
  // A new enough one loads the command line once and calls it, with no process.
  const engine = builtInEngine(__filename, load, '22.19.0');
  assert.ok(loaded);
  assert.match(engine.description, /inside VS Code/);
});
