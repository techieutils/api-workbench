import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type {
  ApiRequest,
  AuthConfig,
  AuthOptions,
  Environment,
  HistoryEntry,
  KeyValue,
  TeamMember,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import { folderEntry, setFolderEntry } from '@techieutils/api-workbench-common/folders';
import { safeFileName, type CollectionFiles } from './collection-files';

/**
 * A team workspace is a folder people share (a network drive, a synced folder, or a Git checkout).
 * Beside the collections, specifications, and mocks it holds:
 *
 *   workspace.json          name, collection and environment order
 *   environments/*.yaml     one environment per file, so edits to different ones never collide
 *   history/<member>.json   each person's own history, which only they write
 *   .workbench/presence/    who has the workspace open, and the request they are on
 *
 * Everything personal stays on each device, in the app's data folder: open tabs, the selected
 * environment, preferences, cookies, client certificates, last responses, and secrets. Secrets
 * are inline auth fields, saved-credential links (the vault is per device), proxy credentials,
 * and literal values of secret-looking headers, parameters, form fields, and variables. A value
 * that uses a {{variable}} carries no secret, so it is shared.
 */
export const ENVIRONMENTS_DIRECTORY = 'environments';
export const HISTORY_DIRECTORY = 'history';
export const PRESENCE_DIRECTORY = '.workbench/presence';
export const TEAM_FORMAT = 'team';

/** workspace.json in a team folder. */
export interface TeamWorkspaceFile {
  storage: typeof TEAM_FORMAT;
  version: 1;
  name: string;
  collectionOrder: string[];
  /** Environment file names, in the order the app lists them. */
  environmentOrder: string[];
  specFiles?: unknown[];
  /** Scripts run around every request, shared with the team like collection scripts. */
  workspaceScripts?: { pre?: string; post?: string };
  /** Snippets saved for the snippets panel, shared with the team. */
  scriptSnippets?: import('@techieutils/api-workbench-common/script-snippets').UserSnippet[];
}
/** What a person keeps for a team workspace on their own device. */
export interface TeamLocalFile {
  version: 1;
  tabs: string[];
  active?: string;
  recentTabs?: string[];
  closedTabs?: string[];
  /** The selected environment, by name, since teammates may reorder them. */
  environmentName?: string;
  settings?: WorkspaceState['settings'];
  cookieJar?: WorkspaceState['cookieJar'];
  clientCertificates?: WorkspaceState['clientCertificates'];
  responses?: Record<string, ApiRequest['response']>;
  secrets: TeamSecrets;
}
export interface AuthSecrets {
  token?: string;
  password?: string;
  credentialId?: string;
  authOptions?: Partial<AuthOptions>;
}
interface RequestSecrets extends AuthSecrets {
  /** The URL as written, when secret query values were taken out of the shared one. */
  url?: string;
  /** Row values by list and `key#n` (the nth row with that key, ignoring case). */
  rows?: Partial<Record<'headers' | 'params' | 'bodyFields', Record<string, string>>>;
  proxy?: { proxyUsername?: string; proxyPassword?: string };
}
export interface TeamSecrets {
  requests: Record<string, RequestSecrets>;
  collectionAuth: Record<string, AuthSecrets>;
  collectionProxy: Record<string, { proxyUsername?: string; proxyPassword?: string }>;
  /** Variable values by environment name and `key#n`. */
  environments: Record<string, Record<string, string>>;
}

/** Names whose values are treated as secrets, as in exports. */
export const SECRET_NAME =
  /authorization|cookie|secret|token|password|passwd|api[-_]?key|credential|private[-_]?key|session/i;
/** Auth options that hold secrets; the rest (regions, algorithms, URLs) are shared. */
export const SECRET_OPTIONS = [
  'awsSessionToken',
  'oauth1Token',
  'oauth1TokenSecret',
  'oauth2ClientSecret',
  'oauth2RefreshToken',
  'oauth2ExpiresAt',
] as const satisfies readonly (keyof AuthOptions)[];
/** A value typed in as is: not empty, and not built from {{variables}}. */
const literal = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !/\{\{[^{}]+\}\}/.test(value);

/** Rows keyed so they can be matched again after teammates add or reorder others. */
function rowKeys(rows: readonly KeyValue[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const name = row.key.toLowerCase();
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return `${name}#${n}`;
  });
}
function takeRows<T extends KeyValue>(
  rows: T[] | undefined,
): [T[] | undefined, Record<string, string>] {
  const taken: Record<string, string> = {};
  if (!rows) return [rows, taken];
  const keys = rowKeys(rows);
  return [
    rows.map((row, index) => {
      if (!SECRET_NAME.test(row.key) || !literal(row.value)) return row;
      taken[keys[index]] = row.value;
      return { ...row, value: '' };
    }),
    taken,
  ];
}
function putRows<T extends KeyValue>(rows: T[] | undefined, values: Record<string, string> = {}) {
  if (!rows) return rows;
  const keys = rowKeys(rows);
  // Only an empty shared value is filled: a value a teammate typed since wins.
  return rows.map((row, index) =>
    row.value === '' && values[keys[index]] !== undefined
      ? { ...row, value: values[keys[index]] }
      : row,
  );
}
/** The URL with literal values of secret-looking query parameters emptied. */
export function sharedURL(url: string): string {
  return url
    .replace(/^([a-z][\w+.-]*:\/\/)[^/@]+@/i, '$1')
    .replace(
      /([?&])([^=&#]+)=([^&#]*)/g,
      (match, separator: string, key: string, value: string) => {
        let name = key;
        try {
          name = decodeURIComponent(key);
        } catch {
          /* Keep malformed escapes as text. */
        }
        return SECRET_NAME.test(name) && literal(value) ? `${separator}${key}=` : match;
      },
    );
}

/** Splits auth into what a team folder shares and the literal secrets kept on this device. */
export function takeAuth<T extends Partial<AuthConfig>>(config: T): [T, AuthSecrets] {
  const shared = { ...config };
  const secrets: AuthSecrets = {};
  if (literal(shared.token)) {
    secrets.token = shared.token;
    shared.token = '';
  }
  if (literal(shared.password)) {
    secrets.password = shared.password;
    shared.password = '';
  }
  if (shared.credentialId) {
    secrets.credentialId = shared.credentialId;
    delete shared.credentialId;
  }
  if (shared.authOptions) {
    const options = { ...shared.authOptions };
    for (const key of SECRET_OPTIONS)
      if (options[key] !== undefined && options[key] !== '') {
        (secrets.authOptions ||= {})[key] = options[key] as never;
        delete options[key];
      }
    shared.authOptions = options;
  }
  return [shared, secrets];
}
/** Auth with this device's secrets put back where the shared values are empty. */
export function putAuth<T extends Partial<AuthConfig>>(
  config: T,
  secrets: AuthSecrets | undefined,
): T {
  if (!secrets) return config;
  const joined = { ...config };
  if (secrets.token !== undefined && !joined.token) joined.token = secrets.token;
  if (secrets.password !== undefined && !joined.password) joined.password = secrets.password;
  // A saved credential is this device's own; it applies while the type still uses one.
  if (secrets.credentialId && joined.auth === 'Saved credential')
    joined.credentialId = secrets.credentialId;
  if (secrets.authOptions) joined.authOptions = { ...secrets.authOptions, ...joined.authOptions };
  return joined;
}
function takeProxy(settings: Partial<HTTPSettings> | undefined) {
  if (!settings?.proxyUsername && !settings?.proxyPassword) return [settings, undefined] as const;
  const { proxyUsername, proxyPassword, ...rest } = settings;
  return [rest, { proxyUsername, proxyPassword }] as const;
}
const putProxy = (
  settings: Partial<HTTPSettings> | undefined,
  secrets: { proxyUsername?: string; proxyPassword?: string } | undefined,
) => (secrets ? { ...settings, ...secrets } : settings);

/**
 * Splits a workspace into what the team folder holds and what stays on this device. `history` is
 * your own; teammates' entries (with an author) are not written back, since they are read from
 * their own files.
 */
export function splitTeamState(state: WorkspaceState): {
  shared: WorkspaceState;
  local: TeamLocalFile;
  history: HistoryEntry[];
} {
  const secrets: TeamSecrets = {
    requests: {},
    collectionAuth: {},
    collectionProxy: {},
    environments: {},
  };
  const requests = state.requests.map((request) => {
    const [auth, authSecrets] = takeAuth(request);
    const shared: ApiRequest = { ...auth, response: null };
    const own: RequestSecrets = { ...authSecrets };
    const url = sharedURL(request.url);
    if (url !== request.url) {
      own.url = request.url;
      shared.url = url;
    }
    for (const list of ['headers', 'params', 'bodyFields'] as const) {
      if (!request[list]) continue;
      const [rows, taken] = takeRows(request[list] as KeyValue[] | undefined);
      (shared as unknown as Record<string, unknown>)[list] = rows;
      if (Object.keys(taken).length) (own.rows ||= {})[list] = taken;
    }
    const [httpSettings, proxy] = takeProxy(request.httpSettings);
    if (proxy) {
      shared.httpSettings = httpSettings;
      own.proxy = proxy;
    }
    if (Object.keys(own).length) secrets.requests[request.id] = own;
    return shared;
  });
  const collectionAuth = Object.fromEntries(
    Object.entries(state.collectionAuth ?? {}).map(([folder, config]) => {
      const [shared, own] = takeAuth(config);
      if (Object.keys(own).length) setFolderEntry(secrets.collectionAuth, folder, own);
      return [folder, shared];
    }),
  );
  const collectionHttpSettings = Object.fromEntries(
    Object.entries(state.collectionHttpSettings ?? {}).map(([folder, settings]) => {
      const [shared, proxy] = takeProxy(settings);
      if (proxy) secrets.collectionProxy[folder] = proxy;
      return [folder, shared ?? {}];
    }),
  );
  const environments = state.environments.map((environment) => {
    const [variables, taken] = takeRows(environment.variables);
    if (Object.keys(taken).length) secrets.environments[environment.name] = taken;
    return { ...environment, variables: variables ?? [] };
  });
  const responses = Object.fromEntries(
    state.requests
      .filter((request) => request.response)
      .map((request) => [request.id, request.response]),
  );
  return {
    shared: {
      ...state,
      requests,
      environments,
      ...(state.collectionAuth ? { collectionAuth } : {}),
      ...(state.collectionHttpSettings ? { collectionHttpSettings } : {}),
    },
    local: {
      version: 1,
      tabs: state.tabs,
      ...(state.active !== undefined ? { active: state.active } : {}),
      ...(state.recentTabs ? { recentTabs: state.recentTabs } : {}),
      ...(state.closedTabs ? { closedTabs: state.closedTabs } : {}),
      environmentName: state.environments[state.environment]?.name,
      ...(state.settings ? { settings: state.settings } : {}),
      ...(state.cookieJar ? { cookieJar: state.cookieJar } : {}),
      ...(state.clientCertificates ? { clientCertificates: state.clientCertificates } : {}),
      ...(Object.keys(responses).length ? { responses } : {}),
      secrets,
    },
    history: state.history.filter((entry) => !entry.author).map(sharedHistoryEntry),
  };
}

/** The team folder's workspace with this device's personal state and secrets put back. */
export function joinTeamState(
  shared: Omit<WorkspaceState, 'tabs' | 'environment' | 'history'>,
  name: string,
  local: TeamLocalFile | undefined,
  history: HistoryEntry[],
): WorkspaceState {
  const secrets = local?.secrets;
  const requests = shared.requests
    .map((request) => {
      const own = secrets?.requests[request.id];
      if (!own) return request;
      const joined = putAuth(request, own);
      if (own.url && sharedURL(own.url) === request.url) joined.url = own.url;
      for (const list of ['headers', 'params', 'bodyFields'] as const)
        if (request[list])
          (joined as unknown as Record<string, unknown>)[list] = putRows(
            request[list] as KeyValue[] | undefined,
            own.rows?.[list],
          );
      if (own.proxy) joined.httpSettings = putProxy(request.httpSettings, own.proxy);
      return joined;
    })
    .map((request) => ({ ...request, response: local?.responses?.[request.id] ?? null }));
  const ids = new Set(requests.map((request) => request.id));
  const environments: Environment[] = shared.environments.map((environment) => ({
    ...environment,
    variables:
      putRows(environment.variables, secrets?.environments[environment.name]) ??
      environment.variables,
  }));
  const selected = environments.findIndex((item) => item.name === local?.environmentName);
  const tabs = (local?.tabs ?? []).filter((id) => ids.has(id));
  return {
    ...shared,
    requests,
    environments,
    ...(shared.collectionAuth
      ? {
          collectionAuth: Object.fromEntries(
            Object.entries(shared.collectionAuth).map(([folder, config]) => [
              folder,
              putAuth(config, folderEntry(secrets?.collectionAuth, folder)),
            ]),
          ),
        }
      : {}),
    ...(shared.collectionHttpSettings
      ? {
          collectionHttpSettings: Object.fromEntries(
            Object.entries(shared.collectionHttpSettings).map(([folder, settings]) => [
              folder,
              putProxy(settings, secrets?.collectionProxy[folder]) ?? {},
            ]),
          ),
        }
      : {}),
    tabs,
    ...(local?.active && ids.has(local.active) ? { active: local.active } : {}),
    ...(local?.recentTabs ? { recentTabs: local.recentTabs.filter((id) => ids.has(id)) } : {}),
    ...(local?.closedTabs ? { closedTabs: local.closedTabs } : {}),
    environment: selected < 0 ? 0 : selected,
    history,
    settings: { ...local?.settings, workspaceName: name } as WorkspaceState['settings'],
    ...(local?.cookieJar ? { cookieJar: local.cookieJar } : {}),
    ...(local?.clientCertificates ? { clientCertificates: local.clientCertificates } : {}),
  };
}

/** A history entry as teammates may see it: secret query values and headers left out. */
export function sharedHistoryEntry(entry: HistoryEntry): HistoryEntry {
  const shared: HistoryEntry = { ...entry, url: sharedURL(entry.url) };
  if (entry.response)
    shared.response = {
      ...entry.response,
      headers: Object.fromEntries(
        Object.entries(entry.response.headers).map(([key, value]) => [
          key,
          SECRET_NAME.test(key) ? '<redacted>' : value,
        ]),
      ),
      // Set-Cookie values are session secrets.
      ...(entry.response.setCookies ? { setCookies: [] } : {}),
    };
  return shared;
}

const yaml = (value: unknown) => stringify(value, { lineWidth: 0 });
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const historyFile = (member: TeamMember) => {
  if (!MEMBER_ID.test(member.id)) throw new Error('Invalid member ID.');
  return `${HISTORY_DIRECTORY}/${member.id}.json`;
};

/** Environment files, one per environment, and their order. */
export function environmentFiles(environments: readonly Environment[]): {
  files: CollectionFiles;
  order: string[];
} {
  const files: CollectionFiles = new Map();
  const taken = new Set<string>();
  const order = environments.map((environment) => {
    const base = safeFileName(environment.name);
    let file = `${base}.yaml`;
    for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base} ${n}.yaml`;
    taken.add(file.toLowerCase());
    files.set(`${ENVIRONMENTS_DIRECTORY}/${file}`, yaml(environment));
    return file;
  });
  return { files, order };
}

/** A history file's entries, each marked with the teammate who wrote it unless it is yours. */
function historyOf(text: string, own: TeamMember): HistoryEntry[] {
  const value = JSON.parse(text) as { member?: TeamMember; entries?: HistoryEntry[] };
  if (
    !value ||
    !Array.isArray(value.entries) ||
    !value.member ||
    typeof value.member.id !== 'string'
  )
    return [];
  const author =
    value.member.id === own.id
      ? undefined
      : { id: value.member.id, name: String(value.member.name || 'Teammate').slice(0, 60) };
  return value.entries
    .filter((entry) => entry && typeof entry.url === 'string' && typeof entry.date === 'string')
    .map(({ author: _ignored, ...entry }) => (author ? { ...entry, author } : entry));
}
export const historyText = (member: TeamMember, entries: HistoryEntry[]) =>
  JSON.stringify({ member: { id: member.id, name: member.name }, entries });

/**
 * Environments and everyone's history in a team folder, with each file's text for change
 * tracking. Unreadable environment files are an error; unreadable history files are skipped,
 * since one teammate's file should not stop the workspace opening.
 */
export async function readTeamFiles(
  root: string,
  environmentOrder: unknown,
  member: TeamMember,
): Promise<{ environments: Environment[]; history: HistoryEntry[]; files: CollectionFiles }> {
  const files: CollectionFiles = new Map();
  const list = async (directory: string, extension: string) =>
    (
      await fs.readdir(path.join(root, directory), { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      })
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name);
  const found = await list(ENVIRONMENTS_DIRECTORY, '.yaml');
  const listed = Array.isArray(environmentOrder)
    ? environmentOrder.filter(
        (name): name is string => typeof name === 'string' && found.includes(name),
      )
    : [];
  const environments: Environment[] = [];
  for (const name of [
    ...new Set(listed),
    ...found.filter((name) => !listed.includes(name)).sort(),
  ]) {
    const file = `${ENVIRONMENTS_DIRECTORY}/${name}`;
    const text = await fs.readFile(path.join(root, file), 'utf8');
    let value: Partial<Environment>;
    try {
      value = parse(text) as Partial<Environment>;
    } catch (error) {
      throw new Error(`Could not read ${name}: ${(error as Error).message}`, { cause: error });
    }
    files.set(file, text);
    environments.push({
      name: typeof value?.name === 'string' && value.name ? value.name : name.slice(0, -5),
      variables: Array.isArray(value?.variables)
        ? value.variables.filter(
            (row): row is KeyValue =>
              Boolean(row) && typeof row.key === 'string' && typeof row.value === 'string',
          )
        : [],
    });
  }
  const history: HistoryEntry[] = [];
  for (const name of await list(HISTORY_DIRECTORY, '.json')) {
    const file = `${HISTORY_DIRECTORY}/${name}`;
    const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    files.set(file, text);
    try {
      history.push(...historyOf(text, member));
    } catch {
      /* A half-synced file: it is read again when it changes. */
    }
  }
  history.sort((a, b) => b.date.localeCompare(a.date));
  return { environments, history, files };
}
