import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScript } from '@techieutils/api-workbench-common/script-engine';
import type { ScriptInput, ScriptOutput } from '@techieutils/api-workbench-common/scripts';
import { ScriptHost, ScriptTrust, type ScriptProcess } from './scripts';

const input = (source: string): ScriptInput => ({
  phase: 'pre',
  source,
  request: { name: 'Get', method: 'GET', url: 'https://api.example.test', headers: [], body: '' },
  variables: {},
});

/** A stand-in for the utility process that runs scripts in this process, or never answers. */
function fakeProcess(options: { hang?: boolean } = {}) {
  const spawned: { killed: boolean }[] = [];
  const spawn = (): ScriptProcess => {
    const state = { killed: false };
    spawned.push(state);
    let onMessage: (message: { id: number; output: ScriptOutput }) => void = () => undefined;
    const exits: (() => void)[] = [];
    return {
      postMessage: ({ id, input }) => {
        if (!options.hang) void runScript(input).then((output) => onMessage({ id, output }));
      },
      onMessage: (listener) => (onMessage = listener),
      onExit: (listener) => exits.push(listener),
      kill: () => {
        state.killed = true;
        exits.forEach((listener) => listener());
      },
    };
  };
  return { spawn, spawned };
}

async function withTrust(run: (trust: ScriptTrust, file: string) => Promise<void>) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aw-scripts-'));
  try {
    const file = path.join(folder, 'script-trust.json');
    await run(new ScriptTrust(file), file);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('scripts written in the app run; others wait until allowed', () =>
  withTrust(async (trust, file) => {
    const mine = 'aw.vars.set("a", "1")';
    const imported = 'aw.vars.set("b", "2")';
    // Typing a new script (from blank) allows each version of it.
    assert.equal(await trust.edited('', mine), true);
    assert.deepEqual(await trust.trustedList([mine, imported, '  ']), [true, false, true]);
    // Editing a paused script does not allow it.
    assert.equal(await trust.edited(imported, `${imported};`), false);
    await trust.allow([imported]);
    assert.equal(await trust.trusted(imported), true);
    // The list keeps fingerprints, never the scripts themselves, and survives a restart.
    const saved = await readFile(file, 'utf8');
    assert.ok(!saved.includes('aw.vars'));
    assert.equal(await new ScriptTrust(file).trusted(imported), true);
  }));

test('the host runs allowed scripts and pauses the rest', () =>
  withTrust(async (trust) => {
    const { spawn } = fakeProcess();
    const host = new ScriptHost(spawn, trust);
    const allowed = 'aw.vars.set("token", "t")';
    await trust.allow([allowed]);
    const output = await host.run(input(allowed));
    assert.equal(output.ok, true);
    assert.deepEqual(output.variables, { token: 't' });
    const paused = await host.run(input('aw.vars.set("token", "stolen")'));
    assert.equal(paused.ok, false);
    assert.equal(paused.paused, true);
    assert.deepEqual(paused.variables, {});
  }));

test('the host refuses input that is not a script input', () =>
  withTrust(async (trust) => {
    const host = new ScriptHost(fakeProcess().spawn, trust);
    for (const bad of [null, { phase: 'eval', source: '' }, { ...input('1'), variables: { a: 1 } }])
      assert.equal((await host.run(bad)).ok, false);
  }));

test('a process that stops answering is killed and replaced', () =>
  withTrust(async (trust) => {
    const hanging = fakeProcess({ hang: true });
    const host = new ScriptHost(hanging.spawn, trust, -1900);
    await trust.allow(['1']);
    const output = await host.run(input('1'));
    assert.equal(output.ok, false);
    assert.match(output.error!, /longer than/);
    assert.equal(hanging.spawned[0].killed, true);
    await host.run(input('1'));
    assert.equal(hanging.spawned.length, 2);
  }));

test('library modules reach the engine only once allowed', () =>
  withTrust(async (trust) => {
    const host = new ScriptHost(fakeProcess().spawn, trust);
    const script = "aw.vars.set('v', aw.require('helpers').value)";
    await trust.allow([script]);
    const libraries = [{ name: 'helpers', source: "exports.value = 'from library';" }];
    const paused = await host.run({ ...input(script), libraries });
    assert.equal(paused.paused, true, 'a module from elsewhere pauses the script that needs it');
    assert.match(paused.error!, /helpers/);
    await trust.allow([libraries[0].source]);
    const allowed = await host.run({ ...input(script), libraries });
    assert.equal(allowed.ok, true, allowed.error ?? '');
    assert.deepEqual(allowed.variables, { v: 'from library' });
  }));
