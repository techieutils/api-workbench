import { inheritedTags } from '@techieutils/api-workbench-common/tags';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  collectionOf,
  folderNameProblem,
  isWithin,
  moveFolderPath,
} from '@techieutils/api-workbench-common/folders';
import {
  exportCollection,
  exportFormats,
  importFiles,
} from '@techieutils/api-workbench-common/collection-transfer';
import {
  analyzeSpec,
  requestsFromSpec,
  specFormat,
} from '@techieutils/api-workbench-common/api-specs';
import { preparePayload } from '@techieutils/api-workbench-common/request-payload';
import { dynamicValue } from '@techieutils/api-workbench-common/variables';
import type {
  ApiRequest,
  ApiSpec,
  CodegenInput,
  MockServer,
  CredentialInput,
  CredentialKind,
  Environment,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
import { codegenTargets, generateCode } from '@techieutils/api-workbench-electron/codegen';
import { MockServers } from '@techieutils/api-workbench-electron/mock-servers';
import { inspectProto } from '@techieutils/api-workbench-electron/protocols';
import {
  mockPortProblem,
  mockRoutesFromRequests,
  mockRoutesFromSpec,
  newMock,
} from '@techieutils/api-workbench-common/mocks';
import { SECRET_NAME } from '@techieutils/api-workbench-electron/team-files';
import { UsageError, suggest } from './args';
import { completeRequest, openFileTarget } from './source';
import {
  COMMAND_FLAGS,
  COMMON_FLAGS,
  collections,
  confirm,
  findEnvironment,
  findFolder,
  findRequest,
  folderPaths,
  hidden,
  json,
  nameProblem,
  one,
  parse,
  positionals,
  printable,
  protocolOf,
  requestRow,
  table,
  variableAssignment,
  type CommandContext,
  type Output,
  type Parsed,
} from './command-kit';
export type { CommandContext, Output } from './command-kit';
import { createRequest, sendRequest, updateRequest } from './send';
import { connectRequest } from './connect';
import {
  collectionDocs,
  cookieCommand,
  historyCommand,
  specFromCollection,
  teamCommand,
} from './workspace-data';
import {
  emptyState,
  findWorkspace,
  newWorkspaceState,
  openStore,
  openTarget,
  type RequestTarget,
  type Target,
} from './target';
import { openVault, terminalPassword } from './vault';
import { certificateCommand } from './certificates';
import { authDetails, requestToken } from './auth-fields';
import { requestSchema } from './graphql-schema';
import { mockSettings, updateMock } from './mock-settings';
import {
  mockSyncStatus,
  renameMockCollections,
  syncMockWithCollection,
} from '@techieutils/api-workbench-common/mock-sync';

/**
 * The commands that look after a workspace, as the app's sidebar and screens do: workspaces,
 * collections, requests, environments, credentials, specifications, mock servers, and code.
 *
 * What they print follows the app's rules for logs: names, methods, and URLs without their
 * secrets. Values whose names look secret (tokens, passwords, keys) are never printed, and a
 * credential's secret is only ever read in, from standard input or an environment variable.
 */

export const RESOURCES = [
  'workspace',
  'collection',
  'request',
  'environment',
  'secret',
  'certificate',
  'spec',
  'mock',
  'history',
  'cookie',
  'team',
] as const;
export type Resource = (typeof RESOURCES)[number];
/** Shorter names people reach for. */
export const RESOURCE_ALIASES: Record<string, Resource> = {
  workspaces: 'workspace',
  ws: 'workspace',
  collections: 'collection',
  col: 'collection',
  requests: 'request',
  req: 'request',
  environments: 'environment',
  env: 'environment',
  envs: 'environment',
  secrets: 'secret',
  credential: 'secret',
  credentials: 'secret',
  certificates: 'certificate',
  cert: 'certificate',
  certs: 'certificate',
  specs: 'spec',
  mocks: 'mock',
  cookies: 'cookie',
  git: 'team',
};

const SUBCOMMANDS: Record<Resource, string[]> = {
  workspace: ['list', 'show', 'create', 'rename', 'use', 'delete'],
  collection: ['list', 'create', 'rename', 'delete', 'import', 'export', 'docs'],
  request: [
    'list',
    'show',
    'send',
    'connect',
    'token',
    'schema',
    'create',
    'update',
    'delete',
    'code',
  ],
  environment: ['list', 'show', 'create', 'rename', 'delete', 'set', 'unset', 'update'],
  secret: ['list', 'set', 'delete'],
  certificate: ['list', 'add', 'enable', 'disable', 'remove', 'trust', 'untrust'],
  spec: ['list', 'show', 'lint', 'import', 'export', 'generate', 'create'],
  mock: ['list', 'show', 'create', 'update', 'sync', 'start'],
  history: ['list', 'clear'],
  cookie: ['list', 'delete', 'clear'],
  team: ['status', 'commit', 'pull', 'push', 'sync'],
};

const TARGET_HELP = `Where:
  -w, --workspace <name|id>  One of the app's workspaces (default: the active one)
      --dir <folder>         A team workspace folder instead, such as one in your repository
      --data-dir <folder>    The app's data folder (default: found as the app does;
                             also API_WORKBENCH_DATA_DIR)
      --json                 Print JSON, for scripts
  -y, --yes                  Confirm a delete`;

export const RESOURCE_HELP: Record<Resource, string> = {
  workspace: `api-workbench workspace <command>

  list                       The app's workspaces; * marks the active one
  show [<workspace>]         What a workspace holds
  create <name>              A new workspace on this device
  rename <workspace> <name>
  use <workspace>            Make it the active workspace, as the app's switcher does
  delete <workspace> --yes   A team workspace's shared folder is kept

${TARGET_HELP}`,
  collection: `api-workbench collection <command>

  list                              Collections, with their request counts
  create <name>                     A collection, starting with one blank request, as in the app
  rename <collection> <name>        Also renames a folder: "Users/Admin" "Users/Admins"
  delete <collection> --yes
  import <file> [--into <name>]     Any format the app imports (Postman, Insomnia, OpenAPI, HAR, …)
  export <collection> [--format <id>] [-o <file>]
                                    Formats: ${exportFormats.map((format) => format.id).join(', ')}
  docs <collection> [--format openapi|swagger] [-o <file>] [--json] [--tag <tag>]…
       [--exclude-tag <tag>]… [--all-tags]
                                    API documentation for it, as OpenAPI 3 (YAML unless --json);
                                    tags choose part of it, and tag each operation

${TARGET_HELP}`,
  request: `api-workbench request <command>

  list [-c <collection>]                    Requests in explorer order
  show <name|id>                            Method, URL, headers, tests, and captures
  send <name|id> [-e <env>] [-v <name=value>] [-i] [--body-only] [--no-body] [--no-save]
       [-k] [--timeout <ms>] [--allow-scripts | --skip-scripts]
                                            Send it, as the Send button does: status, timing,
                                            body (-i adds headers), tests, and captures. In one
                                            of the app's workspaces it goes into History and
                                            captured values into the environment (not with
                                            --no-save). Exits 1 when its tests fail
       [--binary-file <path>] [--form-file <field>=<path>]…
                                            The file a file body sends, and each form file
                                            field's (20 MB at most), read for this send only
       [--allow-host <host>]…              Send only if it goes to one of these hosts (after
                                            variables and scripts; *.example.com for its
                                            subdomains); otherwise exit 2, unsent
  connect <name|id> [-e <env>] [-v <name=value>] [--timeout <ms>]
                                            Open a WebSocket, gRPC, SSE, NDJSON, Socket.IO, or
                                            MQTT request and keep it open: events print as they
                                            happen, and each line of standard input is sent
                                            (--json: JSON lines, {"action":"send","message":"…",
                                            "options":{…}}, finish, or stop). A saved credential
                                            is read from the vault with its password
       [--allow-host <host>]…              Connect only if it goes to one of these hosts (after
                                            variables); otherwise exit 2, unconnected
  schema <name|id> [-e <env>] [-v <name=value>] [-k] [--timeout <ms>]
                                            A GraphQL request's schema, asked of its endpoint
                                            with an introspection query sent as it is sent (its
                                            URL, headers, and auth); --json prints the types and
                                            fields. Nothing is saved and no script runs
  token <name|id> [-e <env>] [-v <name=value>] [--refresh]
                                            Get an OAuth 2.0 access token for a request and keep
                                            it in the request, never printed; an authorization
                                            code grant prints the address to sign in at (--json:
                                            {"type":"authorize","url"}) and waits
  create <name> -c <collection> --url <url> [-X <method>] [-H "Name: value"]… [-d <body> |
         --body-file <file>] [--tag <tag>]… [--protocol http|websocket|sse|ndjson|grpc|socketio|
         mqtt]                              A new request; --protocol makes a live one, with
                                            its protocol's settings
  create [<name>] --curl '<curl command>' [-c <collection>]
                                            A request from a cURL command; --curl - reads stdin
  update <name|id> [--name <name>] [-X <method>] [--url <url>] [-H "Name: value"]…
         [--unset-header <name>]… [--enable-header <name>]… [--disable-header <name>]…
         [-d <body> | --body-file <file> | --no-body]
         [--tests <lines>] [--tag <tag>… | --no-tags] [--capture <name=from>… | --no-captures]
                                            Change a request: -H adds a header or replaces the
                                            one of that name; --tests, --tag, and --capture
                                            replace its tests, tags, and captures
         [--auth none|inherit|bearer|basic|api-key|digest|jwt|aws|oauth1|ntlm|wsse|
         edgegrid|hawk|oauth2|credential] [--auth-username <name>]
         [--auth-secret-from-env <VAR>] [--auth-fields-from-env <VAR>]
         [--api-key-in header|query] [--credential <id>]
                                            Its auth: the token or password, or JSON with every
                                            field ({"username", "password", "token", "options":
                                            {…}}), is read from the environment variable, never
                                            an argument
         [--body-type none|raw|form-data|x-www-form-urlencoded|binary] [--form-fields -]
         [--binary-name <file name>]
                                            Its body type; --form-fields - reads the form's
                                            fields as JSON [{"key","value","enabled"}] from
                                            stdin, with "kind": "file" and "fileName" for file
                                            fields (then the list is the whole form);
                                            --binary-name names a file body's file
         [--pre-script-file <file>] [--post-script-file <file>]
                                            Its pre-request and post-response scripts, from files
                                            (an empty file removes one); they still run only
                                            with --allow-scripts, and in the app once allowed
         [--settings-file <file>]           A live request's settings, as JSON: {"grpc": {"proto",
                                            "method", "tls"}}, {"socketio": {"path", "event",
                                            "ack"}}, or {"mqtt": {"clientId", "version",
                                            "keepalive", "subscriptions", "topic", "qos", …}}
  delete <name|id> --yes
  code <name|id> [--lang <id>] [--client <id>] [-e <environment>]
                                            Code for the request, with secrets redacted;
                                            --list shows the languages and clients

list, show, send, and code also take --file <file>: a collection file, such as a .http file,
read as it is and never changed. Its requests are named by name or by position (1, 2, …).
A .http file's < ./path files are relative to it; show and send take --base-dir <folder> for
another folder, such as an editor's for an unsaved copy of the file.
send --file also takes -w or --dir with -e: that workspace's environment fills the file's
{{variables}}, under the file's own @name = value lines; -v wins over both.

${TARGET_HELP}`,
  environment: `api-workbench environment <command>

  list
  show <environment>                 Its variables; secret-looking values are hidden
  create <name> [--copy <environment>]
  rename <environment> <name>
  delete <environment> --yes
  set <environment> <name=value>…    "name" alone reads the value from $name, so secrets stay
                                     off the command line
  unset <environment> <name>…
  update <environment> --variables-from-env <VAR>
                                     Replace its variables with the JSON list in $VAR:
                                     [{"key", "value", "enabled"}], in order; "<hidden>" keeps
                                     a value, so secrets stay off the command line

${TARGET_HELP}`,
  secret: `api-workbench secret <command>

  list                               Saved credentials: name, type, and where they may be sent
  set <name> --type <kind> --origin <url> [--stdin | --from-env <VAR>]
         [--username <name>] [--header <name>] [--fields-from-env <VAR>]
                                     Add or change a credential of any kind but client
                                     certificates: bearer, basic, api-key, digest, jwt, aws,
                                     oauth1, ntlm, wsse, edgegrid, hawk, oauth2. The secret is
                                     read from standard input or an environment variable,
                                     never an argument; --fields-from-env holds JSON with
                                     secret, extraSecret, username, headerName, options, and
                                     oauth. Changing one keeps the secrets not given
  delete <name> --yes

Secret values are never printed. The command line opens the API Workbench vault with
its password (API_WORKBENCH_VAULT_PASSWORD, or typed at a terminal). A vault encrypted with the
system's credential store, as the app does on macOS and Windows, opens only in the app.

${TARGET_HELP}`,
  certificate: `api-workbench certificate <command>

  list                               Client certificates — host, type, on or off, and until
                                     when valid — and the CA certificates trusted
  add --host <host> [--port <port>] (--cert <file> --key <file> | --pfx <file>)
         [--passphrase-from-env <VAR>] [--name <name>]
                                     Keep a client certificate in the vault, presented to the
                                     host (or *.example.com) over HTTPS; its passphrase is read
                                     from an environment variable, never an argument
  enable <host|id>                   Present it again
  disable <host|id>                  Keep it, but stop presenting it
  remove <host|id> --yes             Remove it and its key from the vault; files stay
  trust <file>                       Trust the CA certificates in a PEM file for requests
  untrust --yes                      Trust only the system's CA certificates again

Certificates are read from files once and kept in the API Workbench vault, opened with its
password (API_WORKBENCH_VAULT_PASSWORD, or typed at a terminal). Keys and passphrases are never
printed.

${TARGET_HELP}`,
  spec: `api-workbench spec <command>

  list
  show <spec|file>                   Version, title, and operations
  lint <spec|file>                   Errors and warnings; exits 1 on an error. A .yaml,
                                     .yml, or .json file needs no workspace
  import <file> [--name <name>]      Add an OpenAPI 3 or Swagger 2 document to the workspace
  export <spec> [-o <file>]          Its text, exactly as saved
  generate <spec|file> [--collection <name>] [--replace]
                                     Requests for every operation, in a collection
  create -c <collection> [--name <name>] [--format yaml|json]
                                     A specification describing a collection's requests

${TARGET_HELP}`,
  mock: `api-workbench mock <command>

  list
  show <mock>                        Its port, settings, and routes
  create <name> (--spec <spec|file> | -c <collection>) [--port <port>]
                                     A mock server answering for a specification's operations,
                                     or with a collection's saved responses
  update <mock> --settings-file <file>
                                     Change its settings from JSON, as show --json gives them in
                                     "settings": name, port, cors, corsOptions, defaultHeaders,
                                     https, grpcPort, mqttPort, and routes [{"id", "enabled",
                                     "status", "delayMs", "method", "path", "name",
                                     "headers", "body"}]; only what it names changes.
                                     addRoutes [{"method", "path", "status", "name"}] adds
                                     routes and removeRoutes ["<id>"] removes them; a mock
                                     made from a collection keeps it in step
  sync <mock>                        Put a mock made from a collection in step with it, both
                                     ways: a route for each request without one, a request
                                     for each route without one
  start <mock> [--port <port>]       Serve a mock server until Ctrl+C, logging each request

${TARGET_HELP}`,
  history: `api-workbench history <command>

  list [--limit <n>]                 Recent sends, newest first (default 20)
  clear --yes                        Your history; teammates' stays theirs

${TARGET_HELP}`,
  cookie: `api-workbench cookie <command>

  list [--domain <domain>]           The cookie jar: names, domains, and expiry; values are hidden
  delete <name> [--domain <domain>]
  clear --yes

${TARGET_HELP}`,
  team: `api-workbench team <command>

  status                             Branch, commits to push and pull, and changed files
  commit -m <message>                Commit the team folder's changes
  pull [--keep mine|theirs]          Pull; --keep chooses for files changed on both sides
  push
  sync -m <message> [--keep …]       Commit, pull, and push, as the app's Sync does

Works on a team workspace: -w for one in the app, or --dir for its folder. git uses your own
name and email when it has them.

${TARGET_HELP}`,
};

// Commands

async function workspaceCommand(
  sub: string,
  parsed: Parsed,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const asJson = parsed.flags.has('--json');
  if (sub === 'show') {
    const [wanted] = positionals(parsed, ['workspace'], 1);
    const target = await openTarget(
      {
        dataDir: one(parsed, '--data-dir'),
        workspace: wanted ?? one(parsed, '--workspace'),
        dir: one(parsed, '--dir'),
      },
      context.env,
    );
    try {
      const { state } = target;
      const summary = {
        name: target.name,
        id: target.id,
        kind: target.kind,
        collections: collections(state),
        requests: state.requests.length,
        environments: state.environments.map((item) => item.name),
        specs: (state.specs ?? []).map((item) => item.name),
        mocks: (state.mocks ?? []).map((item) => item.name),
      };
      if (asJson) json(output, summary);
      else {
        output.out(`${printable(target.name)} (${target.kind})`);
        table(
          [
            ['Collections', `${summary.collections.length}  ${summary.collections.join(', ')}`],
            ['Requests', String(summary.requests)],
            ['Environments', `${summary.environments.length}  ${summary.environments.join(', ')}`],
            ['Specifications', `${summary.specs.length}  ${summary.specs.join(', ')}`],
            ['Mock servers', `${summary.mocks.length}  ${summary.mocks.join(', ')}`],
          ],
          (line) => output.out(`  ${line}`),
        );
      }
      return 0;
    } finally {
      await target.close();
    }
  }
  if (one(parsed, '--dir'))
    throw new UsageError(`workspace ${sub} works on the app's workspaces, not --dir.`);
  const { store } = await openStore({ dataDir: one(parsed, '--data-dir') }, context.env);
  try {
    const index = await store.list();
    switch (sub) {
      case 'list': {
        positionals(parsed, []);
        const rows = index.workspaces.map((item) => ({
          id: item.id,
          name: item.name,
          active: item.id === index.activeId,
          kind: item.folder ? 'team' : 'local',
          ...(item.folder ? { folder: item.folder } : {}),
          updatedAt: item.updatedAt,
        }));
        if (asJson) json(output, rows);
        else
          table(
            [
              ['', 'NAME', 'KIND', 'ID'],
              ...rows.map((row) => [row.active ? '*' : '', row.name, row.kind, row.id]),
            ],
            output.out,
          );
        return 0;
      }
      case 'create': {
        const [name] = positionals(parsed, ['name']);
        const entry = await store.create(name, newWorkspaceState(name));
        if (asJson) json(output, entry);
        else output.out(`Created workspace “${printable(entry.name)}” (${entry.id}).`);
        return 0;
      }
      case 'rename': {
        const [wanted, name] = positionals(parsed, ['workspace', 'name']);
        const entry = findWorkspace(index.workspaces, wanted);
        await store.rename(entry.id, name);
        output.out(`Renamed “${printable(entry.name)}” to “${printable(name.trim())}”.`);
        return 0;
      }
      case 'use': {
        const [wanted] = positionals(parsed, ['workspace']);
        const entry = findWorkspace(index.workspaces, wanted);
        await store.activate(entry.id);
        output.out(`“${printable(entry.name)}” is now the active workspace.`);
        return 0;
      }
      case 'delete': {
        const [wanted] = positionals(parsed, ['workspace']);
        const entry = findWorkspace(index.workspaces, wanted);
        confirm(parsed, `the workspace “${entry.name}”`);
        await store.delete(entry.id).catch((error: Error) => {
          throw new UsageError(error.message);
        });
        output.out(
          entry.folder
            ? `Removed “${printable(entry.name)}” from this device; its team folder ${entry.folder} is kept.`
            : `Deleted workspace “${printable(entry.name)}”.`,
        );
        return 0;
      }
    }
  } finally {
    store.close();
  }
  return 0;
}

async function collectionCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  const { state } = target;
  const asJson = parsed.flags.has('--json');
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const rows = collections(state).map((name) => {
        const requests = state.requests.filter((request) => collectionOf(request.folder) === name);
        return {
          name,
          requests: requests.length,
          folders: new Set(
            requests.map((request) => request.folder).filter((folder) => folder !== name),
          ).size,
        };
      });
      if (asJson) json(output, rows);
      else
        table(
          [
            ['NAME', 'REQUESTS', 'FOLDERS'],
            ...rows.map((row) => [row.name, String(row.requests), String(row.folders)]),
          ],
          output.out,
        );
      return 0;
    }
    case 'create': {
      const [name] = positionals(parsed, ['name']);
      const problem = folderNameProblem(name.trim());
      if (problem) throw new UsageError(problem);
      if (collections(state).some((item) => item.toLowerCase() === name.trim().toLowerCase()))
        throw new UsageError(`There is already a collection “${name.trim()}”.`);
      // Collections exist through their requests, so it starts with one, as in the app.
      state.requests.push(
        completeRequest({
          name: 'Untitled request',
          method: 'GET',
          url: 'https://',
          folder: name.trim(),
        }),
      );
      await target.save();
      output.out(`Created collection “${printable(name.trim())}” in ${printable(target.name)}.`);
      return 0;
    }
    case 'rename': {
      const [wanted, name] = positionals(parsed, ['collection', 'name']);
      const from = findFolder(state, wanted);
      const to = name.trim();
      for (const part of to.split('/')) {
        const problem = folderNameProblem(part);
        if (problem) throw new UsageError(problem);
      }
      if (to !== from && folderPaths(state).some((item) => item === to))
        throw new UsageError(`There is already a collection or folder “${to}”.`);
      for (const request of state.requests)
        if (isWithin(request.folder, from))
          request.folder = moveFolderPath(request.folder, from, to);
      // Mocks made from it stay in step with it under its new name.
      renameMockCollections(state.mocks, from, to);
      for (const settings of [
        state.collectionAuth,
        state.collectionHttpSettings,
        state.collectionScripts,
        state.collectionTags,
      ] as Record<string, unknown>[])
        if (settings)
          for (const key of Object.keys(settings))
            if (isWithin(key, from)) {
              settings[moveFolderPath(key, from, to)] = settings[key];
              delete settings[key];
            }
      await target.save();
      output.out(`Renamed “${printable(from)}” to “${printable(to)}”.`);
      return 0;
    }
    case 'delete': {
      const [wanted] = positionals(parsed, ['collection']);
      const folder = findFolder(state, wanted);
      const count = state.requests.filter((request) => isWithin(request.folder, folder)).length;
      // A workspace always has a request, as in the app, so the last collection stays.
      if (count === state.requests.length)
        throw new UsageError(
          `“${folder}” holds every request in ${target.name}, and a workspace keeps at least one. Create another collection first.`,
        );
      confirm(parsed, `“${folder}” and its ${count} ${count === 1 ? 'request' : 'requests'}`);
      const removed = new Set(
        state.requests
          .filter((request) => isWithin(request.folder, folder))
          .map((request) => request.id),
      );
      state.requests = state.requests.filter((request) => !removed.has(request.id));
      state.tabs = state.tabs.filter((id) => !removed.has(id));
      if (state.active && removed.has(state.active)) state.active = state.tabs[0];
      for (const settings of [
        state.collectionAuth,
        state.collectionHttpSettings,
        state.collectionScripts,
        state.collectionTags,
      ] as Record<string, unknown>[])
        if (settings)
          for (const key of Object.keys(settings)) if (isWithin(key, folder)) delete settings[key];
      await target.save();
      output.out(
        `Deleted “${printable(folder)}” (${count} ${count === 1 ? 'request' : 'requests'}).`,
      );
      return 0;
    }
    case 'import': {
      const [file] = positionals(parsed, ['file']);
      const data = await fs.readFile(file).catch(() => {
        throw new UsageError(`${file} could not be read.`);
      });
      if (data.length > 10 * 1024 * 1024)
        throw new UsageError('Collection files must be smaller than 10 MB.');
      const result = importFiles([{ name: path.basename(file), data }]);
      for (const warning of result.warnings) output.err(`warning: ${warning}`);
      const into = one(parsed, '--into')?.trim();
      if (into) {
        const problem = folderNameProblem(into);
        if (problem) throw new UsageError(problem);
      }
      const ids = new Set(state.requests.map((request) => request.id));
      const imported = result.data.requests.map((item) => {
        const request = completeRequest(item);
        if (ids.has(request.id)) request.id = randomUUID();
        ids.add(request.id);
        if (into) request.folder = [into, ...request.folder.split('/').slice(1)].join('/');
        return request;
      });
      if (!imported.length) throw new UsageError(`${file} has no requests to import.`);
      const existing = new Set(collections(state).map((name) => name.toLowerCase()));
      const clashes = [...new Set(imported.map((request) => collectionOf(request.folder)))].filter(
        (name) => existing.has(name.toLowerCase()),
      );
      if (clashes.length)
        throw new UsageError(
          `The workspace already has ${clashes.map((name) => `“${name}”`).join(', ')}. Import under another name with --into <name>.`,
        );
      state.requests.push(...imported);
      let environments = 0;
      for (const environment of result.data.environments ?? []) {
        if (state.environments.some((item) => item.name === environment.name)) {
          output.err(`warning: kept the existing environment “${printable(environment.name)}”.`);
          continue;
        }
        state.environments.push(environment);
        environments++;
      }
      if (result.data.collectionHttpSettings)
        state.collectionHttpSettings = {
          ...state.collectionHttpSettings,
          ...result.data.collectionHttpSettings,
        };
      await target.save();
      const names = [...new Set(imported.map((request) => collectionOf(request.folder)))];
      if (asJson)
        json(output, {
          format: result.format,
          collections: names,
          requests: imported.length,
          environments,
        });
      else
        output.out(
          `Imported ${imported.length} ${imported.length === 1 ? 'request' : 'requests'} (${result.format}) into ${names.map((name) => `“${printable(name)}”`).join(', ')}${environments ? `, and ${environments} ${environments === 1 ? 'environment' : 'environments'}` : ''}.`,
        );
      return 0;
    }
    case 'export': {
      const [wanted] = positionals(parsed, ['collection']);
      const folder = findFolder(state, wanted);
      const format = one(parsed, '--format') ?? 'workbench';
      if (!exportFormats.some((item) => item.id === format))
        throw new UsageError(
          `Unknown format “${format}”.${suggest(
            format,
            exportFormats.map((item) => item.id),
          )} Formats: ${exportFormats.map((item) => item.id).join(', ')}.`,
        );
      const requests = state.requests.filter((request) => isWithin(request.folder, folder));
      const result = exportCollection(
        {
          ...state,
          requests,
          history: [],
          tabs: [],
          cookieJar: undefined,
          // Exports are named after the workspace; this one is the collection's.
          settings: { ...state.settings, workspaceName: folder } as WorkspaceState['settings'],
        },
        format,
      );
      for (const warning of result.warnings) output.err(`warning: ${warning}`);
      const file = one(parsed, '--output');
      const text = /json|yaml|text|xml/.test(result.type);
      if (!file && !text)
        throw new UsageError(`The ${format} export is a ${result.type} file: give -o <file>.`);
      if (file) {
        await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
        await fs.writeFile(file, result.data);
        output.err(`Exported “${printable(folder)}” (${requests.length} requests) to ${file}.`);
      } else output.out(Buffer.from(result.data).toString('utf8').trimEnd());
      return 0;
    }
  }
  return 0;
}

