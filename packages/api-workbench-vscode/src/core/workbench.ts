import { hostArgs } from './hosts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError, parseJson, type CliProcess, type Engine } from './cli';
import {
  runArgs,
  workspaceArgs,
  type ListOutput,
  type ListedEnvironment,
  type ListedWorkspace,
  type Source,
} from './model';
import { runnerArgs, type LoadReport, type RunnerOptions } from './editing';
import type { RunReport, SendResult } from './report';
import type { ListedMock, MockDetails, RequestDetails } from './views';
import { schemaFrom, type GraphqlSchema } from './graphql-schema';
import type { CredentialRow } from './credentials';

/** `spec list --json`. */
/** Where a run would go (`run --list-hosts`): hosts, and requests whose host only a run can know. */
export interface RunHosts {
  hosts: string[];
  unresolved: { request: string; url: string }[];
}
export interface ListedSpec {
  id: string;
  name: string;
  version?: string;
  operations: number;
  errors: number;
  collection?: string;
}
/** `spec lint --json`. */
export interface SpecAnalysis {
  name: string;
  version?: string;
  title?: string;
  problems: { severity: 'error' | 'warning'; message: string; line?: number }[];
  endpoints: { method: string; path: string; summary: string; deprecated: boolean }[];
}
/** `history list --json`. */
export interface HistoryEntry {
  date: string;
  method: string;
  status?: number;
  timeMs?: number;
  url: string;
  request?: string;
  author?: string;
}
/** `secret list --json`: names and where each may be sent, never a value. */
export type ListedSecret = CredentialRow;
/** `environment show --json`: secret-looking values hidden. */
export interface EnvironmentDetails {
  name: string;
  variables: { key: string; value: string; enabled: boolean }[];
}
/** `cookie list --json`: names and scope, never values. */
export interface CookieJar {
  enabled: boolean;
  cookies: {
    domain: string;
    name: string;
    path: string;
    expires: string;
    secure: boolean;
    httpOnly: boolean;
  }[];
}
/** `team status --json` and the other team commands: the team folder's git state. */
export interface TeamGitResult {
  message: string;
  status: {
    available: boolean;
    repository: boolean;
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    changes: { kind: string; path: string }[];
    changeCount: number;
  };
  /** Files changed on both sides by a pull, to keep as mine or theirs. */
  conflicts?: string[];
}
/** A kind of saved credential the command line can set; others are set up in the app. */
export type CredentialType = 'bearer' | 'basic' | 'api-key';
/** `request code --list --json`. */
export interface CodeTarget {
  id: string;
  label: string;
  extension: string;
  clients: { id: string; label: string }[];
}

/**
 * The command line's word on a file it was not given, as VS Code says it: the file is chosen in the
 * request editor, not with an option.
 */
export const inEditor = (error: string) =>
  error.replace(
    /: give it with request send --(?:binary-file|form-file) [^,]+, or run --uploads <file>\.$/,
    ': choose its file in the request’s Body tab, then run again.',
  );

/** Files for a run's requests, by request id: a file body's path, and form fields' paths by name. */
export type RunUploads = Record<string, { binary?: string; fields: Record<string, string> }>;

/**
 * `--uploads <file>` for a run: the files chosen for its requests, written as JSON beside its
 * report (the command line reads paths, by request id), or nothing when none were chosen.
 */
async function uploadsArgs(folder: string, uploads: RunUploads | undefined): Promise<string[]> {
  const entries = Object.entries(uploads ?? {}).flatMap(([id, chosen]) => [
    ...(chosen.binary ? [[id, chosen.binary] as const] : []),
    ...(Object.keys(chosen.fields).length ? [[id, chosen.fields] as const] : []),
  ]);
  if (!entries.length) return [];
  // A request with both a body file and form fields sends only one of them: its body type says.
  const json: Record<string, string | Record<string, string>> = {};
  for (const [id, value] of entries)
    if (!(id in json) || typeof value !== 'string') json[id] = value;
  const file = path.join(folder, 'uploads.json');
  await writeFile(file, JSON.stringify(json));
  return ['--uploads', file];
}

/** What `certificate list --json` prints: no key, passphrase, or PEM text. */
export interface CertificateList {
  certificates: {
    id: string;
    host: string;
    port?: number;
    type: 'pem' | 'pfx';
    enabled: boolean;
    subject?: string;
    issuer?: string;
    validTo?: string;
    inVault: boolean;
  }[];
  authorities: { subject: string; issuer: string; validTo: string; fingerprint256: string }[];
}

