import { parseTags, tagProblem } from '@techieutils/api-workbench-common/tags';
/** Command-line arguments: what to run, and how. Mistakes are usage errors, which exit with 2. */

export class UsageError extends Error {}

export type Reporter = 'cli' | 'json' | 'junit';
export interface RunOptions {
  command: 'run' | 'list';
  /** A workspace or team folder, or a collection file to import. */
  source: string;
  collections: string[];
  requests: string[];
  /** Requests chosen by their tags: --tag (any, or all with --all-tags) and --exclude-tag. */
  tags?: import('@techieutils/api-workbench-common/tags').TagFilter;
  environment?: string;
  /** `name=value`, or a bare `name` read from the process environment. */
  variables: [string, string][];
  data?: string;
  iterations?: number;
  delayMs?: number;
  timeoutMs?: number;
  bail: boolean;
  /**
   * Request scripts: run them (`allow`) or leave them out (`skip`). A run whose requests have
   * scripts needs one of the two, since scripts run code from the workspace.
   */
  scripts?: 'allow' | 'skip';
  /** A load test instead of a collection run: benchmark or performance, and its settings. */
  load?: import('./run').LoadOptions;
  insecure: boolean;
  reporters: Set<Reporter>;
  jsonFile?: string;
  junitFile?: string;
  color: boolean;
  quiet: boolean;
  /** list only: print the source as JSON, for scripts. */
  json: boolean;
  /**
   * Files sent with requests, by request id: a file body's, and form file fields' by name — from
   * `request send --binary-file` and `--form-file`, or `run --uploads <file>`.
   */
  uploads?: Record<string, Uploads>;
  /** `run --uploads <file>`: the JSON file naming each request's files, read when the run starts. */
  uploadsFile?: string;
  /**
   * `--allow-host`: the only hosts requests may go to, checked after variables and pre-request
   * scripts; a request to any other is not sent. Unset, requests go anywhere.
   */
  allowedHosts?: string[];
  /** `--list-hosts`: print where the chosen requests would go, as JSON, and send nothing. */
  listHosts?: boolean;
  /** Instead of a source path: one of the app's workspaces, and where the app keeps them. */
  workspace?: string;
  dataDir?: string;
}