/** The environment's values, then built-in {{$dynamic}} values; unknown names stay as typed. */
function resolver(environment: Environment | undefined) {
  return (value: string) =>
    String(value).replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const name = key.trim();
      return (
        environment?.variables.find((variable) => variable.enabled && variable.key === name)
          ?.value ??
        dynamicValue(name) ??
        match
      );
    });
}
const REDACTED = '<REDACTED>';
/** A request as code input, with secret-looking headers, query values, and fields redacted. */
function codegenInput(
  state: WorkspaceState,
  request: ApiRequest,
  environment?: Environment,
): CodegenInput {
  const payload = preparePayload(request, { workspace: state, resolve: resolver(environment) });
  const headers = { ...payload.headers };
  if (payload.credentialId) headers.Authorization = 'Bearer <ACCESS_TOKEN>';
  for (const key of Object.keys(headers))
    if (SECRET_NAME.test(key))
      headers[key] =
        key.toLowerCase() === 'authorization'
          ? `${/^(Basic|Bearer)\s/i.exec(headers[key])?.[1] || 'Bearer'} ${REDACTED}`
          : REDACTED;
  const url = new URL(payload.url);
  url.username = url.password = '';
  const params = [...url.searchParams];
  url.search = '';
  for (const [key, value] of params)
    url.searchParams.append(key, SECRET_NAME.test(key) ? REDACTED : value);
  let body = payload.body;
  try {
    body = JSON.stringify(
      JSON.parse(body),
      (key, value: unknown) => (SECRET_NAME.test(key) ? REDACTED : value),
      2,
    );
  } catch {
    /* Other bodies are kept as they are. */
  }
  return {
    url: url.toString(),
    method: request.method,
    headers,
    body: payload.multipart || payload.binary ? '' : body,
    bodyType: payload.multipart ? 'form-data' : payload.binary ? 'binary' : body ? 'raw' : 'none',
    binaryName: payload.binary?.name,
    fields: (payload.multipart ?? []).map((field) => ({
      name: field.name,
      value: SECRET_NAME.test(field.name) ? REDACTED : field.value,
      ...(field.file ? { fileName: field.file.name || 'upload.bin' } : {}),
    })),
  };
}