/** A client certificate's files: a PEM certificate and key, or a PFX/P12 bundle. */
export type CertificateFiles = { cert: string; key: string } | { pfx: string };

/** Where a `request` command finds its request: a source, or a collection file such as `.http`. */
export type RequestPlace = { source: Source } | { file: string };

/** What a run does with the requests' scripts: the command line will not choose for you. */
export type ScriptChoice = 'allow' | 'skip' | undefined;

/** The vault's password, given to the command line in its environment, never as an argument. */
const vaultEnv = (password?: string) =>
  password ? { API_WORKBENCH_VAULT_PASSWORD: password } : undefined;

const scriptArgs = (scripts: ScriptChoice) =>
  scripts === 'allow' ? ['--allow-scripts'] : scripts === 'skip' ? ['--skip-scripts'] : [];

/**
 * The command line's commands the extension uses, each returning parsed JSON. Errors are
 * `CliError`s with the command line's own message.
 */
export class Workbench {
  constructor(
    /** A separate Node.js process for each command, or the command line inside VS Code. */
    private readonly engine: Engine,
    /** The app's data folder, when not the usual one (the `apiWorkbench.dataDir` setting). */
    private readonly dataDir?: string,
  ) {}

  /** What runs the commands, for the output channel and the in-editor test. */
  get engineDescription(): string {
    return this.engine.description;
  }

  private data = () => (this.dataDir ? ['--data-dir', this.dataDir] : []);
  private cli = (
    args: string[],
    signal?: AbortSignal,
    env?: Record<string, string>,
    input?: string,
  ) => this.engine.run([...args, ...this.data()], { signal, env, input });
  /** A collection file is read on its own, so it needs neither a workspace nor the data folder. */
  private place = (place: RequestPlace) =>
    'file' in place ? ['--file', place.file] : workspaceArgs(place.source);
  private cliAt = (place: RequestPlace, args: string[], signal?: AbortSignal) =>
    'file' in place
      ? this.engine.run([...args, ...this.place(place)], { signal })
      : this.cli([...args, ...this.place(place)], signal);

  async version(): Promise<string> {
    return (await this.cli(['--version'])).stdout.trim();
  }

  /** The app's workspaces, or none when the app has not been opened on this computer. */
  async appWorkspaces(): Promise<ListedWorkspace[]> {
    try {
      return parseJson<ListedWorkspace[]>(await this.cli(['workspace', 'list', '--json']));
    } catch (error) {
      if (error instanceof CliError && /No API Workbench data/i.test(error.message)) return [];
      throw error;
    }
  }

  async list(source: Source): Promise<ListOutput> {
    return parseJson<ListOutput>(await this.cli(['list', ...runArgs(source), '--json']));
  }

  async environments(source: Source): Promise<ListedEnvironment[]> {
    return parseJson<ListedEnvironment[]>(
      await this.cli(['environment', 'list', ...workspaceArgs(source), '--json']),
    );
  }

  /**
   * Sends one request, as Send does in the app. In one of the app's workspaces the send goes into
   * History and captured values into the environment, unless `save` is false.
   */
  async send(
    source: Source,
    requestId: string,
    options: {
      environment?: string;
      scripts?: ScriptChoice;
      save?: boolean;
      signal?: AbortSignal;
      /** The vault's password, for a request with a saved credential. */
      password?: string;
      /** Files chosen in VS Code: a file body's path, and form file fields' by field name. */
      uploads?: { binary?: string; fields: Record<string, string> };
      /** The only hosts it may go to (`core/hosts.ts`), for a team folder; undefined: anywhere. */
      allowedHosts?: Iterable<string>;
    },
  ): Promise<SendResult> {
    const args = ['request', 'send', requestId, ...workspaceArgs(source), '--json'];
    if (options.uploads?.binary) args.push(`--binary-file=${options.uploads.binary}`);
    for (const [field, file] of Object.entries(options.uploads?.fields ?? {}))
      args.push(`--form-file=${field}=${file}`);
    if (options.environment) args.push('-e', options.environment);
    if (options.save === false) args.push('--no-save');
    args.push(...scriptArgs(options.scripts));
    if (options.allowedHosts) args.push(...hostArgs(options.allowedHosts));
    return parseJson<SendResult>(await this.cli(args, options.signal, vaultEnv(options.password)));
  }

