// Fuzzes the parsers that read other people's text (targets.mjs), so a crash, a hang, a memory
// blow-up, or a polluted prototype is found in CI rather than by an attacker. Each target runs in
// a worker thread; a watchdog ends one that stops answering. Failing inputs are saved, with the
// seed that produced them, in fuzz-findings/, and the run fails.
//
//   npm run test:fuzz                          a few seconds per target (FUZZ_SECONDS)
//   FUZZ_SECONDS=60 npm run test:fuzz -- curl  longer, for some targets
//   FUZZ_SEED=1234 npm run test:fuzz           the same inputs as a run that printed that seed
//   npm run test:fuzz -- --replay assertions fuzz-findings/assertions-1.txt
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HANG_MS = Number(process.env.FUZZ_HANG_MS || 5000);
const MEMORY_MB = 1024;
const MAX_INPUT = 2_000_000;

/** Text known to trip parsers: dangerous keys, paths, nesting, entities, and risky patterns. */
const TOKENS = [
  '__proto__',
  'constructor',
  'prototype',
  '{"__proto__":{"polluted":1}}',
  '../',
  '../../etc/passwd',
  '..\\..\\',
  '/etc/passwd',
  'C:\\Windows\\',
  '\u0000',
  '\u202e',
  '\u2028',
  '\r',
  '\r\n',
  '\n\n',
  '###',
  '{{',
  '}}',
  '{{$processEnv HOME}}',
  '{{__proto__}}',
  '<',
  '<@',
  '< /etc/passwd',
  '--XYZ',
  '$ref',
  '#/',
  '"#/a"',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '&lt;',
  '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>',
  '&e;',
  '*a',
  '&a',
  '<<: *a',
  '!!js/function',
  '!!binary',
  '\t',
  '"',
  "'",
  '`',
  '$(id)',
  '\\',
  '%00',
  '1e309',
  '-0',
  'NaN',
  '9007199254740993',
  '[]',
  '{}',
  'null',
  '[[[[[[[[[[',
  '((((((((',
  '(a+)+$',
  '(a|a)*$',
  '([a-z]+)*$',
  '(a{1,20})+$',
  '((?=a)a+)+$',
  '(a)\\1',
  '(\\w+\\.?)+@',
  'json $.a',
  '$..*',
  '$[?(@)]',
  'matches /(a+)+$/',
  'status between 1 2',
  ' '.repeat(200),
  'a'.repeat(5000),
  '{'.repeat(3000),
  '['.repeat(3000),
  '- '.repeat(2000),
];

/** mulberry32: a small seeded generator, so a run can be repeated from its seed. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutator(random) {
  const pick = (n) => Math.floor(random() * n);
  return (source) => {
    let out = source;
    for (let step = 1 + pick(4); step > 0; step--) {
      const at = pick(out.length + 1);
      switch (pick(8)) {
        case 0:
          out = out.slice(0, at) + TOKENS[pick(TOKENS.length)] + out.slice(at);
          break;
        case 1:
          out = out.slice(0, at) + out.slice(at + pick(20));
          break;
        case 2:
          out =
            out.slice(0, at) + out.slice(at, at + pick(200)).repeat(1 + pick(50)) + out.slice(at);
          break;
        case 3:
          out = out.slice(0, at) + String.fromCharCode(pick(0x2100)) + out.slice(at + 1);
          break;
        case 4:
          out = out.replace(/"[^"]{0,30}"/, JSON.stringify(TOKENS[pick(TOKENS.length)]));
          break;
        case 5:
          out = out.slice(0, at);
          break;
        case 6:
          out = out.replace(
            /"([a-z_]+)":/i,
            `"${['__proto__', 'constructor', 'prototype'][pick(3)]}":`,
          );
          break;
        default:
          out = '['.repeat(pick(5000)) + out;
      }
    }
    return out.length > MAX_INPUT ? out.slice(0, MAX_INPUT) : out;
  };
}

/** Why an input's outcome is a bug, or undefined: a thrown Error or SyntaxError is a refusal. */
function problemOf(error) {
  if (!error || error.constructor === Error || error instanceof SyntaxError) return undefined;
  const where =
    String(error.stack || '')
      .split('\n')[1]
      ?.trim() ?? '';
  return `${error.constructor?.name ?? typeof error}: ${String(error.message).slice(0, 160)} ${where}`;
}
const prototypes = () =>
  [Object.prototype, Array.prototype, Function.prototype, String.prototype]
    .map((proto) => Object.getOwnPropertyNames(proto).join())
    .join('|');