async function requestCommand(
  sub: string,
  parsed: Parsed,
  target: RequestTarget,
  output: Output,
): Promise<number> {
  const { state } = target;
  const asJson = parsed.flags.has('--json');
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const wanted = one(parsed, '--collection');
      const folder = wanted ? findFolder(state, wanted) : undefined;
      const rows = state.requests
        .filter((request) => !folder || isWithin(request.folder, folder))
        .map(requestRow);
      if (asJson) json(output, rows);
      else
        table(
          [
            ['METHOD', 'NAME', 'FOLDER', 'URL'],
            ...rows.map((row) => [
              row.protocol === 'http' ? row.method : row.protocol,
              row.name,
              row.folder,
              row.url,
            ]),
          ],
          output.out,
        );
      return 0;
    }
    case 'show': {
      const [wanted] = positionals(parsed, ['request']);
      const request = findRequest(state, wanted);
      const headers = request.headers
        .filter((header) => header.key)
        .map((header) => ({
          key: header.key,
          value: hidden(header.key, header.value),
          enabled: header.enabled,
        }));
      const shown = {
        ...requestRow(request),
        // A gRPC call's method and TLS; its schema is shown in the app.
        // A gRPC call's method, TLS, schema, and the methods the schema has.
        ...(request.grpc
          ? {
              grpc: {
                method: request.grpc.method,
                tls: request.grpc.tls,
                proto: request.grpc.proto,
                methods: grpcMethods(request.grpc.proto),
              },
            }
          : {}),
        // Socket.IO's path and event, and MQTT's topics; a broker's password stays in its auth.
        ...(request.socketio ? { socketio: request.socketio } : {}),
        ...(request.mqtt ? { mqtt: request.mqtt } : {}),
        auth: request.auth,
        tags: request.tags ?? [],
        inheritedTags: inheritedTags(state, request.folder),
        headers,
        body: request.body ? `${new TextEncoder().encode(request.body).length} bytes` : undefined,
        tests: request.tests ? request.tests.split('\n').filter((line) => line.trim()) : [],
        captures: (request.captures ?? []).map((capture) => ({
          variable: capture.key,
          from: capture.value,
          enabled: capture.enabled,
        })),
      };
      // The body itself goes only to scripts, such as the VS Code extension's request editor;
      // the text output keeps to its size.
      if (asJson)
        return (
          json(output, {
            ...shown,
            bodyText: request.body ?? '',
            bodyType: request.bodyType ?? 'none',
            ...(request.binaryName ? { binaryName: request.binaryName } : {}),
            // The files a .http file's request names (`< ./path`), sent with it: their names.
            ...(target.fileUploads?.[request.id]
              ? {
                  fileUploads: {
                    ...(target.fileUploads[request.id].binary
                      ? { binary: path.basename(target.fileUploads[request.id].binary!) }
                      : {}),
                    fields: Object.fromEntries(
                      Object.entries(target.fileUploads[request.id].fields).map(([field, file]) => [
                        field,
                        path.basename(file),
                      ]),
                    ),
                  },
                }
              : {}),
            // Auth without its secrets: its settings, and only whether each secret is saved.
            authDetails: authDetails(request),
            scripts: { pre: request.scripts?.pre ?? '', post: request.scripts?.post ?? '' },
            formFields: (request.bodyFields ?? []).map((field) => ({
              key: field.key,
              value: field.kind === 'file' ? '' : hidden(field.key, field.value),
              enabled: field.enabled,
              kind: field.kind ?? 'text',
              ...(field.fileName ? { fileName: field.fileName } : {}),
            })),
          }),
          0
        );
      output.out(
        `${shown.protocol === 'http' ? request.method : shown.protocol} ${printable(shown.url)}`,
      );
      table(
        [
          ['Name', request.name],
          ['Folder', request.folder],
          ['Id', request.id],
          ['Auth', request.auth],
          ...(shown.tags.length || shown.inheritedTags.length
            ? [
                [
                  'Tags',
                  [
                    ...shown.tags.map((tag) => `#${tag}`),
                    ...shown.inheritedTags.map(({ tag, from }) => `#${tag} (from ${from})`),
                  ].join(' '),
                ],
              ]
            : []),
          ...(shown.body ? [['Body', shown.body]] : []),
        ],
        (line) => output.out(`  ${line}`),
      );
      if (headers.length) {
        output.out('Headers:');
        for (const header of headers)
          output.out(
            `  ${header.enabled ? '' : '# '}${printable(header.key)}: ${printable(header.value)}`,
          );
      }
      if (shown.tests.length) {
        output.out('Tests:');
        for (const line of shown.tests) output.out(`  ${printable(line)}`);
      }
      if (shown.captures.length) {
        output.out('Captures:');
        for (const capture of shown.captures)
          output.out(
            `  ${capture.enabled ? '' : '# '}${printable(capture.variable)} ← ${printable(capture.from)}`,
          );
      }
      return 0;
    }
    case 'delete': {
      const [wanted] = positionals(parsed, ['request']);
      const request = findRequest(state, wanted);
      if (state.requests.length === 1)
        throw new UsageError(
          'This is the workspace’s only request, and a workspace keeps at least one.',
        );
      confirm(parsed, `the request “${request.name}”`);
      state.requests = state.requests.filter((item) => item !== request);
      state.tabs = state.tabs.filter((id) => id !== request.id);
      if (state.active === request.id) state.active = state.tabs[0];
      await target.save();
      output.out(`Deleted “${printable(request.name)}”.`);
      return 0;
    }
    case 'code': {
      const targets = codegenTargets();
      if (parsed.flags.has('--list')) {
        positionals(parsed, []);
        if (asJson) return (json(output, targets), 0);
        table(
          [
            ['LANG', 'CLIENTS'],
            ...targets.map((item) => [item.id, item.clients.map((client) => client.id).join(', ')]),
          ],
          output.out,
        );
        return 0;
      }
      const [wanted] = positionals(parsed, ['request']);
      const request = findRequest(state, wanted);
      if (protocolOf(request) !== 'http')
        throw new UsageError('Code for live protocol requests is generated in the app.');
      const langId = one(parsed, '--lang') ?? 'shell';
      const lang = targets.find((item) => item.id === langId);
      if (!lang)
        throw new UsageError(
          `Unknown language “${langId}”.${suggest(
            langId,
            targets.map((item) => item.id),
          )} See request code --list.`,
        );
      const clientId = one(parsed, '--client') ?? lang.clients[0].id;
      if (!lang.clients.some((client) => client.id === clientId))
        throw new UsageError(
          `${lang.label} has no client “${clientId}”.${suggest(
            clientId,
            lang.clients.map((client) => client.id),
          )} Clients: ${lang.clients.map((client) => client.id).join(', ')}.`,
        );
      const environmentName = one(parsed, '--environment');
      const environment = environmentName
        ? findEnvironment(state, environmentName)
        : state.environments[state.environment];
      let input: CodegenInput;
      try {
        input = codegenInput(state, request, environment);
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      const result = generateCode(input, lang.id, clientId);
      if (asJson) return (json(output, result), 0);
      output.out(result.code.trimEnd());
      for (const note of result.notes) output.err(`note: ${note}`);
      return 0;
    }
  }
  return 0;
}