  /**
   * Runs requests and their tests, returning the JSON report. `selection` comes from
   * `selectionArgs`; `tags` narrows it as `--tag` does.
   */
  async run(
    source: Source,
    options: {
      selection: string[];
      environment?: string;
      tags?: string[];
      scripts?: ScriptChoice;
      signal?: AbortSignal;
      /** The vault's password, for requests with a saved credential. */
      password?: string;
      /** Files chosen in VS Code, by request id: a file body's path, and form fields' by name. */
      uploads?: RunUploads;
      /** The only hosts it may go to (`core/hosts.ts`), for a team folder; undefined: anywhere. */
      allowedHosts?: Iterable<string>;
    },
  ): Promise<{ report: RunReport; output: string }> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-'));
    const file = path.join(folder, 'report.json');
    try {
      const args = ['run', ...runArgs(source), ...options.selection];
      if (options.environment) args.push('-e', options.environment);
      for (const tag of options.tags ?? []) args.push('--tag', tag);
      args.push(...scriptArgs(options.scripts), '--report-json', file);
      if (options.allowedHosts) args.push(...hostArgs(options.allowedHosts));
      args.push(...(await uploadsArgs(folder, options.uploads)));
      const result = await this.cli(args, options.signal, vaultEnv(options.password));
      const report = JSON.parse(await readFile(file, 'utf8')) as RunReport;
      for (const result of (report as { results?: { error?: string }[] }).results ?? [])
        if (result.error) result.error = inEditor(result.error);
      return { report, output: result.stdout };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * Where a run with these choices would send its requests (`run --list-hosts`), without sending
   * anything or running scripts, so the hosts can be asked about first (`core/hosts.ts`).
   */
  async runHosts(
    source: Source,
    options: { selection: string[]; environment?: string; tags?: string[] },
  ): Promise<RunHosts> {
    const args = ['run', ...runArgs(source), ...options.selection];
    if (options.environment) args.push('-e', options.environment);
    for (const tag of options.tags ?? []) args.push('--tag', tag);
    return parseJson<RunHosts>(await this.cli([...args, '--list-hosts']));
  }
  /** As `runHosts`, for the Runner's choices: its collection, data file, and environment. */
  async runnerHosts(
    source: Source,
    options: RunnerOptions & { environment?: string; data?: string },
  ): Promise<RunHosts> {
    const args = ['run', ...runArgs(source), ...runnerArgs(options, options.data)];
    if (options.environment) args.push('-e', options.environment);
    return parseJson<RunHosts>(await this.cli([...args, '--list-hosts']));
  }

  /** The request as a cURL command, with secrets redacted, as the app's code generator makes it. */
  async curl(source: Source, requestId: string, environment?: string): Promise<string> {
    return (await this.code({ source }, requestId, 'shell', 'curl', environment)).code.trimEnd();
  }

  /** Code for a request in a language and library, with secrets redacted. */
  async code(
    place: RequestPlace,
    requestId: string,
    lang: string,
    client: string,
    environment?: string,
  ): Promise<{ code: string; notes: string[] }> {
    const args = ['request', 'code', requestId, '--lang', lang, '--client', client, '--json'];
    if (environment) args.push('-e', environment);
    return parseJson(await this.cliAt(place, args));
  }

  /** The languages and libraries code can be generated in. */
  async codeTargets(place: RequestPlace): Promise<CodeTarget[]> {
    return parseJson(await this.cliAt(place, ['request', 'code', '--list', '--json']));
  }

  /** A request's method, URL, headers, tests, and captures; header values that look secret hidden. */
  async showRequest(place: RequestPlace, requestId: string): Promise<RequestDetails> {
    return parseJson(await this.cliAt(place, ['request', 'show', requestId, '--json']));
  }

  /** Sends a request of a collection file, such as a `.http` file, which is never changed. */
  async sendFile(
    file: string,
    requestId: string,
    options: {
      scripts?: ScriptChoice;
      signal?: AbortSignal;
      variables?: Record<string, string>;
      /** The folder its `< ./path` files are relative to, when `file` is a copy of the original. */
      baseDir?: string;
      /**
       * A workspace whose environment (`name`, or the one it uses) fills the file's
       * `{{variables}}`, under the file's own; its values stay in the command line.
       */
      environment?: { source: Source; name?: string };
      /**
       * The hosts it may go to without asking (`core/hosts.ts`); a send anywhere else fails with
       * `CliError.refusedHost`. Undefined sends anywhere.
       */
      allowedHosts?: Iterable<string>;
    },
  ): Promise<SendResult> {
    const args = ['request', 'send', requestId, '--json', ...scriptArgs(options.scripts)];
    if (options.baseDir) args.push(`--base-dir=${options.baseDir}`);
    if (options.allowedHosts) args.push(...hostArgs(options.allowedHosts));
    if (options.environment) {
      args.push(...workspaceArgs(options.environment.source), ...this.data());
      if (options.environment.name) args.push(`--environment=${options.environment.name}`);
    }
    // Each value goes in the command line's environment, which `-v name` reads, so a captured
    // token is never an argument that other programs on the computer can list.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.variables ?? {}))
      if (/^[A-Za-z_][\w.-]*$/.test(name)) {
        args.push(`--var=${name}`);
        env[name] = value;
      }
    return parseJson(
      await this.engine.run([...args, '--file', file], {
        signal: options.signal,
        env,
      }),
    );
  }

  /** Adds a request to a collection of a source; `args` from `createArgs`. */
  async createRequest(source: Source, args: string[]): Promise<{ id: string; name: string }> {
    return parseJson(
      await this.cli(['request', 'create', ...args, ...workspaceArgs(source), '--json']),
    );
  }

  /** Imports a collection file in any format the app imports; the message says what was added. */
  async importCollection(source: Source, file: string, into?: string): Promise<string> {
    const args = ['collection', 'import', file, ...workspaceArgs(source)];
    if (into) args.push('--into', into);
    const result = await this.cli(args);
    return (result.stdout || result.stderr).trim();
  }

  async specs(source: Source): Promise<ListedSpec[]> {
    return parseJson(await this.cli(['spec', 'list', ...workspaceArgs(source), '--json']));
  }

  /** A specification's problems and operations: one of a source's, or a file's. */
  async lintSpec(spec: { source: Source; id: string } | { file: string }): Promise<SpecAnalysis> {
    const args =
      'file' in spec
        ? ['spec', 'lint', spec.file, '--json']
        : ['spec', 'lint', spec.id, ...workspaceArgs(spec.source), '--json'];
    // Exit code 1 means it has an error, which the analysis lists.
    return parseJson('file' in spec ? await this.engine.run(args) : await this.cli(args));
  }

  /** Adds an OpenAPI or Swagger file to a source's specifications. */
  async importSpec(source: Source, file: string): Promise<string> {
    return (await this.cli(['spec', 'import', file, ...workspaceArgs(source)])).stdout.trim();
  }

  /** A source's specification as it was saved. */
  async exportSpec(source: Source, id: string): Promise<string> {
    return (await this.cli(['spec', 'export', id, ...workspaceArgs(source)])).stdout;
  }

  /** A collection with a request for each operation of a specification (a source's, or a file). */
  async generateFromSpec(
    source: Source,
    spec: string,
    options: { collection?: string; replace?: boolean },
  ): Promise<string> {
    const args = ['spec', 'generate', spec, ...workspaceArgs(source)];
    if (options.collection) args.push('--collection', options.collection);
    if (options.replace) args.push('--replace');
    return (await this.cli(args)).stdout.trim();
  }

  async mocks(source: Source): Promise<ListedMock[]> {
    return parseJson(await this.cli(['mock', 'list', ...workspaceArgs(source), '--json']));
  }

  /** Serves a mock server until it is stopped; each line it logs goes to `onLine`. */
  startMock(source: Source, id: string, onLine: (line: string) => void): CliProcess {
    return this.engine.start(
      ['mock', 'start', id, ...workspaceArgs(source), ...this.data()],
      onLine,
    );
  }

  /** Changes a saved request; `args` from `updateArgs`. */
  async updateRequest(
    source: Source,
    requestId: string,
    args: string[],
    /**
     * A form's fields (standard input) and a new token or password (environment), from
     * `updatePlan`; a live request's settings, written to a file only the command line reads.
     */
    extra: { input?: string; env?: Record<string, string>; settings?: object } = {},
  ): Promise<void> {
    const folder = extra.settings
      ? await mkdtemp(path.join(os.tmpdir(), 'api-workbench-settings-'))
      : undefined;
    try {
      const more: string[] = [];
      if (folder) {
        const file = path.join(folder, 'settings.json');
        await writeFile(file, JSON.stringify(extra.settings), { mode: 0o600 });
        more.push(`--settings-file=${file}`);
      }
      await this.cli(
        ['request', 'update', requestId, ...args, ...more, ...workspaceArgs(source), '--json'],
        undefined,
        extra.env,
        extra.input,
      );
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * Saves a request's pre-request or post-response script; empty text removes it. The text goes
   * in a file only the command line reads, as a script can be long. Saving never runs it.
   */
  async saveScript(
    source: Source,
    requestId: string,
    phase: 'pre' | 'post',
    text: string,
  ): Promise<void> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-script-'));
    const file = path.join(folder, `${phase}.js`);
    try {
      await writeFile(file, text, { mode: 0o600 });
      await this.cli([
        'request',
        'update',
        requestId,
        `--${phase}-script-file=${file}`,
        ...workspaceArgs(source),
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  async deleteRequest(source: Source, requestId: string): Promise<void> {
    await this.cli(['request', 'delete', requestId, '--yes', ...workspaceArgs(source)]);
  }

  /** A new collection, which starts with one blank request, as in the app. */
  async createCollection(source: Source, name: string): Promise<void> {
    await this.cli(['collection', 'create', name, ...workspaceArgs(source)]);
  }

  /** Renames a collection or a folder, given by its path such as `Users/Admin`. */
  async renameCollection(source: Source, folder: string, name: string): Promise<void> {
    await this.cli(['collection', 'rename', folder, name, ...workspaceArgs(source)]);
  }

  async deleteCollection(source: Source, folder: string): Promise<void> {
    await this.cli(['collection', 'delete', folder, '--yes', ...workspaceArgs(source)]);
  }

  /** Writes a collection to `file` in one of the formats the app exports. */
  async exportCollection(
    source: Source,
    folder: string,
    format: string,
    file: string,
  ): Promise<void> {
    await this.cli([
      'collection',
      'export',
      folder,
      `--format=${format}`,
      `--output=${file}`,
      ...workspaceArgs(source),
    ]);
  }

  async environment(source: Source, name: string): Promise<EnvironmentDetails> {
    return parseJson(
      await this.cli(['environment', 'show', name, ...workspaceArgs(source), '--json']),
    );
  }

  async createEnvironment(source: Source, name: string, copy?: string): Promise<void> {
    const args = ['environment', 'create', name, ...workspaceArgs(source)];
    if (copy) args.push(`--copy=${copy}`);
    await this.cli(args);
  }

  async renameEnvironment(source: Source, name: string, to: string): Promise<void> {
    await this.cli(['environment', 'rename', name, to, ...workspaceArgs(source)]);
  }

  async deleteEnvironment(source: Source, name: string): Promise<void> {
    await this.cli(['environment', 'delete', name, '--yes', ...workspaceArgs(source)]);
  }

  /**
   * Sets a variable. Its value goes in the command line's environment, which `set` reads for a
   * name given alone, so it is never an argument other programs on the computer can list.
   */
  async setVariable(source: Source, environment: string, name: string, value: string) {
    await this.cli(['environment', 'set', environment, name, ...workspaceArgs(source)], undefined, {
      [name]: value,
    });
  }

  /**
   * Saves an environment's whole list of variables with `environment update`: in order, each on
   * or off. The list goes in the command line's environment, never as arguments.
   */
  async updateEnvironment(
    source: Source,
    environment: string,
    rows: { key: string; value: string; enabled: boolean }[],
  ): Promise<void> {
    await this.cli(
      [
        'environment',
        'update',
        environment,
        '--variables-from-env=API_WORKBENCH_VARIABLES',
        ...workspaceArgs(source),
      ],
      undefined,
      { API_WORKBENCH_VARIABLES: JSON.stringify(rows) },
    );
  }

  async unsetVariable(source: Source, environment: string, name: string): Promise<void> {
    await this.cli(['environment', 'unset', environment, name, ...workspaceArgs(source)]);
  }

  async cookies(source: Source): Promise<CookieJar> {
    return parseJson(await this.cli(['cookie', 'list', ...workspaceArgs(source), '--json']));
  }

  async deleteCookie(source: Source, name: string, domain: string): Promise<void> {
    await this.cli(['cookie', 'delete', name, `--domain=${domain}`, ...workspaceArgs(source)]);
  }

  async clearCookies(source: Source): Promise<void> {
    await this.cli(['cookie', 'clear', '--yes', ...workspaceArgs(source)]);
  }

  async clearHistory(source: Source): Promise<void> {
    await this.cli(['history', 'clear', '--yes', ...workspaceArgs(source)]);
  }

  /** A mock server's settings and routes. */
  async mock(source: Source, id: string): Promise<MockDetails> {
    return parseJson(await this.cli(['mock', 'show', id, ...workspaceArgs(source), '--json']));
  }

  /**
   * Changes a mock server's settings and routes with `mock update`; the settings go in a file only
   * the command line reads, removed straight after.
   */
  async updateMock(source: Source, id: string, settings: Record<string, unknown>): Promise<void> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-mock-'));
    try {
      const file = path.join(folder, 'settings.json');
      await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
      await this.cli([
        'mock',
        'update',
        id,
        `--settings-file=${file}`,
        ...workspaceArgs(source),
        '--json',
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** `mock sync`: a mock made from a collection put fully in step with it, both ways. */
  async syncMock(
    source: Source,
    id: string,
  ): Promise<{ collection: string; routesAdded: number; requestsAdded: number }> {
    return parseJson(await this.cli(['mock', 'sync', id, ...workspaceArgs(source), '--json']));
  }

  /** A new mock server answering for a specification (a source's, or a file) or a collection. */
  async createMock(
    source: Source,
    name: string,
    from: { spec: string } | { collection: string },
  ): Promise<{ id: string; name: string; port: number; routes: number }> {
    const args = ['mock', 'create', name, ...workspaceArgs(source), '--json'];
    args.push('spec' in from ? `--spec=${from.spec}` : `--collection=${from.collection}`);
    return parseJson(await this.cli(args));
  }

  /**
   * A run from the runner: a collection run (iterations, delay, a data file) or a load test. Its
   * report has each send for a collection run, and metrics and thresholds for a load test.
   */
  async runner(
    source: Source,
    options: RunnerOptions & {
      environment?: string;
      data?: string;
      scripts?: ScriptChoice;
      signal?: AbortSignal;
      password?: string;
      /** Files chosen in VS Code, by request id: a file body's path, and form fields' by name. */
      uploads?: RunUploads;
      /** The only hosts it may go to (`core/hosts.ts`), for a team folder; undefined: anywhere. */
      allowedHosts?: Iterable<string>;
    },
  ): Promise<{ report: LoadReport; output: string }> {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-'));
    const file = path.join(folder, 'report.json');
    try {
      const args = ['run', ...runArgs(source), ...runnerArgs(options, options.data)];
      if (options.environment) args.push('-e', options.environment);
      args.push(...scriptArgs(options.scripts), '--report-json', file);
      if (options.allowedHosts) args.push(...hostArgs(options.allowedHosts));
      args.push(...(await uploadsArgs(folder, options.uploads)));
      const result = await this.cli(args, options.signal, vaultEnv(options.password));
      const report = JSON.parse(await readFile(file, 'utf8')) as LoadReport;
      for (const result of (report as { results?: { error?: string }[] }).results ?? [])
        if (result.error) result.error = inEditor(result.error);
      return { report, output: result.stdout };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * A request from a cURL command, such as one copied from a browser. The command goes in on
   * standard input, as it often holds a token that an argument would show to other programs.
   */
  async createRequestFromCurl(
    source: Source,
    curl: string,
    folder?: string,
  ): Promise<{ id: string; name: string; folder: string }> {
    const args = ['request', 'create', '--curl', '-', ...workspaceArgs(source), '--json'];
    if (folder) args.push(`--collection=${folder}`);
    return parseJson(await this.cli(args, undefined, undefined, curl));
  }

  /** A team folder's git: its status, or commit, pull, push, or sync (commit, pull, and push). */
  async team(
    source: Source,
    command: 'status' | 'commit' | 'pull' | 'push' | 'sync',
    options: { message?: string; keep?: 'mine' | 'theirs' } = {},
  ): Promise<TeamGitResult> {
    const args = ['team', command, ...workspaceArgs(source), '--json'];
    if (options.message !== undefined) args.push(`--message=${options.message}`);
    if (options.keep) args.push(`--keep=${options.keep}`);
    return parseJson(await this.cli(args));
  }

  /** A new workspace of the app, on this computer. */
  async createWorkspace(name: string): Promise<{ id: string; name: string }> {
    return parseJson(await this.cli(['workspace', 'create', name, '--json']));
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    await this.cli(['workspace', 'rename', id, name]);
  }

  /** Deletes one of the app's workspaces; a team workspace's shared folder is kept. */
  async deleteWorkspace(id: string): Promise<void> {
    await this.cli(['workspace', 'delete', id, '--yes']);
  }

  /**
   * Saves a credential in the vault. Its secret, and the vault's password, go in the command
   * line's environment — never an argument — and are not kept here.
   */
  async setSecret(
    source: Source,
    credential: {
      name: string;
      type: CredentialType;
      origin: string;
      secret: string;
      username?: string;
      header?: string;
    },
    password?: string,
  ): Promise<string> {
    const args = [
      'secret',
      'set',
      credential.name,
      `--type=${credential.type}`,
      `--origin=${credential.origin}`,
      '--from-env=API_WORKBENCH_SECRET_VALUE',
      ...workspaceArgs(source),
    ];
    if (credential.username) args.push(`--username=${credential.username}`);
    if (credential.header) args.push(`--header=${credential.header}`);
    const result = await this.cli(args, undefined, {
      API_WORKBENCH_SECRET_VALUE: credential.secret,
      ...(password ? { API_WORKBENCH_VAULT_PASSWORD: password } : {}),
    });
    return result.stdout.trim();
  }

  /**
   * Adds or changes a credential of any kind with `secret set`: its fields — secrets among them —
   * go as JSON in the command line's environment, never as arguments; secrets not given are kept.
   */
  async saveCredential(
    source: Source,
    save: { name: string; type: string; origin: string; fields: Record<string, unknown> },
    password?: string,
  ): Promise<void> {
    await this.cli(
      [
        'secret',
        'set',
        save.name,
        `--type=${save.type}`,
        `--origin=${save.origin}`,
        '--fields-from-env=API_WORKBENCH_CREDENTIAL_FIELDS',
        ...workspaceArgs(source),
        '--json',
      ],
      undefined,
      {
        API_WORKBENCH_CREDENTIAL_FIELDS: JSON.stringify(save.fields),
        ...(password ? { API_WORKBENCH_VAULT_PASSWORD: password } : {}),
      },
    );
  }

  async deleteSecret(source: Source, name: string, password?: string): Promise<void> {
    await this.cli(
      ['secret', 'delete', name, '--yes', ...workspaceArgs(source)],
      undefined,
      password ? { API_WORKBENCH_VAULT_PASSWORD: password } : undefined,
    );
  }

  /** The workspace's client certificates and trusted CA certificates: public details only. */
  async certificates(source: Source): Promise<CertificateList> {
    return parseJson<CertificateList>(
      await this.cli(['certificate', 'list', ...workspaceArgs(source), '--json']),
    );
  }

  /**
   * Keeps a client certificate in the vault, read from files chosen in VS Code's own dialog. Its
   * passphrase and the vault's password go in the command line's environment, never arguments.
   */
  async addCertificate(
    source: Source,
    certificate: CertificateFiles & { host: string; port?: number; passphrase?: string },
    password?: string,
  ): Promise<void> {
    await this.cli(
      [
        'certificate',
        'add',
        `--host=${certificate.host}`,
        ...(certificate.port ? [`--port=${certificate.port}`] : []),
        ...('pfx' in certificate
          ? [`--pfx=${certificate.pfx}`]
          : [`--cert=${certificate.cert}`, `--key=${certificate.key}`]),
        ...(certificate.passphrase ? ['--passphrase-from-env=API_WORKBENCH_CERT_PASSPHRASE'] : []),
        ...workspaceArgs(source),
        '--json',
      ],
      undefined,
      {
        ...(certificate.passphrase
          ? { API_WORKBENCH_CERT_PASSPHRASE: certificate.passphrase }
          : {}),
        ...(password ? { API_WORKBENCH_VAULT_PASSWORD: password } : {}),
      },
    );
  }

  /** Presents a client certificate again, or keeps it but stops presenting it. */
  async setCertificateEnabled(source: Source, id: string, enabled: boolean): Promise<void> {
    await this.cli(['certificate', enabled ? 'enable' : 'disable', id, ...workspaceArgs(source)]);
  }

  /** Removes a client certificate and its key from the vault; its files stay. */
  async removeCertificate(source: Source, id: string, password?: string): Promise<void> {
    await this.cli(
      ['certificate', 'remove', id, '--yes', ...workspaceArgs(source)],
      undefined,
      vaultEnv(password),
    );
  }

  /** Trusts the CA certificates in a PEM file, or (`undefined`) only the system's again. */
  async trustCertificates(source: Source, file: string | undefined): Promise<void> {
    await this.cli(
      file
        ? ['certificate', 'trust', file, ...workspaceArgs(source)]
        : ['certificate', 'untrust', '--yes', ...workspaceArgs(source)],
    );
  }

  /** A collection's API documentation, as OpenAPI 3 YAML. */
  async collectionDocs(source: Source, folder: string): Promise<string> {
    return (await this.cli(['collection', 'docs', folder, ...workspaceArgs(source)])).stdout;
  }

  /** A specification describing a collection's requests, kept in the workspace's API Specs. */
  async specFromCollection(source: Source, folder: string, name: string): Promise<string> {
    return (
      await this.cli([
        'spec',
        'create',
        `--collection=${folder}`,
        `--name=${name}`,
        ...workspaceArgs(source),
      ])
    ).stdout.trim();
  }

  /**
   * Opens a live request (WebSocket, gRPC, SSE, NDJSON) and keeps it open: each event it prints,
   * as a JSON line, goes to `onLine`, and `write` sends the lines `core/live.ts` makes.
   */
  connect(
    source: Source,
    requestId: string,
    options: {
      environment?: string;
      password?: string;
      /** The only hosts it may connect to (`core/hosts.ts`); a refusal exits with code 2. */
      allowedHosts?: Iterable<string>;
    },
    onLine: (line: string) => void,
  ): CliProcess {
    const args = ['request', 'connect', requestId, ...workspaceArgs(source), '--json'];
    if (options.environment) args.push('-e', options.environment);
    if (options.allowedHosts) args.push(...hostArgs(options.allowedHosts));
    // A saved credential is read from the vault, with the password typed this session.
    return this.engine.start([...args, ...this.data()], onLine, {
      input: true,
      ...(options.password ? { env: { API_WORKBENCH_VAULT_PASSWORD: options.password } } : {}),
    });
  }

  /**
   * Gets a request's OAuth 2.0 access token with `request token`, which keeps it in the request
   * and never prints it. A browser sign-in goes to `authorize` with the address to open; the
   * token's expiry comes back. Stopping `signal` stops the wait for the browser.
   */
  async requestToken(
    source: Source,
    requestId: string,
    options: { environment?: string; refresh?: boolean; signal?: AbortSignal },
    authorize: (url: string) => void,
  ): Promise<{ expiresAt?: number; refreshToken: boolean; scope?: string }> {
    const args = ['request', 'token', requestId, ...workspaceArgs(source), '--json'];
    if (options.environment) args.push('-e', options.environment);
    if (options.refresh) args.push('--refresh');
    let result: { expiresAt?: number; refreshToken: boolean; scope?: string } | undefined;
    const process = this.engine.start([...args, ...this.data()], (line) => {
      let event: {
        type?: unknown;
        url?: unknown;
        expiresAt?: unknown;
        refreshToken?: unknown;
        scope?: unknown;
      };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'authorize' && typeof event.url === 'string') authorize(event.url);
      else if (event.type === 'token')
        result = {
          ...(typeof event.expiresAt === 'number' ? { expiresAt: event.expiresAt } : {}),
          refreshToken: event.refreshToken === true,
          ...(typeof event.scope === 'string' ? { scope: event.scope } : {}),
        };
    });
    options.signal?.addEventListener('abort', () => process.stop(), { once: true });
    const { code, message } = await process.exited;
    if (code !== 0 || !result) throw new CliError(message || 'No access token was received.', code);
    return result;
  }

  /**
   * A GraphQL request's schema, asked of its endpoint by `request schema`: sent as the request is
   * sent, with its auth, and never saved. The vault's password is for a saved credential.
   */
  async requestSchema(
    source: Source,
    requestId: string,
    options: { environment?: string; password?: string; signal?: AbortSignal } = {},
  ): Promise<GraphqlSchema> {
    const args = ['request', 'schema', requestId, ...workspaceArgs(source), '--json'];
    if (options.environment) args.push('-e', options.environment);
    const schema = schemaFrom(
      parseJson(
        await this.cli(
          args,
          options.signal,
          options.password ? { API_WORKBENCH_VAULT_PASSWORD: options.password } : undefined,
        ),
      ),
    );
    if (!schema) throw new CliError('The command line gave no schema.', 1);
    return schema;
  }

  async history(source: Source, limit = 50): Promise<HistoryEntry[]> {
    return parseJson(
      await this.cli([
        'history',
        'list',
        '--limit',
        String(limit),
        ...workspaceArgs(source),
        '--json',
      ]),
    );
  }

  /**
   * The saved credentials of one of the app's workspaces: names, types, and origins, never their
   * values. A vault with a password needs it, which is given to the command line alone.
   */
  async secrets(source: Source, password?: string): Promise<ListedSecret[]> {
    return parseJson(
      await this.cli(
        ['secret', 'list', ...workspaceArgs(source), '--json'],
        undefined,
        password ? { API_WORKBENCH_VAULT_PASSWORD: password } : undefined,
      ),
    );
  }
}
