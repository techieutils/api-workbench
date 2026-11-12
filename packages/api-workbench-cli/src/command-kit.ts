import { collectionOf } from '@techieutils/api-workbench-common/folders';
import type {
  ApiRequest,
  Environment,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import { SECRET_NAME, sharedURL } from '@techieutils/api-workbench-electron/team-files';
import { UsageError, suggest } from './args';
import { printable as printableText } from './report';
import type { PasswordSource } from './vault';

/** What every workspace command shares: its arguments, how it prints, and finding things by name. */

export interface Output {
  out(line: string): void;
  err(line: string): void;
}
export interface CommandContext {
  output: Output;
  env: Record<string, string | undefined>;
  /** Standard input, for `secret set --stdin`. */
  stdin: () => Promise<string>;
  password?: PasswordSource;
  /** Aborted by Ctrl+C: what a long-running command (mock start) waits for. */
  interrupt?: AbortSignal;
  /** Colours in what is printed: a terminal without NO_COLOR, or --color. */
  color?: boolean;
  /** Whether standard output is a terminal, where text from a server could move the cursor. */
  terminal?: boolean;
  /** Standard input line by line, for `request connect`, which sends each as it comes. */
  lines?: AsyncIterable<string>;
  /** Bytes exactly as they came, for `request send --body-only` of an image or other file. */
  writeRaw?: (data: Buffer) => void;
}

// Arguments

export interface Parsed {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}
export const VALUE_FLAGS: Record<string, string> = {
  '-v': '--var',
  '--var': '--var',
  '--timeout': '--timeout',
  '-X': '--method',
  '--method': '--method',
  '--url': '--url',
  '-H': '--header',
  '-d': '--body',
  '--body': '--body',
  '--body-file': '--body-file',
  '--tag': '--tag',
  '--exclude-tag': '--exclude-tag',
  '--curl': '--curl',
  '--limit': '--limit',
  '--domain': '--domain',
  '-m': '--message',
  '--message': '--message',
  '--keep': '--keep',
  '-w': '--workspace',
  '--workspace': '--workspace',
  '--dir': '--dir',
  '--data-dir': '--data-dir',
  '-c': '--collection',
  '--collection': '--collection',
  '-e': '--environment',
  '--environment': '--environment',
  '--into': '--into',
  '--format': '--format',
  '-o': '--output',
  '--output': '--output',
  '--lang': '--lang',
  '--client': '--client',
  '--copy': '--copy',
  '--type': '--type',
  '--origin': '--origin',
  '--username': '--username',
  '--header': '--header',
  '--from-env': '--from-env',
  '--fields-from-env': '--fields-from-env',
  '--variables-from-env': '--variables-from-env',
  '--name': '--name',
  '--port': '--port',
  '--file': '--file',
  '--base-dir': '--base-dir',
  '--unset-header': '--unset-header',
  '--enable-header': '--enable-header',
  '--disable-header': '--disable-header',
  '--spec': '--spec',
  '--tests': '--tests',
  '--capture': '--capture',
  '--auth': '--auth',
  '--auth-username': '--auth-username',
  '--auth-secret-from-env': '--auth-secret-from-env',
  '--auth-fields-from-env': '--auth-fields-from-env',
  '--api-key-in': '--api-key-in',
  '--credential': '--credential',
  '--body-type': '--body-type',
  '--form-fields': '--form-fields',
  '--pre-script-file': '--pre-script-file',
  '--post-script-file': '--post-script-file',
  '--settings-file': '--settings-file',
  '--protocol': '--protocol',
  '--host': '--host',
  '--cert': '--cert',
  '--key': '--key',
  '--pfx': '--pfx',
  '--passphrase-from-env': '--passphrase-from-env',
  '--binary-file': '--binary-file',
  '--form-file': '--form-file',
  '--binary-name': '--binary-name',
  '--allow-host': '--allow-host',
};
export const BOOLEAN_FLAGS: Record<string, string> = {
  '--json': '--json',
  '--all-tags': '--all-tags',
  '-y': '--yes',
  '--yes': '--yes',
  '--stdin': '--stdin',
  '--replace': '--replace',
  '--list': '--list',
  '--no-color': '--no-color',
  '--color': '--color',
  '-h': '--help',
  '--help': '--help',
  '-i': '--include',
  '--include': '--include',
  '--body-only': '--body-only',
  '--no-body': '--no-body',
  '--no-save': '--no-save',
  '-k': '--insecure',
  '--insecure': '--insecure',
  '--allow-scripts': '--allow-scripts',
  '--skip-scripts': '--skip-scripts',
  '--no-tags': '--no-tags',
  '--no-captures': '--no-captures',
  '--refresh': '--refresh',
};
/** Which options each command takes, beyond where (-w, --dir, --data-dir) and --json. */
export const COMMAND_FLAGS: Record<string, string[]> = {
  'workspace delete': ['--yes'],
  'collection delete': ['--yes'],
  'collection import': ['--into'],
  'collection export': ['--format', '--output'],
  'request list': ['--collection', '--file'],
  'request show': ['--file', '--base-dir'],
  'request delete': ['--yes'],
  'request connect': ['--environment', '--var', '--timeout', '--allow-host'],
  'request token': ['--environment', '--var', '--refresh'],
  'request schema': ['--environment', '--var', '--insecure', '--timeout'],
  'request code': ['--lang', '--client', '--environment', '--list', '--file'],
  'environment create': ['--copy'],
  'environment update': ['--variables-from-env'],
  'environment delete': ['--yes'],
  'secret set': [
    '--type',
    '--origin',
    '--username',
    '--header',
    '--stdin',
    '--from-env',
    '--fields-from-env',
  ],
  'secret delete': ['--yes'],
  'certificate add': [
    '--host',
    '--port',
    '--cert',
    '--key',
    '--pfx',
    '--passphrase-from-env',
    '--name',
  ],
  'certificate remove': ['--yes'],
  'certificate untrust': ['--yes'],
  'spec import': ['--name'],
  'spec export': ['--output'],
  'spec generate': ['--collection', '--replace'],
  'mock start': ['--port'],
  'mock update': ['--settings-file'],
  'mock create': ['--spec', '--collection', '--port'],
  'request send': [
    '--environment',
    '--var',
    '--include',
    '--body-only',
    '--no-body',
    '--no-save',
    '--insecure',
    '--timeout',
    '--allow-scripts',
    '--skip-scripts',
    '--file',
    '--base-dir',
    '--binary-file',
    '--form-file',
    '--allow-host',
  ],
  'request update': [
    '--name',
    '--method',
    '--url',
    '--header',
    '--unset-header',
    '--enable-header',
    '--disable-header',
    '--body',
    '--body-file',
    '--no-body',
    '--tests',
    '--tag',
    '--no-tags',
    '--capture',
    '--no-captures',
    '--auth',
    '--auth-username',
    '--auth-secret-from-env',
    '--auth-fields-from-env',
    '--api-key-in',
    '--credential',
    '--body-type',
    '--binary-name',
    '--form-fields',
    '--pre-script-file',
    '--post-script-file',
    '--settings-file',
  ],
  'request create': [
    '--protocol',
    '--collection',
    '--method',
    '--url',
    '--header',
    '--body',
    '--body-file',
    '--tag',
    '--curl',
  ],
  'collection docs': ['--format', '--output', '--tag', '--exclude-tag', '--all-tags'],
  'spec create': ['--collection', '--name', '--format'],
  'history list': ['--limit'],
  'history clear': ['--yes'],
  'cookie list': ['--domain'],
  'cookie delete': ['--domain'],
  'cookie clear': ['--yes'],
  'team commit': ['--message'],
  'team pull': ['--keep'],
  'team sync': ['--message', '--keep'],
};
export const COMMON_FLAGS = [
  '--workspace',
  '--dir',
  '--data-dir',
  '--json',
  '--no-color',
  '--color',
  '--help',
];

export function parse(argv: readonly string[], allowed: string[]): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [raw, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
    const name = VALUE_FLAGS[raw] ?? BOOLEAN_FLAGS[raw];
    if (!raw.startsWith('-') || raw === '-') {
      parsed.positionals.push(arg);
      continue;
    }
    if (!name || !allowed.includes(name))
      throw new UsageError(
        name
          ? `${raw} is not an option of this command; see --help.`
          : `Unknown option ${raw}.${suggest(raw, allowed)} See --help.`,
      );
    if (VALUE_FLAGS[raw]) {
      const value = inline ?? argv[++index];
      // `--option=-value` is plainly a value; only a separate argument may be the next option.
      if (value === undefined || (inline === undefined && value.startsWith('-') && value !== '-'))
        throw new UsageError(`${raw} needs a value.`);
      parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
    } else parsed.flags.add(name);
  }
  return parsed;
}
export const one = (parsed: Parsed, flag: string) => parsed.values.get(flag)?.at(-1);
export function positionals(parsed: Parsed, names: string[], optional = 0): string[] {
  const given = parsed.positionals;
  if (given.length < names.length - optional)
    throw new UsageError(
      `Give ${names
        .slice(given.length)
        .map((name) => `<${name}>`)
        .join(' ')}.`,
    );
  if (given.length > names.length)
    throw new UsageError(`Unexpected “${given[names.length]}”; see --help.`);
  return given;
}
export function confirm(parsed: Parsed, what: string): void {
  if (!parsed.flags.has('--yes'))
    throw new UsageError(`Deleting ${what} cannot be undone. Add --yes to confirm.`);
}