async function environmentCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { state } = target;
  const { output } = context;
  const asJson = parsed.flags.has('--json');
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const rows = state.environments.map((environment, index) => ({
        name: environment.name,
        variables: environment.variables.length,
        active: index === state.environment,
      }));
      if (asJson) json(output, rows);
      else
        table(
          [
            ['', 'NAME', 'VARIABLES'],
            ...rows.map((row) => [row.active ? '*' : '', row.name, String(row.variables)]),
          ],
          output.out,
        );
      return 0;
    }
    case 'show': {
      const [wanted] = positionals(parsed, ['environment']);
      const environment = findEnvironment(state, wanted);
      const rows = environment.variables.map((variable) => ({
        key: variable.key,
        value: hidden(variable.key, variable.value),
        enabled: variable.enabled,
      }));
      if (asJson) json(output, { name: environment.name, variables: rows });
      else {
        output.out(printable(environment.name));
        table(
          rows.map((row) => [`  ${row.enabled ? '' : '# '}${row.key}`, row.value]),
          output.out,
        );
      }
      return 0;
    }
    case 'create': {
      const [name] = positionals(parsed, ['name']);
      nameProblem(name, 'environment');
      if (state.environments.some((item) => item.name.toLowerCase() === name.trim().toLowerCase()))
        throw new UsageError(`There is already an environment “${name.trim()}”.`);
      const copy = one(parsed, '--copy');
      const variables = copy ? structuredClone(findEnvironment(state, copy).variables) : [];
      state.environments.push({ name: name.trim(), variables });
      await target.save();
      output.out(
        `Created environment “${printable(name.trim())}”${copy ? ` from “${printable(copy)}”` : ''}.`,
      );
      return 0;
    }
    case 'rename': {
      const [wanted, name] = positionals(parsed, ['environment', 'name']);
      nameProblem(name, 'environment');
      const environment = findEnvironment(state, wanted);
      if (
        state.environments.some(
          (item) => item !== environment && item.name.toLowerCase() === name.trim().toLowerCase(),
        )
      )
        throw new UsageError(`There is already an environment “${name.trim()}”.`);
      const before = environment.name;
      environment.name = name.trim();
      await target.save();
      output.out(`Renamed “${printable(before)}” to “${printable(environment.name)}”.`);
      return 0;
    }
    case 'delete': {
      const [wanted] = positionals(parsed, ['environment']);
      const environment = findEnvironment(state, wanted);
      if (state.environments.length === 1)
        throw new UsageError(
          'This is the workspace’s only environment, and a workspace keeps at least one.',
        );
      confirm(parsed, `the environment “${environment.name}”`);
      const index = state.environments.indexOf(environment);
      state.environments.splice(index, 1);
      if (state.environment >= state.environments.length)
        state.environment = Math.max(0, state.environments.length - 1);
      else if (state.environment > index) state.environment--;
      await target.save();
      output.out(`Deleted environment “${printable(environment.name)}”.`);
      return 0;
    }
    case 'set': {
      const [wanted, ...assignments] = parsed.positionals;
      if (!wanted || !assignments.length) throw new UsageError('Give <environment> <name=value>….');
      const environment = findEnvironment(state, wanted);
      const values = assignments.map((text) => variableAssignment(text, context.env));
      // A team folder shares only what is safe to share: a secret's value stays on each
      // teammate's own device, so one set here would never reach the folder.
      if (target.kind === 'team folder' && (!target.vaultPath || target.joined)) {
        const secret = values.find(([key]) => SECRET_NAME.test(key));
        if (secret)
          throw new UsageError(
            `“${secret[0]}” looks secret, and team folders never hold secret values. Give it with run --var in CI, or set it in the app.`,
          );
      }
      for (const [key, value] of values) {
        const existing = environment.variables.find((variable) => variable.key === key);
        if (existing) Object.assign(existing, { value, enabled: true });
        else environment.variables.push({ enabled: true, key, value });
      }
      await target.save();
      output.out(
        `Set ${values.map(([key]) => printable(key)).join(', ')} in “${printable(environment.name)}”.`,
      );
      return 0;
    }
    case 'update': {
      // The whole list at once, as the VS Code environment page saves it: order, values, and
      // which are on. Values come from an environment variable, never arguments.
      const [wanted] = positionals(parsed, ['environment']);
      const environment = findEnvironment(state, wanted);
      const variable = one(parsed, '--variables-from-env');
      if (!variable)
        throw new UsageError('Give the variables with --variables-from-env <VAR>, as JSON.');
      const text = context.env[variable];
      if (text === undefined)
        throw new UsageError(`The environment variable ${variable} is not set.`);
      let rows: unknown;
      try {
        rows = JSON.parse(text);
      } catch {
        throw new UsageError(`${variable} holds JSON: [{"key", "value", "enabled"}].`);
      }
      if (!Array.isArray(rows) || rows.length > 1000)
        throw new UsageError(`${variable} holds a list of {"key", "value", "enabled"}.`);
      const before = environment.variables;
      const next = rows.map((row: unknown, index) => {
        const { key, value, enabled } = (row ?? {}) as Record<string, unknown>;
        if (typeof key !== 'string' || !/^[^\s={}]+$/.test(key.trim()) || typeof value !== 'string')
          throw new UsageError(
            `Variable ${index + 1} needs a name without spaces, “=”, or braces, and a value.`,
          );
        const name = key.trim();
        // A value still hidden keeps the one it had.
        const old = before.find((item) => item.key === name);
        const kept = value === '<hidden>' ? old?.value : value;
        if (kept === undefined) throw new UsageError(`${name} has no value to keep.`);
        return { enabled: enabled !== false, key: name, value: kept };
      });
      const names = next.map((row) => row.key);
      const twice = names.find((name, at) => names.indexOf(name) !== at);
      if (twice) throw new UsageError(`“${printable(twice)}” is there twice.`);
      if (target.kind === 'team folder' && (!target.vaultPath || target.joined)) {
        const secret = next.find(
          (row) =>
            SECRET_NAME.test(row.key) &&
            row.value &&
            !/^\{\{[^}]*\}\}$/.test(row.value) &&
            before.find((item) => item.key === row.key)?.value !== row.value,
        );
        if (secret)
          throw new UsageError(
            `“${secret.key}” looks secret, and team folders never hold secret values. Use a {{variable}}, give it with run --var in CI, or set it in the app.`,
          );
      }
      environment.variables = next;
      await target.save();
      if (parsed.flags.has('--json'))
        json(output, { name: environment.name, variables: next.length });
      else
        output.out(
          `Saved ${next.length} variable${next.length === 1 ? '' : 's'} in “${printable(environment.name)}”.`,
        );
      return 0;
    }
    case 'unset': {
      const [wanted, ...keys] = parsed.positionals;
      if (!wanted || !keys.length) throw new UsageError('Give <environment> <name>….');
      const environment = findEnvironment(state, wanted);
      for (const key of keys)
        if (!environment.variables.some((variable) => variable.key === key))
          throw new UsageError(
            `“${environment.name}” has no variable “${key}”.${suggest(
              key,
              environment.variables.map((variable) => variable.key),
            )}`,
          );
      environment.variables = environment.variables.filter(
        (variable) => !keys.includes(variable.key),
      );
      await target.save();
      output.out(
        `Removed ${keys.map(printable).join(', ')} from “${printable(environment.name)}”.`,
      );
      return 0;
    }
  }
  return 0;
}

