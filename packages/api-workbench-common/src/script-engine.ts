import { createHash, createHmac, getHashes, randomBytes, randomUUID } from 'node:crypto';
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import {
  PAUSED_LIBRARY_MESSAGE,
  SCRIPT_LIMITS,
  type ScriptInput,
  type ScriptLog,
  type ScriptOutput,
  type ScriptRequest,
  type ScriptTest,
} from './scripts';

/**
 * Runs request scripts in QuickJS, a separate JavaScript engine compiled to WebAssembly. A script
 * gets a fresh engine each time, with no Node.js, files, network, timers, or vault: only the
 * `aw` API below, whose data is copied in as JSON and whose results are copied out and checked.
 * Hashing and random values come from the host through one function that takes and returns text.
 * Time, memory, and stack are limited, so a runaway script is stopped rather than hanging a run.
 */

let engine: Promise<QuickJSWASMModule> | undefined;
const quickJS = () => (engine ??= newQuickJSWASMModuleFromVariant(variant));

/** The `aw` API, built inside the engine before the script runs. */
const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host;
  const input = JSON.parse(globalThis.__input);
  delete globalThis.__host;
  delete globalThis.__input;
  const phase = input.phase;
  const out = { variables: {}, tests: [], logs: [], request: undefined, pausedLibrary: undefined };
  const limits = input.limits;

  const show = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return '[Function]';
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const quote = (value) => (typeof value === 'string' ? JSON.stringify(value) : show(value));

  const logger = (level) => (...args) => {
    if (out.logs.length >= limits.logs) return;
    out.logs.push({ level, message: args.map(show).join(' ').slice(0, limits.logChars) });
  };
  // aw.log, aw.info, aw.warn, and aw.error write to the app's console. There is no console
  // object: logging goes through aw like everything else a script does.
  const logging = {
    log: logger('log'),
    info: logger('info'),
    warn: logger('warn'),
    error: logger('error'),
  };

  // Variables
  const vars = Object.assign(Object.create(null), input.variables);
  const variableName = (name) => {
    const text = String(name).trim();
    if (!text || /[{}]/.test(text)) throw new TypeError('A variable name cannot be empty or contain { or }.');
    return text;
  };
  const textValue = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : show(value));
  const varsApi = Object.freeze({
    get: (name) => vars[String(name).trim()],
    has: (name) => Object.prototype.hasOwnProperty.call(vars, String(name).trim()),
    set: (name, value) => {
      const key = variableName(name);
      if (!(key in out.variables) && Object.keys(out.variables).length >= limits.variables)
        throw new RangeError('A script can change at most ' + limits.variables + ' variables.');
      const text = textValue(value);
      if (text.length > limits.valueChars) throw new RangeError('The value of ' + key + ' is too long.');
      vars[key] = text;
      out.variables[key] = text;
    },
    unset: (name) => {
      const key = variableName(name);
      delete vars[key];
      out.variables[key] = null;
    },
    toObject: () => Object.assign({}, vars),
  });

  // The request: changeable before it is sent, read-only after.
  const req = input.request;
  let changed = false;
  const writable = () => {
    if (phase !== 'pre') throw new TypeError('aw.request can be changed only in a pre-request script.');
    changed = true;
  };
  const findHeader = (name) => {
    const lower = String(name).toLowerCase();
    return req.headers.findIndex((header) => header.enabled && header.key.toLowerCase() === lower);
  };
  const headersApi = Object.freeze({
    get: (name) => {
      const index = findHeader(name);
      return index >= 0 ? req.headers[index].value : undefined;
    },
    has: (name) => findHeader(name) >= 0,
    set: (name, value) => {
      writable();
      const key = String(name).trim();
      if (!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(key)) throw new TypeError('Invalid header name: ' + key);
      const index = findHeader(key);
      if (index >= 0) req.headers[index].value = textValue(value);
      else req.headers.push({ enabled: true, key, value: textValue(value) });
    },
    remove: (name) => {
      writable();
      const lower = String(name).toLowerCase();
      req.headers = req.headers.filter((header) => header.key.toLowerCase() !== lower);
    },
    toObject: () => {
      const result = {};
      for (const header of req.headers) if (header.enabled && header.key) result[header.key] = header.value;
      return result;
    },
  });
  const requestApi = Object.freeze({
    get name() { return req.name; },
    get method() { return req.method; },
    set method(value) {
      writable();
      const method = String(value).trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) throw new TypeError('Invalid method: ' + value);
      req.method = method;
    },
    get url() { return req.url; },
    set url(value) { writable(); req.url = String(value); },
    get body() { return req.body; },
    set body(value) {
      writable();
      req.body = typeof value === 'string' ? value : JSON.stringify(value);
      if (req.body.length > limits.bodyChars) throw new RangeError('The request body is too long.');
    },
    headers: headersApi,
  });

  // The response, after it arrives.
  let responseApi;
  if (input.response) {
    const res = input.response;
    const lowered = Object.create(null);
    for (const key of Object.keys(res.headers)) lowered[key.toLowerCase()] = res.headers[key];
    let parsed;
    let parsedOnce = false;
    responseApi = Object.freeze({
      status: res.status,
      statusText: res.statusText,
      time: res.time,
      size: res.size,
      url: res.url,
      body: res.body,
      text: () => res.body,
      json: () => {
        if (!parsedOnce) {
          parsed = JSON.parse(res.body);
          parsedOnce = true;
        }
        return parsed;
      },
      headers: Object.freeze({
        get: (name) => lowered[String(name).toLowerCase()],
        has: (name) => String(name).toLowerCase() in lowered,
        toObject: () => Object.assign({}, res.headers),
      }),
    });
  }

  // Tests and expectations
  const equal = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  };
  const lookup = (value, path) => {
    let current = value;
    for (const part of String(path).split('.').filter(Boolean)) {
      if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part))
        return { found: false };
      current = current[part];
    }
    return { found: true, value: current };
  };
  class ExpectationError extends Error {}
  const expect = (actual) => {
    const build = (negated) => {
      const check = (pass, message) => {
        if (pass === negated) throw new ExpectationError((negated ? 'Expected not: ' : 'Expected: ') + message);
      };
      const number = (name, expected) => {
        if (typeof actual !== 'number' || typeof expected !== 'number')
          throw new ExpectationError(name + ' needs numbers, got ' + quote(actual) + ' and ' + quote(expected));
      };
      return {
        toBe: (expected) => check(Object.is(actual, expected), quote(actual) + ' to be ' + quote(expected)),
        toEqual: (expected) => check(equal(actual, expected), quote(actual) + ' to equal ' + quote(expected)),
        toContain: (expected) =>
          check(
            typeof actual === 'string'
              ? actual.includes(String(expected))
              : Array.isArray(actual) && actual.some((item) => equal(item, expected)),
            quote(actual) + ' to contain ' + quote(expected),
          ),
        toMatch: (pattern) =>
          check(
            typeof actual === 'string' &&
              (pattern instanceof RegExp ? pattern.test(actual) : actual.includes(String(pattern))),
            quote(actual) + ' to match ' + String(pattern),
          ),
        toBeGreaterThan: (expected) => (number('toBeGreaterThan', expected), check(actual > expected, quote(actual) + ' > ' + expected)),
        toBeGreaterThanOrEqual: (expected) => (number('toBeGreaterThanOrEqual', expected), check(actual >= expected, quote(actual) + ' >= ' + expected)),
        toBeLessThan: (expected) => (number('toBeLessThan', expected), check(actual < expected, quote(actual) + ' < ' + expected)),
        toBeLessThanOrEqual: (expected) => (number('toBeLessThanOrEqual', expected), check(actual <= expected, quote(actual) + ' <= ' + expected)),
        toBeOneOf: (list) => check(Array.isArray(list) && list.some((item) => equal(actual, item)), quote(actual) + ' to be one of ' + quote(list)),
        toHaveLength: (length) => check(actual != null && actual.length === length, quote(actual) + ' to have length ' + length),
        toHaveProperty: (path, ...value) => {
          const found = lookup(actual, path);
          check(
            found.found && (value.length === 0 || equal(found.value, value[0])),
            'a property ' + path + (value.length ? ' equal to ' + quote(value[0]) : '') + ' in ' + quote(actual),
          );
        },
        toBeTruthy: () => check(Boolean(actual), quote(actual) + ' to be truthy'),
        toBeFalsy: () => check(!actual, quote(actual) + ' to be falsy'),
        toBeDefined: () => check(actual !== undefined, 'a value, got undefined'),
        toBeUndefined: () => check(actual === undefined, quote(actual) + ' to be undefined'),
        toBeNull: () => check(actual === null, quote(actual) + ' to be null'),
      };
    };
    const api = build(false);
    api.not = build(true);
    return Object.freeze(api);
  };
  const test = (name, run) => {
    if (out.tests.length >= limits.tests) throw new RangeError('A script can record at most ' + limits.tests + ' tests.');
    const label = String(name);
    if (typeof run !== 'function') throw new TypeError('aw.test needs a name and a function.');
    try {
      const result = run();
      if (result && typeof result.then === 'function')
        throw new TypeError('aw.test functions run synchronously; remove async and await.');
      out.tests.push({ name: label, pass: true });
    } catch (error) {
      out.tests.push({ name: label, pass: false, message: error && error.message !== undefined ? String(error.message) : show(error) });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new ExpectationError(message === undefined ? 'Assertion failed' : String(message));
  };

  // Helpers from the host: hashing, HMAC, random values, and Base64 of UTF-8 text.
  const encoding = (value) => {
    const name = value === undefined ? 'hex' : String(value);
    if (name !== 'hex' && name !== 'base64' && name !== 'base64url')
      throw new TypeError('Choose hex, base64, or base64url.');
    return name;
  };
  const cryptoApi = Object.freeze({
    hash: (algorithm, text, as) => host('hash', String(algorithm), textValue(text), encoding(as)),
    hmac: (algorithm, key, text, as) => host('hmac', String(algorithm), textValue(key), textValue(text), encoding(as)),
    sha256: (text, as) => host('hash', 'sha256', textValue(text), encoding(as)),
    randomBytes: (size, as) => host('random', String(size), encoding(as)),
    randomUUID: () => host('uuid'),
  });
  const base64 = Object.freeze({
    encode: (text) => host('b64encode', textValue(text)),
    decode: (text) => host('b64decode', textValue(text)),
  });
  globalThis.btoa = base64.encode;
  globalThis.atob = base64.decode;

  // The library: modules are defined by the host after this runs, and each one runs once, the
  // first time a script (or another module) requires it, as CommonJS modules do.
  const modules = Object.create(null);
  for (const entry of input.libraries || [])
    modules[entry.name] = entry.paused ? { paused: true } : { missing: true };
  globalThis.__defineModule = (name, factory) => {
    modules[name] = { factory };
  };
  globalThis.__brokenModule = (name, message) => {
    modules[name] = { error: message };
  };
  const requireModule = (name) => {
    const key = String(name);
    const entry = modules[key];
    if (!entry || entry.missing)
      throw new Error('There is no library module named ' + key + '. Add it under Scripts → Library.');
    if (entry.paused) {
      out.pausedLibrary = key;
      throw new Error('The library module ' + key + ' is paused until it is allowed.');
    }
    if (entry.error) throw new SyntaxError('The library module ' + key + ' has an error: ' + entry.error);
    // A module required again, or while it is still loading (a cycle), gives its exports so far.
    if (entry.module) return entry.module.exports;
    const module = { exports: {} };
    entry.module = module;
    entry.factory.call(module.exports, module, module.exports, requireModule);
    return module.exports;
  };

  globalThis.aw = Object.freeze({
    phase,
    ...logging,
    require: requireModule,
    request: requestApi,
    response: responseApi,
    vars: varsApi,
    test,
    expect,
    assert,
    crypto: cryptoApi,
    base64,
    uuid: cryptoApi.randomUUID,
  });

  globalThis.__finish = () => {
    if (changed) out.request = req;
    return JSON.stringify(out);
  };
})();
`;

/** The host's side of the helpers: text in, text out, nothing else reachable. */
function hostCall(operation: string, ...args: string[]): string {
  switch (operation) {
    case 'hash':
    case 'hmac': {
      const algorithm = args[0].toLowerCase();
      if (!getHashes().includes(algorithm)) throw new Error(`Unknown hash algorithm: ${args[0]}`);
      const encoding = args[args.length - 1] as 'hex' | 'base64' | 'base64url';
      return operation === 'hash'
        ? createHash(algorithm).update(args[1], 'utf8').digest(encoding)
        : createHmac(algorithm, args[1]).update(args[2], 'utf8').digest(encoding);
    }
    case 'random': {
      const size = Number(args[0]);
      if (!Number.isInteger(size) || size < 1 || size > 1024)
        throw new Error('randomBytes takes a size from 1 to 1024.');
      return randomBytes(size).toString(args[1] as BufferEncoding);
    }
    case 'uuid':
      return randomUUID();
    case 'b64encode':
      return Buffer.from(args[0], 'utf8').toString('base64');
    case 'b64decode':
      return Buffer.from(args[0], 'base64').toString('utf8');
    default:
      throw new Error(`Unknown helper: ${operation}`);
  }
}

/** A script's error as one line: its message, with the line it happened on when known. */
function errorText(dumped: unknown, label: string): string {
  if (dumped && typeof dumped === 'object') {
    const error = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const message = `${error.name ?? 'Error'}: ${error.message ?? ''}`.trim();
    // The innermost frame in the script or a library module says where it happened.
    const frame =
      typeof error.stack === 'string'
        ? new RegExp(`(library [A-Za-z][\\w-]*|${label}):(\\d+)`).exec(error.stack)
        : null;
    if (/interrupted/i.test(String(error.message)))
      return `The script ran longer than ${SCRIPT_LIMITS.timeoutMs / 1000} seconds and was stopped.`;
    if (/out of memory/i.test(String(error.message)))
      return 'The script used too much memory and was stopped.';
    // console is what scripts in a browser use; here logging goes through aw.
    const hint = /'console' is not defined/.test(String(error.message))
      ? '. Write to the console with aw.log, aw.info, aw.warn, or aw.error.'
      : '';
    if (!frame) return message + hint;
    return frame[1] === label
      ? `${message} (line ${frame[2]})${hint}`
      : `${message} (${frame[1]}, line ${frame[2]})${hint}`;
  }
  if (/out of memory/i.test(String(dumped)))
    return 'The script used too much memory and was stopped.';
  return String(dumped);
}

const string = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : String(value ?? '').slice(0, limit);

/** The engine's JSON, checked: only the expected shapes, within the limits, leave it. */
function checkedOutput(
  text: string,
  input: ScriptInput,
): Omit<ScriptOutput, 'durationMs'> & { pausedLibrary?: string } {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const variables: Record<string, string | null> = {};
  for (const [key, value] of Object.entries((raw.variables as object) ?? {}).slice(
    0,
    SCRIPT_LIMITS.variables,
  ))
    variables[string(key, 512)] = value === null ? null : string(value, SCRIPT_LIMITS.valueChars);
  const tests: ScriptTest[] = (Array.isArray(raw.tests) ? raw.tests : [])
    .slice(0, SCRIPT_LIMITS.tests)
    .map((test: Record<string, unknown>) => ({
      name: string(test.name, 500),
      pass: test.pass === true,
      ...(test.pass === true ? {} : { message: string(test.message, 2000) }),
    }));
  const levels = new Set(['log', 'info', 'warn', 'error']);
  const logs: ScriptLog[] = (Array.isArray(raw.logs) ? raw.logs : [])
    .slice(0, SCRIPT_LIMITS.logs)
    .map((log: Record<string, unknown>) => ({
      level: (levels.has(log.level as string) ? log.level : 'log') as ScriptLog['level'],
      message: string(log.message, SCRIPT_LIMITS.logChars),
    }));
  let request: ScriptRequest | undefined;
  if (input.phase === 'pre' && raw.request && typeof raw.request === 'object') {
    const edited = raw.request as Record<string, unknown>;
    request = {
      name: input.request.name,
      method: /^[A-Z][A-Z0-9_-]*$/.test(String(edited.method))
        ? String(edited.method)
        : input.request.method,
      url: string(edited.url, 64 * 1024),
      headers: (Array.isArray(edited.headers) ? edited.headers : [])
        .slice(0, 500)
        .map((header: Record<string, unknown>) => ({
          enabled: header.enabled !== false,
          key: string(header.key, 1024),
          value: string(header.value, 64 * 1024),
        })),
      body: string(edited.body, SCRIPT_LIMITS.bodyChars),
    };
  }
  const pausedLibrary =
    typeof raw.pausedLibrary === 'string' &&
    (input.libraries ?? []).some((entry) => entry.name === raw.pausedLibrary)
      ? raw.pausedLibrary
      : undefined;
  return {
    ok: true,
    variables,
    tests,
    logs,
    ...(request ? { request } : {}),
    ...(pausedLibrary ? { pausedLibrary } : {}),
  };
}

/** Runs one script and returns what it did; it never throws for a script's own failure. */
export async function runScript(input: ScriptInput): Promise<ScriptOutput> {
  const started = performance.now();
  const done = (output: Omit<ScriptOutput, 'durationMs'>): ScriptOutput => ({
    ...output,
    durationMs: Math.round(performance.now() - started),
  });
  if (input.source.length > SCRIPT_LIMITS.sourceChars)
    return done({
      ok: false,
      error: `The script is longer than ${SCRIPT_LIMITS.sourceChars / 1024} KB.`,
      variables: {},
      tests: [],
      logs: [],
    });
  const module = await quickJS();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + SCRIPT_LIMITS.timeoutMs));
  const vm = runtime.newContext();
  const label = input.phase === 'pre' ? 'pre-request' : 'post-response';
  // What the script managed before it failed still counts: its logs explain the failure.
  const partial = (): Omit<ScriptOutput, 'durationMs' | 'ok'> & { pausedLibrary?: string } => {
    try {
      const finish = vm.evalCode('__finish()');
      if (finish.error) {
        finish.error.dispose();
        return { variables: {}, tests: [], logs: [] };
      }
      const text = vm.getString(finish.value);
      finish.value.dispose();
      const { variables, tests, logs, pausedLibrary } = checkedOutput(text, input);
      return { variables, tests, logs, ...(pausedLibrary ? { pausedLibrary } : {}) };
    } catch {
      return { variables: {}, tests: [], logs: [] };
    }
  };
  // A failure caused by requiring a paused module pauses the script, as a paused script would.
  const failed = (
    error: string,
    so: ReturnType<typeof partial>,
  ): Omit<ScriptOutput, 'durationMs'> => {
    const { pausedLibrary, ...rest } = so;
    return pausedLibrary
      ? { ok: false, paused: true, error: PAUSED_LIBRARY_MESSAGE(pausedLibrary), ...rest }
      : { ok: false, error, ...rest };
  };
  try {
    const host = vm.newFunction('__host', (...handles) => {
      try {
        const args = handles.map((handle) => vm.getString(handle));
        return vm.newString(hostCall(args[0], ...args.slice(1)));
      } catch (error) {
        return { error: vm.newError((error as Error).message) };
      }
    });
    vm.setProp(vm.global, '__host', host);
    host.dispose();
    const data = vm.newString(
      JSON.stringify({
        phase: input.phase,
        request: input.request,
        response: input.response,
        variables: input.variables,
        libraries: (input.libraries ?? []).map((entry) => ({
          name: entry.name,
          ...(entry.paused || entry.source === undefined ? { paused: true } : {}),
        })),
        limits: SCRIPT_LIMITS,
      }),
    );
    vm.setProp(vm.global, '__input', data);
    data.dispose();
    const prelude = vm.evalCode(PRELUDE, 'prelude.js');
    if (prelude.error) {
      const dumped = vm.dump(prelude.error);
      prelude.error.dispose();
      throw new Error(`The script API failed to start: ${errorText(dumped, 'prelude.js')}`);
    }
    prelude.value.dispose();
    // Each allowed module is defined under its own file name, so its errors name it and its line.
    // Wrapped on one line, so the module's lines keep their numbers.
    for (const entry of input.libraries ?? []) {
      if (entry.paused || entry.source === undefined) continue;
      const defined = vm.evalCode(
        `__defineModule(${JSON.stringify(entry.name)}, function (module, exports, require) {${entry.source}\n});`,
        `library ${entry.name}`,
      );
      if (defined.error) {
        const message = errorText(vm.dump(defined.error), `library ${entry.name}`);
        defined.error.dispose();
        const broken = vm.evalCode(
          `__brokenModule(${JSON.stringify(entry.name)}, ${JSON.stringify(message)})`,
        );
        if (broken.error) broken.error.dispose();
        else broken.value.dispose();
      } else defined.value.dispose();
    }
    const cleanup = vm.evalCode(
      'delete globalThis.__defineModule; delete globalThis.__brokenModule;',
    );
    if (cleanup.error) cleanup.error.dispose();
    else cleanup.value.dispose();
    const result = vm.evalCode(input.source, `${label} script`);
    if (result.error) {
      const dumped = vm.dump(result.error);
      result.error.dispose();
      // A fresh deadline, so what the script recorded can still be read after a timeout.
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 500));
      return done(failed(errorText(dumped, `${label} script`), partial()));
    }
    result.value.dispose();
    // Promises the script started settle now, within the same limits.
    const pending = runtime.executePendingJobs();
    if (pending.error) {
      const dumped = vm.dump(pending.error);
      pending.error.dispose();
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 500));
      return done(failed(errorText(dumped, `${label} script`), partial()));
    }
    const finish = vm.evalCode('__finish()');
    if (finish.error) {
      const dumped = vm.dump(finish.error);
      finish.error.dispose();
      return done({
        ok: false,
        error: errorText(dumped, 'finish'),
        variables: {},
        tests: [],
        logs: [],
      });
    }
    const text = vm.getString(finish.value);
    finish.value.dispose();
    // A paused module the script caught and carried on from still pauses it.
    const { pausedLibrary, ...output } = checkedOutput(text, input);
    return done(
      pausedLibrary
        ? { ...output, ok: false, paused: true, error: PAUSED_LIBRARY_MESSAGE(pausedLibrary) }
        : output,
    );
  } catch (error) {
    return done({
      ok: false,
      error: errorText((error as Error).message ?? error, label),
      variables: {},
      tests: [],
      logs: [],
    });
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