// Output

export const printable = (text: string) => printableText(String(text));
export function table(rows: string[][], out: Output['out']): void {
  if (!rows.length) return;
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => printable(row[column] ?? '').length)),
  );
  for (const row of rows)
    out(
      row
        .map((cell, column) =>
          column === row.length - 1 ? printable(cell) : printable(cell).padEnd(widths[column]),
        )
        .join('  ')
        .trimEnd(),
    );
}
export const json = (output: Output, value: unknown) => output.out(JSON.stringify(value, null, 2));
export const hidden = (key: string, value: string) =>
  SECRET_NAME.test(key) && value ? '<hidden>' : value;

// Lookups

export function collections(state: WorkspaceState): string[] {
  return [...new Set(state.requests.map((request) => collectionOf(request.folder)))];
}
export function folderPaths(state: WorkspaceState): string[] {
  return [
    ...new Set(
      state.requests.flatMap((request) =>
        request.folder.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')),
      ),
    ),
  ];
}
export function findFolder(state: WorkspaceState, wanted: string): string {
  const paths = folderPaths(state);
  const found =
    paths.find((item) => item === wanted) ??
    paths.find((item) => item.toLowerCase() === wanted.toLowerCase());
  if (!found)
    throw new UsageError(
      `No collection or folder “${wanted}”.${suggest(wanted, paths)} Collections: ${collections(state).join(', ') || 'none'}.`,
    );
  return found;
}
export function findRequest(state: WorkspaceState, wanted: string): ApiRequest {
  const byId = state.requests.find((request) => request.id === wanted);
  if (byId) return byId;
  // "Collection/Name" picks between requests of the same name.
  const matches = state.requests.filter(
    (request) => request.name === wanted || `${request.folder}/${request.name}` === wanted,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1)
    throw new UsageError(
      `${matches.length} requests are named “${wanted}”: give its folder too, such as “${matches[0].folder}/${wanted}”, or its id.`,
    );
  throw new UsageError(
    `No request “${wanted}”.${suggest(
      wanted,
      state.requests.map((request) => request.name),
    )}`,
  );
}
export function findEnvironment(state: WorkspaceState, wanted: string): Environment {
  const found =
    state.environments.find((item) => item.name === wanted) ??
    state.environments.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
  if (!found)
    throw new UsageError(
      `No environment “${wanted}”.${suggest(
        wanted,
        state.environments.map((item) => item.name),
      )} Environments: ${state.environments.map((item) => item.name).join(', ') || 'none'}.`,
    );
  return found;
}
export function nameProblem(name: string, what: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100)
    throw new UsageError(`Give the ${what} a name of 1–100 characters.`);
}
export const protocolOf = (request: ApiRequest) => request.protocol || 'http';
export const requestRow = (request: ApiRequest) => ({
  id: request.id,
  name: request.name,
  folder: request.folder,
  method: request.method,
  protocol: protocolOf(request),
  url: sharedURL(request.url),
  ...(request.tags?.length ? { tags: request.tags } : {}),
});

export function variableAssignment(text: string, env: CommandContext['env']): [string, string] {
  const equals = text.indexOf('=');
  const name = (equals < 0 ? text : text.slice(0, equals)).trim();
  if (!name || /[{}]/.test(name)) throw new UsageError(`Give a variable name: ${text}`);
  if (equals >= 0) return [name, text.slice(equals + 1)];
  const value = env[name];
  if (value === undefined)
    throw new UsageError(`${name}: the environment variable ${name} is not set.`);
  return [name, value];
}