/**
 * A credential's fields from `--fields-from-env`: JSON with `secret`, `extraSecret`, `username`,
 * `headerName`, `options` (the type's settings), and `oauth` (an OAuth 2.0 credential's client).
 * Only these, each the type it should be; the vault checks the rest when it saves.
 */
function credentialFields(
  text: string | undefined,
  variable: string,
): {
  secret?: string;
  extraSecret?: string;
  username?: string;
  headerName?: string;
  options?: CredentialInput['options'];
  oauth?: Partial<NonNullable<CredentialInput['oauth']>>;
} {
  if (text === undefined) throw new UsageError(`The environment variable ${variable} is not set.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${variable} holds JSON: {"secret", "username", "options": {…}, …}.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UsageError(`${variable} holds a JSON object.`);
  const given = value as Record<string, unknown>;
  const allowed = ['secret', 'extraSecret', 'username', 'headerName', 'options', 'oauth'];
  for (const key of Object.keys(given))
    if (!allowed.includes(key))
      throw new UsageError(`A credential has no field “${printable(key)}”.`);
  const text_ = (key: string) => {
    const item = given[key];
    if (item === undefined || item === '') return undefined;
    if (typeof item !== 'string' || item.length > 64 * 1024)
      throw new UsageError(`The credential's “${key}” is text.`);
    return item;
  };
  const object = (key: string) => {
    const item = given[key];
    if (item === undefined) return undefined;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new UsageError(`The credential's “${key}” is an object.`);
    for (const [name, field] of Object.entries(item))
      if (
        !['string', 'boolean', 'number'].includes(typeof field) ||
        (typeof field === 'string' && field.length > 64 * 1024)
      )
        throw new UsageError(`The credential's “${key}.${printable(name)}” is not a setting.`);
    return item as Record<string, string | boolean | number>;
  };
  return {
    secret: text_('secret'),
    extraSecret: text_('extraSecret'),
    username: text_('username'),
    headerName: text_('headerName'),
    options: object('options') as CredentialInput['options'],
    oauth: object('oauth') as Partial<NonNullable<CredentialInput['oauth']>>,
  };
}