if (!isMainThread) {
  // A worker: mutate the seeds and the inputs that passed, run each, and report what breaks.
  const { name, until, seed } = workerData;
  const { targets } = await import('./targets.mjs');
  const { seeds } = await import('./seeds.mjs');
  const run = targets[name];
  const mutate = mutator(generator(seed));
  const random = generator(seed ^ 0x9e3779b9);
  const corpus = [...seeds[name]];
  const clean = prototypes();
  const reported = new Set();
  let count = 0;
  while (Date.now() < until) {
    const input = mutate(corpus[Math.floor(random() * corpus.length)]);
    parentPort.postMessage({ input });
    try {
      run(input);
      if (corpus.length < 200 && random() < 0.05) corpus.push(input);
    } catch (error) {
      const problem = problemOf(error);
      const key = problem?.replace(/\d+/g, 'N').slice(0, 100);
      if (problem && !reported.has(key)) {
        reported.add(key);
        parentPort.postMessage({ problem, input });
      }
    }
    if ({}.polluted !== undefined || prototypes() !== clean) {
      parentPort.postMessage({ problem: 'a built-in prototype was changed', input });
      process.exit(1);
    }
    if (++count % 100 === 0) parentPort.postMessage({ count: 100 });
  }
  parentPort.postMessage({ count: count % 100 });
} else {
  const { targets } = await import('./targets.mjs');
  const args = process.argv.slice(2);
  if (args[0] === '--replay') {
    // Runs one saved input, to see its error or how long it takes.
    const [, name, file] = args;
    const started = Date.now();
    try {
      targets[name](readFileSync(file, 'utf8'));
      console.log(`${name}: no error, ${Date.now() - started} ms`);
    } catch (error) {
      console.log(`${name}: ${problemOf(error) ?? `refused: ${error.message}`}`);
    }
    process.exit(0);
  }
  const seconds = Number(process.env.FUZZ_SECONDS || 6);
  const seed = Number(process.env.FUZZ_SEED || Math.floor(Math.random() * 2 ** 31));
  const out = path.resolve(process.env.FUZZ_OUT || 'fuzz-findings');
  const names = args.length ? args : Object.keys(targets);
  for (const name of names) if (!targets[name]) throw new Error(`No fuzz target ${name}.`);
  console.log(`Fuzzing ${names.length} targets for ${seconds} s each, seed ${seed}.`);
  const findings = [];
  const record = (name, problem, input) => {
    if (findings.some((item) => item.name === name && item.problem === problem)) return;
    mkdirSync(out, { recursive: true });
    const file = path.join(out, `${name}-${findings.length + 1}.txt`);
    writeFileSync(file, input ?? '');
    findings.push({ name, problem, file: path.relative(process.cwd(), file) });
    console.log(`  ✖ ${name}: ${problem} (${(input ?? '').length} characters, saved in ${file})`);
  };
  const fuzz = (name, index) =>
    new Promise((done) => {
      const until = Date.now() + seconds * 1000;
      let total = 0;
      let restarts = 0;
      const start = () => {
        if (Date.now() >= until) return done(total);
        const worker = new Worker(fileURLToPath(import.meta.url), {
          workerData: { name, until, seed: seed + index * 7919 + restarts++ * 104729 },
          resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB },
        });
        let current = '';
        let heard = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - heard < HANG_MS) return;
          clearInterval(watchdog);
          record(name, `no answer within ${HANG_MS / 1000} s`, current);
          void worker.terminate();
        }, 200);
        worker.on('message', (message) => {
          heard = Date.now();
          if (message.input !== undefined) current = message.input;
          if (message.problem) record(name, message.problem, message.input);
          if (message.count) total += message.count;
        });
        worker.on('error', (error) =>
          record(name, `the worker stopped: ${error.message}`, current),
        );
        worker.on('exit', () => {
          clearInterval(watchdog);
          start();
        });
      };
      start();
    });
  for (const [index, name] of names.entries()) {
    const count = await fuzz(name, index);
    console.log(`  ${name}: ${count.toLocaleString('en')} inputs`);
  }
  if (findings.length) {
    writeFileSync(
      path.join(out, 'findings.json'),
      `${JSON.stringify({ seed, findings }, null, 2)}\n`,
    );
    console.log(
      `\n${findings.length} problem${findings.length === 1 ? '' : 's'} found. Replay one with: npm run test:fuzz -- --replay <target> <file>`,
    );
    process.exitCode = 1;
  } else console.log('\nNo problems found.');
}