/** Edit distance, counting two swapped letters as one slip, for suggesting the name meant. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  return rows[a.length][b.length];
}
/** “ Did you mean “x”?” for the closest name, when one is close enough to be a typo; else ''. */
/** A host `--allow-host` names: a name, `*.` and a domain for its subdomains, or an IP. */
export function allowedHost(text: string): string {
  const host = text.trim().toLowerCase();
  if (!/^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$|^\[[0-9a-f:.]+\]$|^[0-9a-f:]+:[0-9a-f:.]*$/.test(host))
    throw new UsageError(
      `--allow-host is a host name, such as api.example.com or *.example.com, not “${text}”.`,
    );
  // An IPv6 address is compared as URLs write it, in brackets.
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * The host a request or connection goes to: from a URL with a scheme (`https:`, `ws:`, `mqtt:`),
 * or a gRPC `host:port`. Undefined when there is none.
 */
export function urlHost(url: string): string | undefined {
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    return parsed.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `url` goes to a host `allowed` names. */
export function hostAllowed(url: string, allowed: readonly string[]): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return allowed.some((entry) =>
    entry.startsWith('*.')
      ? host.endsWith(entry.slice(1)) && host !== entry.slice(2)
      : host === entry,
  );
}

/** Why a request was not sent, when `--allow-host` does not name where it goes. */
export const hostNotAllowed = (url: string): string =>
  `Not sent: it goes to ${urlHost(url) ?? url}, which --allow-host does not list.`;

export function suggest(input: string, names: Iterable<string>): string {
  const wanted = input.toLowerCase();
  let best: { name: string; score: number } | undefined;
  for (const name of new Set(names)) {
    const score = distance(wanted, name.toLowerCase());
    if (score < (best?.score ?? Infinity)) best = { name, score };
  }
  // Allow about one slip in three characters, so unrelated names are never offered.
  return best && best.score <= Math.max(1, Math.floor(input.length / 3))
    ? ` Did you mean “${best.name}”?`
    : '';
}

export const HELP = `API Workbench command line

Usage:
  api-workbench run <source> [options]    Run requests and their tests
  api-workbench list <source>             Show collections, requests, and environments
  api-workbench <resource> <command>      Manage a workspace, as the app does:
      workspace     list, show, create, rename, use, delete
      collection    list, create, rename, delete, import, export, docs
      request       list, show, send, connect, create, update, delete, code
      environment   list, show, create, rename, delete, set, unset
      secret        list, set, delete (saved credentials; values never printed)
      certificate   list, add, enable, disable, remove, trust, untrust (mutual TLS, CAs)
      spec          list, show, lint, import, export, generate, create
      mock          list, show, create, start
      history       list, clear
      cookie        list, delete, clear
      team          status, commit, pull, push, sync (a team folder's git)
    "api-workbench <resource> --help" explains one.
  api-workbench --version | --help

<source> is a team workspace folder, a workspace folder, or a collection file to import
(API Workbench, Postman, Insomnia, Bruno, Hoppscotch, OpenAPI, HAR, or .http).
Instead of a source, -w, --workspace <name> runs one of the app's own workspaces
(--data-dir <folder> says where the app keeps them).

Options for run:
  -c, --collection <path>    Run a collection or folder, such as "Users" or "Users/Admin" (repeatable)
  -r, --request <name|id>    Run only these requests (repeatable)
  -t, --tag <tag>            Run only requests with this tag (repeatable, or a,b): any of them
      --all-tags             With several --tag, run only requests with all of them
      --exclude-tag <tag>    Leave out requests with this tag (repeatable, or a,b)
  -e, --environment <name>   Environment to use (default: the first)
  -v, --var <name=value>     Set a variable for the run (repeatable); "-v name" reads $name
  -d, --data <file>          Run once per row of a CSV, JSON, YAML, or XML file
      --uploads <file>       The files requests send, as JSON: {"<request>": "<path>"} for a
                             file body, {"<request>": {"<field>": "<path>"}} for form fields
  -n, --iterations <count>   Run every request this many times (default 1)
      --delay <ms>           Wait between requests
      --timeout <ms>         Request timeout, overriding the workspace's
      --bail                 Stop at the first failure
      --allow-host <host>    Send only to this host (repeatable; *.example.com for its
                             subdomains); a request to any other fails, unsent
      --list-hosts           Print the hosts the requests would go to, as JSON, and send
                             nothing (requests whose host comes from a capture are listed
                             as unresolved)
      --allow-scripts        Run the requests' pre-request and post-response scripts
      --skip-scripts         Run without the requests' scripts
  -k, --insecure             Do not verify TLS certificates
      --reporter <list>      cli, json, junit, comma separated (default cli)
      --report-json <file>   Write a JSON report
      --report-junit <file>  Write a JUnit XML report, for CI test results
      --quiet                Print failures and the summary only
      --no-color             Plain output (also when NO_COLOR is set or output is not a terminal)

Load tests (run --mode benchmark or performance; any of these makes a performance run):
      --mode <mode>          collection (default), benchmark (every request -n times, as fast as
                             it can), or performance (for --duration seconds)
      --concurrency <n>      Requests in flight at once, 1 to 50 (default 1)
      --duration <seconds>   How long a performance run lasts (default 10)
      --rps <rate>           Start this many requests a second, instead of as fast as possible
      --ramp-up <seconds>    Reach full concurrency or rate over this time
      --warmup <n>           Unmeasured requests first
      --max-requests <n>     Stop after this many (default 10000)
      --p95 <ms>             Fail when the 95th percentile latency is above this
      --max-error-rate <%>   Fail when more than this percentage fail (default 0)
      --min-rps <rate>       Fail when throughput is below this

Options for list:
      --json                 Print collections, requests, and environments as JSON
  -t, --tag, --exclude-tag, --all-tags   List only the requests a run with them would send

Exit codes: 0 all requests passed, 1 a request or test failed, 2 the run could not start,
130 the run was interrupted (Ctrl+C); reports are still written for what ran.
`;

/** Every top-level command, for suggestions; the resource commands are in commands.ts. */
export const COMMANDS = [
  'run',
  'list',
  'help',
  'workspace',
  'collection',
  'request',
  'environment',
  'secret',
  'spec',
  'mock',
  'history',
  'cookie',
  'team',
];
const RUN_FLAGS = [
  '-c',
  '--collection',
  '-r',
  '--request',
  '-t',
  '--tag',
  '--tags',
  '--all-tags',
  '--exclude-tag',
  '-e',
  '--environment',
  '-v',
  '--var',
  '--env-var',
  '-d',
  '--data',
  '--uploads',
  '--allow-host',
  '--list-hosts',
  '-n',
  '--iterations',
  '--delay',
  '--timeout',
  '--bail',
  '--allow-scripts',
  '--skip-scripts',
  '-k',
  '--insecure',
  '--reporter',
  '--reporters',
  '--report-json',
  '--report-junit',
  '--mode',
  '--concurrency',
  '--duration',
  '--rps',
  '--ramp-up',
  '--warmup',
  '--max-requests',
  '--p95',
  '--max-error-rate',
  '--min-rps',
  '--quiet',
  '--no-color',
  '--color',
  '--help',
  '-h',
  '-w',
  '--workspace',
  '--data-dir',
];
const LIST_FLAGS = [
  '--json',
  '-t',
  '--tag',
  '--tags',
  '--all-tags',
  '--exclude-tag',
  '--no-color',
  '--color',
  '--help',
  '-h',
  '-w',
  '--workspace',
  '--data-dir',
];

const decimal = (value: string, flag: string, min: number, max: number) => {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number < min || number > max)
    throw new UsageError(`${flag} must be a number from ${min} to ${max}.`);
  return number;
};
const integer = (value: string, flag: string, min: number, max: number) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}.`);
  return number;
};

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  terminal: boolean,
): RunOptions | 'help' | 'version' {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return 'help';
  if (argv[0] === '--version' || argv[0] === '-V') return 'version';
  const command = argv[0];
  if (command !== 'run' && command !== 'list')
    throw new UsageError(
      `Unknown command “${command}”.${suggest(command, COMMANDS)} See --help for the commands.`,
    );
  // `run --help` and `list --help` print help rather than complain about a missing source.
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  const flags = command === 'run' ? RUN_FLAGS : LIST_FLAGS;
  const options: RunOptions = {
    command,
    source: '',
    collections: [],
    requests: [],
    variables: [],
    bail: false,
    insecure: false,
    reporters: new Set(),
    color: terminal && !env.NO_COLOR,
    quiet: false,
    json: false,
  };
  const loadSettings: NonNullable<RunOptions['load']> = {};
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    // --flag=value works as well as --flag value.
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
    // Run options given to list (or --json to run) are mistakes, not silently ignored.
    if (flag.startsWith('-') && flag !== '-' && !flags.includes(flag)) {
      const other = command === 'run' ? LIST_FLAGS : RUN_FLAGS;
      throw new UsageError(
        other.includes(flag)
          ? `${flag} is not an option of ${command}; see --help.`
          : `Unknown option ${flag}.${suggest(
              flag,
              flags.filter((name) => name.startsWith('--')),
            )} See --help.`,
      );
    }
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (next === undefined || (next.startsWith('-') && next !== '-'))
        throw new UsageError(`${flag} needs a value.`);
      return next;
    };
    switch (flag) {
      case '-c':
      case '--collection':
        options.collections.push(value());
        break;
      case '-r':
      case '--request':
        options.requests.push(value());
        break;
      case '-t':
      case '--tag':
      case '--tags':
      case '--exclude-tag': {
        const tags = (options.tags ??= { include: [], mode: 'any', exclude: [] });
        for (const tag of parseTags(value())) {
          const problem = tagProblem(tag);
          if (problem) throw new UsageError(`${flag} ${tag}: ${problem}`);
          (flag === '--exclude-tag' ? tags.exclude : tags.include).push(tag);
        }
        break;
      }
      case '--all-tags':
        (options.tags ??= { include: [], mode: 'any', exclude: [] }).mode = 'all';
        break;
      case '-e':
      case '--environment':
        options.environment = value();
        break;
      case '-v':
      case '--var':
      case '--env-var': {
        const text = value();
        const equals = text.indexOf('=');
        const name = (equals < 0 ? text : text.slice(0, equals)).trim();
        if (!name || /[{}]/.test(name))
          throw new UsageError(`${flag} needs a variable name: ${text}`);
        // A bare name takes its value from the process environment, so secrets stay off the
        // command line and out of CI logs.
        if (equals < 0) {
          const fromEnv = env[name];
          if (fromEnv === undefined)
            throw new UsageError(`${flag} ${name}: the environment variable ${name} is not set.`);
          options.variables.push([name, fromEnv]);
        } else options.variables.push([name, text.slice(equals + 1)]);
        break;
      }
      case '-d':
      case '--data':
        options.data = value();
        break;
      case '--uploads':
        options.uploadsFile = value();
        break;
      case '--allow-host':
        (options.allowedHosts ??= []).push(allowedHost(value()));
        break;
      case '--list-hosts':
        options.listHosts = true;
        break;
      case '-n':
      case '--iterations':
        options.iterations = integer(value(), flag, 1, 10000);
        break;
      case '--delay':
        options.delayMs = integer(value(), flag, 0, 60000);
        break;
      case '--timeout':
        options.timeoutMs = integer(value(), flag, 100, 300000);
        break;
      case '--bail':
        options.bail = true;
        break;
      case '--allow-scripts':
      case '--skip-scripts': {
        const choice = flag === '--allow-scripts' ? 'allow' : 'skip';
        if (options.scripts && options.scripts !== choice)
          throw new UsageError('Choose --allow-scripts or --skip-scripts, not both.');
        options.scripts = choice;
        break;
      }
      case '--mode': {
        const mode = value();
        if (mode !== 'collection' && mode !== 'benchmark' && mode !== 'performance')
          throw new UsageError(
            `Unknown mode “${mode}”.${suggest(mode, ['collection', 'benchmark', 'performance'])} Use collection, benchmark, or performance.`,
          );
        loadSettings.mode = mode;
        break;
      }
      case '--concurrency':
        loadSettings.concurrency = integer(value(), flag, 1, 50);
        break;
      case '--duration':
        loadSettings.durationSeconds = decimal(value(), flag, 0.01, 3600);
        break;
      case '--rps':
        loadSettings.targetRps = decimal(value(), flag, 0.1, 10000);
        break;
      case '--ramp-up':
        loadSettings.rampUpSeconds = decimal(value(), flag, 0, 3600);
        break;
      case '--warmup':
        loadSettings.warmupIterations = integer(value(), flag, 0, 100);
        break;
      case '--max-requests':
        loadSettings.maxRequests = integer(value(), flag, 1, 100000);
        break;
      case '--p95':
        loadSettings.p95LimitMs = decimal(value(), flag, 0, 3600000);
        break;
      case '--max-error-rate':
        loadSettings.maxErrorRate = decimal(value(), flag, 0, 100);
        break;
      case '--min-rps':
        loadSettings.minRps = decimal(value(), flag, 0, 1000000);
        break;
      case '-k':
      case '--insecure':
        options.insecure = true;
        break;
      case '--reporter':
      case '--reporters':
        for (const name of value()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)) {
          if (name !== 'cli' && name !== 'json' && name !== 'junit')
            throw new UsageError(`Unknown reporter “${name}”. Use cli, json, or junit.`);
          options.reporters.add(name);
        }
        break;
      case '--report-json':
        options.jsonFile = value();
        options.reporters.add('json');
        break;
      case '--report-junit':
        options.junitFile = value();
        options.reporters.add('junit');
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--color':
        options.color = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-w':
      case '--workspace':
        options.workspace = value();
        break;
      case '--data-dir':
        options.dataDir = value();
        break;
      default:
        if (options.source) throw new UsageError(`Give one source; “${arg}” is a second one.`);
        options.source = arg;
    }
  }
  if (options.source && options.workspace)
    throw new UsageError('Give a source or --workspace, not both.');
  if (!options.source && !options.workspace)
    throw new UsageError(
      `${command} needs a workspace folder or collection file, or --workspace <name> for one of the app's.`,
    );
  // Any load setting makes a load test: a performance run unless --mode says otherwise.
  if (Object.keys(loadSettings).length && loadSettings.mode !== 'collection') {
    const mode = loadSettings.mode ?? 'performance';
    if (options.data)
      throw new UsageError(
        'A load test does not take a data file; use --data with a collection run.',
      );
    if (mode === 'performance' && options.iterations !== undefined)
      throw new UsageError(
        'A performance run lasts --duration seconds; --iterations is for collection and benchmark runs.',
      );
    options.load = { ...loadSettings, mode };
  } else if (Object.keys(loadSettings).some((key) => key !== 'mode'))
    throw new UsageError(
      'Load settings (--concurrency, --duration, …) are for --mode benchmark or performance.',
    );
  if (options.data && options.iterations !== undefined)
    throw new UsageError('Use --data or --iterations, not both: a data file sets the iterations.');
  // Without a file, a json or junit reporter writes next to where the run started.
  if (options.reporters.has('json')) options.jsonFile ??= 'api-workbench-report.json';
  if (options.reporters.has('junit')) options.junitFile ??= 'api-workbench-junit.xml';
  // The console summary is always shown, so CI logs say what happened.
  options.reporters.add('cli');
  return options;
}

/** Files for a send: a file body's, and form file fields' by field name. */
export interface Uploads {
  binary?: import('@techieutils/api-workbench-common/types').UploadData;
  fields: Record<string, import('@techieutils/api-workbench-common/types').UploadData>;
}