/** The kinds `secret set` saves; client certificates and external providers are set up in the app. */
const SECRET_KINDS: CredentialKind[] = [
  'bearer',
  'basic',
  'api-key',
  'digest',
  'jwt',
  'aws',
  'oauth1',
  'ntlm',
  'wsse',
  'edgegrid',
  'hawk',
  'oauth2',
];
async function secretCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const { vault, close } = await openVault(
    target.vaultPath,
    target.vaultDir ?? target.dataDir,
    context.password ?? terminalPassword(context.env),
  );
  try {
    const records = await vault.list().catch((error: Error) => {
      throw error instanceof UsageError ? error : new UsageError(error.message);
    });
    switch (sub) {
      case 'list': {
        positionals(parsed, []);
        const rows = records.map((record) => ({
          id: record.id,
          name: record.name,
          type: record.kind,
          origin: record.allowedOrigin,
          hasSecret: record.hasSecret,
          updatedAt: record.updatedAt,
          // Settings, never secrets: the vault's summary leaves those out.
          ...(record.username ? { username: record.username } : {}),
          ...(record.headerName ? { headerName: record.headerName } : {}),
          ...(record.options ? { options: record.options } : {}),
          ...(record.oauth ? { oauth: record.oauth } : {}),
          ...(record.hasExtraSecret ? { hasExtraSecret: true } : {}),
          ...(record.external ? { external: true } : {}),
          ...(record.clientCertificate ? { certificate: true } : {}),
          connected: record.connected,
          ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        }));
        if (parsed.flags.has('--json')) json(output, rows);
        else
          table(
            [
              ['NAME', 'TYPE', 'ALLOWED ORIGIN'],
              ...rows.map((row) => [row.name, row.type, row.origin]),
            ],
            output.out,
          );
        return 0;
      }
      case 'set': {
        const [name] = positionals(parsed, ['name']);
        const existing = records.find((record) => record.name === name.trim());
        const kind = (one(parsed, '--type') ?? existing?.kind) as CredentialKind | undefined;
        if (!kind || !SECRET_KINDS.includes(kind))
          throw new UsageError(
            `Give --type ${SECRET_KINDS.join(', ')}. Client certificates and external secret providers are set up in the app.`,
          );
        const origin = one(parsed, '--origin') ?? existing?.allowedOrigin;
        if (!origin)
          throw new UsageError(
            'Give --origin, the URL the credential may be sent to, such as https://api.example.com.',
          );
        try {
          if (!['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error();
        } catch {
          throw new UsageError(`--origin must be an http or https URL: ${origin}`);
        }
        const fromEnv = one(parsed, '--from-env');
        if (fromEnv && parsed.flags.has('--stdin'))
          throw new UsageError('Give the secret with --stdin or --from-env <VAR>, not both.');
        let secret: string | undefined = fromEnv
          ? context.env[fromEnv]
          : parsed.flags.has('--stdin')
            ? (await context.stdin()).replace(/\r?\n$/, '')
            : undefined;
        if (fromEnv && secret === undefined)
          throw new UsageError(`The environment variable ${fromEnv} is not set.`);
        // Every other field, secrets included, as JSON in an environment variable.
        const fieldsVariable = one(parsed, '--fields-from-env');
        const fields = fieldsVariable
          ? credentialFields(context.env[fieldsVariable], fieldsVariable)
          : {};
        secret = secret || fields.secret;
        // A new credential, or one changing kind, needs its secret; otherwise the vault keeps it.
        const keeps = existing && existing.kind === kind && existing.hasSecret;
        if (!secret && !keeps && kind !== 'oauth2')
          throw new UsageError(
            'Give the secret with --stdin or --from-env <VAR>, or as "secret" in --fields-from-env — never as an argument.',
          );
        const username = one(parsed, '--username') ?? fields.username ?? existing?.username;
        if (kind === 'basic' && !username)
          throw new UsageError('A basic credential needs --username.');
        const input: CredentialInput = {
          ...(existing ? { id: existing.id } : {}),
          name: name.trim(),
          kind,
          allowedOrigin: origin,
          ...(secret ? { secret } : {}),
          ...(fields.extraSecret ? { extraSecret: fields.extraSecret } : {}),
          ...(username ? { username } : {}),
          ...(kind === 'api-key'
            ? {
                headerName:
                  one(parsed, '--header') ||
                  fields.headerName ||
                  existing?.headerName ||
                  'X-API-Key',
              }
            : {}),
          ...(fields.options || existing?.options
            ? {
                options: {
                  ...(existing?.kind === kind ? existing.options : {}),
                  ...fields.options,
                },
              }
            : {}),
          ...(kind === 'oauth2'
            ? {
                // As the app starts one: a client credentials grant, Basic client auth, and its port.
                oauth: {
                  grantType: 'client_credentials',
                  authorizationUrl: '',
                  tokenUrl: '',
                  clientId: '',
                  scope: '',
                  audience: '',
                  clientAuth: 'basic',
                  callbackPort: 43821,
                  ...(existing?.kind === 'oauth2' ? existing.oauth : {}),
                  ...fields.oauth,
                } as CredentialInput['oauth'],
              }
            : {}),
        };
        const saved = await vault.save(input).catch((error: Error) => {
          throw new UsageError(error.message);
        });
        if (parsed.flags.has('--json'))
          json(output, {
            id: saved.id,
            name: saved.name,
            type: saved.kind,
            origin: saved.allowedOrigin,
          });
        else
          output.out(
            `${existing ? 'Updated' : 'Saved'} credential “${printable(saved.name)}” (${saved.kind}, ${saved.allowedOrigin}).`,
          );
        return 0;
      }
      case 'delete': {
        const [name] = positionals(parsed, ['name']);
        const record =
          records.find((item) => item.id === name || item.name === name) ??
          (() => {
            throw new UsageError(
              `No credential “${name}”.${suggest(
                name,
                records.map((item) => item.name),
              )}`,
            );
          })();
        confirm(parsed, `the credential “${record.name}”`);
        await vault.delete(record.id);
        output.out(`Deleted credential “${printable(record.name)}”.`);
        return 0;
      }
    }
  } finally {
    close();
  }
  return 0;
}

/**
 * Gives a collection file's requests a workspace's environment: `wanted`, or the one it uses. Its
 * variables are the file's one environment, under the file's own (`@name = value`), which win as
 * in REST Client; `-v` values win over both when sent. The workspace is only read.
 */
function withWorkspaceEnvironment(
  file: RequestTarget,
  from: Target,
  wanted: string | undefined,
): void {
  const environments = from.state.environments;
  const chosen =
    wanted === undefined
      ? environments[from.state.environment]
      : (environments.find((item) => item.name === wanted) ??
        (() => {
          throw new UsageError(
            `No environment “${wanted}” in ${from.name}.${suggest(
              wanted,
              environments.map((item) => item.name),
            )} Environments: ${environments.map((item) => item.name).join(', ') || 'none'}.`,
          );
        })());
  if (!chosen) return;
  const own = file.state.environments[0]?.variables ?? [];
  const mine = new Set(own.filter((item) => item.enabled).map((item) => item.key));
  file.state.environments = [
    {
      name: chosen.name,
      variables: [
        ...chosen.variables.filter((item) => item.enabled && !mine.has(item.key)),
        ...own,
      ],
    },
  ];
  file.state.environment = 0;
}

/** A specification in the workspace by name or id, or else a file of one. */
async function specOrFile(
  state: WorkspaceState,
  wanted: string,
): Promise<{ spec?: ApiSpec; name: string; content: string }> {
  const specs = state.specs ?? [];
  const spec =
    specs.find((item) => item.id === wanted || item.name === wanted) ??
    specs.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
  if (spec) return { spec, name: spec.name, content: spec.content };
  const content = await fs.readFile(wanted, 'utf8').catch(() => undefined);
  if (content === undefined)
    throw new UsageError(
      `No specification or file “${wanted}”.${suggest(
        wanted,
        specs.map((item) => item.name),
      )} Specifications: ${specs.map((item) => item.name).join(', ') || 'none'}.`,
    );
  return { name: path.basename(wanted).replace(/\.[^.]+$/, ''), content };
}

async function specCommand(
  sub: string,
  parsed: Parsed,
  target: RequestTarget,
  output: Output,
): Promise<number> {
  const { state } = target;
  const asJson = parsed.flags.has('--json');
  switch (sub) {
    case 'list': {
      positionals(parsed, []);
      const rows = (state.specs ?? []).map((spec) => {
        const analysis = analyzeSpec(spec.content);
        return {
          id: spec.id,
          name: spec.name,
          version: analysis.version,
          operations: analysis.endpoints.length,
          errors: analysis.problems.filter((problem) => problem.severity === 'error').length,
          collection: spec.collection,
        };
      });
      if (asJson) json(output, rows);
      else
        table(
          [
            ['NAME', 'VERSION', 'OPERATIONS', 'ERRORS'],
            ...rows.map((row) => [
              row.name,
              row.version ?? '?',
              String(row.operations),
              String(row.errors),
            ]),
          ],
          output.out,
        );
      return 0;
    }
    case 'show':
    case 'lint': {
      const [wanted] = positionals(parsed, ['spec']);
      const { name, content } = await specOrFile(state, wanted);
      const analysis = analyzeSpec(content);
      const errors = analysis.problems.filter((problem) => problem.severity === 'error').length;
      if (asJson) {
        const { document: _document, ...rest } = analysis;
        json(output, { name, ...rest });
        return sub === 'lint' && errors ? 1 : 0;
      }
      if (sub === 'show') {
        output.out(
          `${printable(analysis.title || name)}${analysis.version ? ` (${analysis.version})` : ''}`,
        );
        table(
          analysis.endpoints.map((endpoint) => [
            `  ${endpoint.method.toUpperCase()}`,
            endpoint.path,
            `${endpoint.summary}${endpoint.deprecated ? ' (deprecated)' : ''}`,
          ]),
          output.out,
        );
      }
      for (const problem of analysis.problems)
        (problem.severity === 'error' ? output.err : output.out)(
          `${problem.severity}${problem.line ? ` (line ${problem.line})` : ''}: ${printable(problem.message)}`,
        );
      if (sub === 'lint') {
        const warnings = analysis.problems.length - errors;
        output.out(
          `${printable(name)}: ${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}, ${analysis.endpoints.length} operations.`,
        );
      }
      return sub === 'lint' && errors ? 1 : 0;
    }
    case 'import': {
      const [file] = positionals(parsed, ['file']);
      const content = await fs.readFile(file, 'utf8').catch(() => {
        throw new UsageError(`${file} could not be read.`);
      });
      const analysis = analyzeSpec(content);
      if (!analysis.document || !analysis.version)
        throw new UsageError(
          `${file} is not an OpenAPI 3 or Swagger 2 document: ${analysis.problems[0]?.message ?? 'unrecognised'}`,
        );
      const name = (
        one(parsed, '--name') ??
        analysis.title ??
        path.basename(file).replace(/\.[^.]+$/, '')
      ).trim();
      nameProblem(name, 'specification');
      state.specs ??= [];
      if (state.specs.some((spec) => spec.name.toLowerCase() === name.toLowerCase()))
        throw new UsageError(
          `There is already a specification “${name}”. Give another with --name.`,
        );
      state.specs.push({ id: randomUUID(), name, format: specFormat(content), content });
      await target.save();
      output.out(
        `Imported “${printable(name)}” (${analysis.version}, ${analysis.endpoints.length} operations).`,
      );
      return 0;
    }
    case 'export': {
      const [wanted] = positionals(parsed, ['spec']);
      const { spec } = await specOrFile(state, wanted);
      if (!spec) throw new UsageError(`No specification “${wanted}” in ${target.name}.`);
      const file = one(parsed, '--output');
      if (file) {
        await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
        await fs.writeFile(file, spec.content);
        output.err(`Exported “${printable(spec.name)}” to ${file}.`);
      } else output.out(spec.content.trimEnd());
      return 0;
    }
    case 'generate': {
      const [wanted] = positionals(parsed, ['spec']);
      const { spec, name, content } = await specOrFile(state, wanted);
      const analysis = analyzeSpec(content);
      if (!analysis.document)
        throw new UsageError(
          `The specification cannot be read: ${analysis.problems[0]?.message ?? 'unrecognised'}`,
        );
      const collection = (
        one(parsed, '--collection') ??
        spec?.collection ??
        analysis.title ??
        name
      ).trim();
      const problem = folderNameProblem(collection);
      if (problem) throw new UsageError(problem);
      const exists = state.requests.some((request) => collectionOf(request.folder) === collection);
      if (exists && !parsed.flags.has('--replace'))
        throw new UsageError(
          `There is already a collection “${collection}”. Add --replace to regenerate it, or give --collection.`,
        );
      const requests = requestsFromSpec(analysis.document, collection).map(completeRequest);
      if (!requests.length) throw new UsageError('The specification has no operations.');
      state.requests = [
        ...state.requests.filter((request) => collectionOf(request.folder) !== collection),
        ...requests,
      ];
      if (spec) spec.collection = collection;
      await target.save();
      output.out(
        `Generated ${requests.length} ${requests.length === 1 ? 'request' : 'requests'} in “${printable(collection)}”.`,
      );
      return 0;
    }
  }
  return 0;
}

async function mockCommand(
  sub: string,
  parsed: Parsed,
  target: Target,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const mocks = target.state.mocks ?? [];
  if (sub === 'list') {
    positionals(parsed, []);
    const rows = mocks.map((mock) => ({
      id: mock.id,
      name: mock.name,
      port: mock.port,
      routes: mock.routes.length,
      https: Boolean(mock.https),
    }));
    if (parsed.flags.has('--json')) json(output, rows);
    else
      table(
        [
          ['NAME', 'PORT', 'ROUTES'],
          ...rows.map((row) => [row.name, String(row.port), String(row.routes)]),
        ],
        output.out,
      );
    return 0;
  }
  if (sub === 'create') return createMock(parsed, target, output);
  const [wanted] = positionals(parsed, ['mock']);
  const found =
    mocks.find((mock) => mock.id === wanted || mock.name === wanted) ??
    mocks.find((mock) => mock.name.toLowerCase() === wanted.toLowerCase());
  if (!found)
    throw new UsageError(
      `No mock server “${wanted}”.${suggest(
        wanted,
        mocks.map((mock) => mock.name),
      )} Mock servers: ${mocks.map((mock) => mock.name).join(', ') || 'none'}.`,
    );
  if (sub === 'show') return showMock(found, parsed, output, target.state.requests);
  if (sub === 'sync') return syncMock(found, parsed, target, output);
  if (sub === 'update') return updateMock(found, parsed, target, output);
  const mock = structuredClone(found);
  const port = one(parsed, '--port');
  if (port !== undefined) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new UsageError('--port must be from 1 to 65535.');
    mock.port = number;
  }
  // HTTPS works with the mock's own certificate files. Without them the app issues one from its
  // local certificate authority, whose key stays with the app.
  const https = mock.https?.enabled;
  if (https && !(mock.https?.certFile && mock.https.keyFile))
    throw new UsageError(
      'This mock serves HTTPS with the app’s own certificate authority, so it runs in the app. Give it your own certificate and key files in the app to serve it from here.',
    );
  const servers = new MockServers(
    (entry) =>
      output.out(
        `${entry.time.slice(11, 19)}  ${entry.method.padEnd(6)} ${printable(entry.path)}  ${entry.status}`,
      ),
    async (server) => {
      try {
        return {
          cert: await fs.readFile(server.https!.certFile!, 'utf8'),
          key: await fs.readFile(server.https!.keyFile!, 'utf8'),
        };
      } catch (error) {
        throw new UsageError(`Could not read the certificate files: ${(error as Error).message}`);
      }
    },
  );
  const status = await servers.start(mock).catch((error: Error) => {
    throw new UsageError(error.message);
  });
  const running = status.running.find((item) => item.id === mock.id);
  output.out(
    `Mock “${printable(mock.name)}” on ${https ? 'https' : 'http'}://127.0.0.1:${running?.port ?? mock.port}${running?.grpcPort ? `, gRPC on ${running.grpcPort}` : ''}${running?.mqttPort ? `, MQTT on ${running.mqttPort}` : ''}. Ctrl+C to stop.`,
  );
  await new Promise<void>((resolve) => {
    if (!context.interrupt || context.interrupt.aborted) return resolve();
    context.interrupt.addEventListener('abort', () => resolve(), { once: true });
  });
  await servers.stopAll();
  output.out('Stopped.');
  return 0;
}

/** The methods a gRPC schema defines, or none when it cannot be read yet. */
function grpcMethods(
  proto: string,
): { path: string; requestStream: boolean; responseStream: boolean }[] {
  if (!proto?.trim()) return [];
  try {
    return inspectProto(proto);
  } catch {
    return [];
  }
}

/** `mock show`: what a mock server answers; `--json` adds each route's headers (secret-looking values hidden) and body. */
function showMock(
  mock: MockServer,
  parsed: Parsed,
  output: Output,
  requests: readonly ApiRequest[],
): number {
  const routes = mock.routes.map((route) => ({
    id: route.id,
    enabled: route.enabled,
    kind: route.kind ?? 'http',
    method: route.method,
    path: route.path,
    status: route.status,
    name: route.name ?? '',
    delayMs: route.delayMs,
    rules: (route.rules ?? []).filter((rule) => rule.enabled).length,
    responses: (route.responses ?? []).length,
    validates: Boolean(route.validation?.enabled),
    // What it answers with, for an editor: secret-looking header values hidden, as elsewhere.
    headers: route.headers.map((header) => ({
      key: header.key,
      value: SECRET_NAME.test(header.key) && header.value ? '<hidden>' : header.value,
      enabled: header.enabled,
    })),
    body: route.body,
  }));
  const shown = {
    id: mock.id,
    name: mock.name,
    port: mock.port,
    https: Boolean(mock.https?.enabled),
    cors: mock.cors,
    corsOrigins: mock.cors ? (mock.corsOptions?.origins ?? '*') : '',
    defaultHeaders: (mock.defaultHeaders ?? []).filter((item) => item.enabled).length,
    ...(mock.source ? { source: mock.source } : {}),
    routes,
    settings: mockSettings(mock),
    // For a mock made from a collection: how far the two are from each other.
    ...(mockSyncStatus(requests, mock) ? { collectionSync: mockSyncStatus(requests, mock) } : {}),
  };
  if (parsed.flags.has('--json')) return (json(output, shown), 0);
  output.out(
    `${printable(mock.name)} · port ${mock.port}${shown.https ? ' · HTTPS' : ''}${mock.cors ? ` · CORS ${printable(shown.corsOrigins)}` : ''}`,
  );
  table(
    [
      ['METHOD', 'PATH', 'STATUS', 'NOTE'],
      ...routes.map((route) => [
        route.kind === 'http' ? route.method : route.kind,
        route.path,
        String(route.status),
        [
          route.enabled ? '' : 'off',
          route.name,
          route.rules ? `${route.rules} rule${route.rules === 1 ? '' : 's'}` : '',
          route.delayMs ? `delay ${route.delayMs} ms` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ]),
    ],
    output.out,
  );
  return 0;
}

/**
 * `mock sync`: puts a mock made from a collection fully in step with it, both ways — a route for
 * each request no route answers, and a request for each route with none — and says what it added.
 */
async function syncMock(
  found: MockServer,
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  if (found.source?.kind !== 'collection')
    throw new UsageError(`“${printable(found.name)}” was not made from a collection.`);
  const done = syncMockWithCollection(target.state.requests, found, (request) =>
    completeRequest(request),
  );
  await target.save();
  if (parsed.flags.has('--json')) json(output, { collection: found.source.name, ...done });
  else
    output.out(
      done.routesAdded || done.requestsAdded
        ? `Added ${done.routesAdded} route${done.routesAdded === 1 ? '' : 's'} to “${printable(found.name)}” and ${done.requestsAdded} request${done.requestsAdded === 1 ? '' : 's'} to “${printable(found.source.name)}”.`
        : `“${printable(found.name)}” and “${printable(found.source.name)}” are in step.`,
    );
  return 0;
}

/** `mock create`: a mock server from a specification's operations or a collection's requests. */
async function createMock(parsed: Parsed, target: Target, output: Output): Promise<number> {
  const { state } = target;
  const [name] = positionals(parsed, ['name']);
  nameProblem(name.trim(), 'mock server');
  const mocks = (state.mocks ??= []);
  if (mocks.some((mock) => mock.name.toLowerCase() === name.trim().toLowerCase()))
    throw new UsageError(`There is already a mock server “${name.trim()}”.`);
  const specName = one(parsed, '--spec');
  const collection = one(parsed, '--collection');
  if (Boolean(specName) === Boolean(collection))
    throw new UsageError('Give --spec <spec|file> or -c <collection>.');
  let mock: MockServer;
  if (specName) {
    const spec = await specOrFile(state, specName);
    const analysis = analyzeSpec(spec.content);
    if (!analysis.document)
      throw new UsageError(
        `The specification cannot be read: ${analysis.problems[0]?.message ?? 'unrecognised'}`,
      );
    const routes = mockRoutesFromSpec(analysis.document);
    if (!routes.length) throw new UsageError(`${spec.name} has no operations to mock.`);
    mock = { ...newMock(name.trim(), mocks, routes), source: { kind: 'spec', name: spec.name } };
  } else {
    const folder = findFolder(state, collection!);
    const routes = mockRoutesFromRequests(
      state.requests.filter((request) => isWithin(request.folder, folder)),
    );
    if (!routes.length) throw new UsageError(`${folder} has no requests to mock.`);
    mock = {
      ...newMock(name.trim(), mocks, routes),
      source: { kind: 'collection', name: folder },
    };
  }
  const port = one(parsed, '--port');
  if (port !== undefined) {
    const problem = mockPortProblem(Number(port));
    if (problem) throw new UsageError(problem);
    mock.port = Number(port);
  }
  mocks.push(mock);
  await target.save();
  if (parsed.flags.has('--json'))
    json(output, { id: mock.id, name: mock.name, port: mock.port, routes: mock.routes.length });
  else
    output.out(
      `Created “${printable(mock.name)}” on port ${mock.port} with ${mock.routes.length} ${mock.routes.length === 1 ? 'route' : 'routes'}.`,
    );
  return 0;
}

/** Runs `api-workbench <resource> <command> …`; the exit code follows run's (2 for mistakes). */
export async function resourceCommand(
  resource: Resource,
  argv: readonly string[],
  context: CommandContext,
): Promise<number> {
  const [sub = 'list', ...rest] = argv;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    context.output.out(RESOURCE_HELP[resource]);
    return 0;
  }
  if (!SUBCOMMANDS[resource].includes(sub))
    throw new UsageError(
      `Unknown command “${resource} ${sub}”.${suggest(sub, SUBCOMMANDS[resource])} Commands: ${SUBCOMMANDS[resource].join(', ')}.`,
    );
  const parsed = parse(rest, [...COMMON_FLAGS, ...(COMMAND_FLAGS[`${resource} ${sub}`] ?? [])]);
  if (parsed.flags.has('--help')) {
    context.output.out(RESOURCE_HELP[resource]);
    return 0;
  }
  if (resource === 'workspace') return workspaceCommand(sub, parsed, context);
  const file = one(parsed, '--file');
  if (file !== undefined) {
    const workspace = one(parsed, '--workspace');
    const dir = one(parsed, '--dir');
    if (workspace !== undefined && dir !== undefined)
      throw new UsageError('Use --workspace or --dir, not both.');
    if ((workspace !== undefined || dir !== undefined) && sub !== 'send')
      throw new UsageError(
        'Use --file, --workspace, or --dir, not more than one: only send takes a workspace with --file, for its environment.',
      );
    // A copy of a file, such as an editor's unsaved text, names its files relative to the original.
    const fileTarget = await openFileTarget(file, one(parsed, '--base-dir'));
    // A workspace's environment fills the file's {{variables}}, under its own @variables.
    if (workspace !== undefined || dir !== undefined) {
      const from = await openTarget(
        { dataDir: one(parsed, '--data-dir'), workspace, dir },
        context.env,
      );
      try {
        withWorkspaceEnvironment(fileTarget, from, one(parsed, '--environment'));
      } finally {
        await from.close();
      }
    }
    if (sub === 'send') return sendRequest(parsed, fileTarget, context);
    return requestCommand(sub, parsed, fileTarget, context.output);
  }
  // A specification file is read as it is, so linting one needs no workspace.
  if (
    resource === 'spec' &&
    (sub === 'lint' || sub === 'show') &&
    !parsed.values.has('--workspace') &&
    !parsed.values.has('--dir') &&
    parsed.positionals.length === 1 &&
    /\.(ya?ml|json)$/i.test(parsed.positionals[0]) &&
    (await fs.stat(parsed.positionals[0]).then(
      (stat) => stat.isFile(),
      () => false,
    ))
  )
    return specCommand(
      sub,
      parsed,
      { kind: 'collection file', name: '', state: emptyState(), save: async () => {} },
      context.output,
    );
  const target = await openTarget(
    {
      dataDir: one(parsed, '--data-dir'),
      workspace: one(parsed, '--workspace'),
      dir: one(parsed, '--dir'),
    },
    context.env,
  );
  try {
    switch (resource) {
      case 'collection':
        if (sub === 'docs') return await collectionDocs(parsed, target, context.output);
        return await collectionCommand(sub, parsed, target, context.output);
      case 'request':
        if (sub === 'send') return await sendRequest(parsed, target, context);
        if (sub === 'connect') return await connectRequest(parsed, target, context);
        if (sub === 'token') return await requestToken(parsed, target, context);
        if (sub === 'schema') return await requestSchema(parsed, target, context);
        if (sub === 'create') return await createRequest(parsed, target, context);
        if (sub === 'update') return await updateRequest(parsed, target, context);
        return await requestCommand(sub, parsed, target, context.output);
      case 'environment':
        return await environmentCommand(sub, parsed, target, context);
      case 'secret':
        return await secretCommand(sub, parsed, target, context);
      case 'certificate':
        return await certificateCommand(sub, parsed, target, context);
      case 'spec':
        if (sub === 'create') return await specFromCollection(parsed, target, context.output);
        return await specCommand(sub, parsed, target, context.output);
      case 'mock':
        return await mockCommand(sub, parsed, target, context);
      case 'history':
        return await historyCommand(sub, parsed, target, context.output);
      case 'cookie':
        return await cookieCommand(sub, parsed, target, context.output);
      case 'team':
        return await teamCommand(sub, parsed, target, context);
    }
  } finally {
    await target.close();
  }
}
