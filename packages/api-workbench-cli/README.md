<!-- The logo is a path in the repository, for GitHub and editors' previews; scripts/npm-package.mjs
     turns it into an absolute URL in the package, whose page on GitHub Packages has no repository paths. -->
<p align="center">
  <img src="../api-workbench-app/src/assets/branding/app-icon.svg" alt="" width="88" height="88">
</p>

<h1 align="center">API Workbench command line</h1>

<p align="center">
  <strong>Run API tests and load tests in CI, send requests, and manage workspaces — from a terminal.</strong><br>
  The <code>api-workbench</code> command for the open-source, local-first API Workbench desktop app.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#use-it-in-ci">Use it in CI</a> ·
  <a href="https://github.com/techieutils/api-workbench/blob/main/docs/cli.md">Documentation</a> ·
  <a href="https://github.com/techieutils/api-workbench/releases">Releases</a> ·
  <a href="https://github.com/techieutils/api-workbench">API Workbench</a>
</p>

<p align="center">
  <a href="https://github.com/techieutils/api-workbench/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6d1cff"></a>
  <a href="https://github.com/techieutils/api-workbench/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/techieutils/api-workbench/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/techieutils/api-workbench/pkgs/npm/api-workbench-cli"><img alt="npm: GitHub Packages" src="https://img.shields.io/badge/npm-GitHub%20Packages-06d8c0"></a>
  <img alt="Node.js 22.19 or later" src="https://img.shields.io/badge/node-%E2%89%A522.19-47848f">
  <img alt="Dependencies: none" src="https://img.shields.io/badge/dependencies-none-0b7a3e">
</p>

`api-workbench` does from a terminal what the [API Workbench](https://github.com/techieutils/api-workbench) desktop app does in its window. Run a collection's requests and tests in CI and fail the build when one fails, load-test an API, send a single request, and manage workspaces, collections, environments, credentials, specifications, and mock servers.

It sends requests exactly as the app does, with the same variables, authentication, HTTP settings, captures, cookies, and tests. It also reads and writes the same files, so a request saved in the app is the one the command line runs.

```sh
api-workbench run ./api -e Staging --report-junit results.xml
```

- [Install](#install)
- [Quick start](#quick-start)
- [What it works on](#what-it-works-on)
- [Commands](#commands)
- [Run tests](#run-tests) · [Load tests](#load-tests) · [Send a request](#send-a-request)
- [Manage a workspace](#manage-a-workspace)
- [Use it in CI](#use-it-in-ci)
- [Secrets](#secrets) · [Environment variables](#environment-variables) · [Exit codes](#exit-codes) · [Troubleshooting](#troubleshooting)

## Install

It needs [Node.js](https://nodejs.org) **22.19 or later**. The package is one JavaScript file with no dependencies.

### From GitHub Packages (npm)

The package is published to GitHub's npm registry as `@techieutils/api-workbench-cli`. GitHub asks for a token to install from it, even for public packages:

1. Create a [personal access token (classic)](https://github.com/settings/tokens) with the `read:packages` scope.
2. Tell npm where `@techieutils` packages come from, and give it the token. Put this in `~/.npmrc`, or in a project's `.npmrc`, without committing the token:

   ```ini
   @techieutils:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   With `${GITHUB_TOKEN}`, npm reads the token from that environment variable, so it never sits in the file.

3. Install it:

   ```sh
   npm install --global @techieutils/api-workbench-cli
   api-workbench --version
   ```

   Or run it without installing:

   ```sh
   npx @techieutils/api-workbench-cli run ./api -e Staging
   ```

   Or add it to a project, so everyone runs the same version:

   ```sh
   npm install --save-dev @techieutils/api-workbench-cli
   npx api-workbench run ./api
   ```

Pre-releases are published under the `next` tag: `npm install --global @techieutils/api-workbench-cli@next`.

### As a single file, without npm

Every [release](https://github.com/techieutils/api-workbench/releases) also has the same command line attached as `api-workbench-cli.cjs`. No token is needed to download it:

```sh
curl -fsSL -o api-workbench.cjs \
  https://github.com/techieutils/api-workbench/releases/latest/download/api-workbench-cli.cjs
node api-workbench.cjs --version
```

Run it as `node api-workbench.cjs <command>` wherever this README says `api-workbench <command>`. The release's `SHA256SUMS` lists its checksum, and `gh attestation verify` checks where it was built.

The command line is released with the app, so their versions match.

## Quick start

```sh
api-workbench --help                       # every command
api-workbench environment --help           # one command, explained

api-workbench list ./api                   # what is in a team workspace folder
api-workbench run ./api -e Staging         # run its requests and tests, as CI would

api-workbench workspace list               # the app's own workspaces
api-workbench request send "Get order" -e Staging -i
```

A mistyped name says what you probably meant, such as _No environment “Stagin”. Did you mean “Staging”?_

## What it works on

| Where                                                                                                                       | How you choose it                                           | Used by                         |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| One of the app's workspaces                                                                                                 | `-w`, `--workspace <name or id>`; the active one by default | Every command                   |
| A team workspace folder, such as one in your repository                                                                     | `--dir <folder>`, or the folder itself for `run` and `list` | Every command                   |
| A collection file in any format the app imports: API Workbench, Postman, Insomnia, Bruno, Hoppscotch, OpenAPI, HAR, `.http` | The file itself                                             | `run` and `list`                |
| A specification file                                                                                                        | The file itself                                             | `spec show`, `lint`, `generate` |

The app keeps its workspaces in `~/Library/Application Support/API Workbench` on macOS, `%APPDATA%\API Workbench` on Windows, and `~/.config/API Workbench` on Linux. `--data-dir <folder>` or `API_WORKBENCH_DATA_DIR` points at another folder.

## Commands

```text
api-workbench run <source> [options]       Run requests and their tests (or a load test)
api-workbench list <source>                Show collections, requests, and environments

api-workbench workspace    list, show, create, rename, use, delete
api-workbench collection   list, create, rename, delete, import, export, docs
api-workbench request      list, show, send, connect, create, update, delete, code
api-workbench environment  list, show, create, rename, delete, set, unset
api-workbench secret       list, set, delete
api-workbench certificate  list, add, enable, disable, remove, trust, untrust
api-workbench spec         list, show, lint, import, export, generate, create
api-workbench mock         list, show, create, start
api-workbench history      list, clear
api-workbench cookie       list, delete, clear
api-workbench team         status, commit, pull, push, sync

api-workbench --version | --help
```

`<source>` is a team workspace folder, a workspace folder, or a collection file. Instead of a source, `-w <name>` runs one of the app's own workspaces.

## Run tests

```sh
api-workbench run ./api --collection Orders --environment Staging --report-junit results.xml
```

`run` sends the chosen requests in the order the explorer shows them, runs their tests and captures, and prints each result as it comes. A value captured by one request is available to the requests after it, and cookies are kept between requests, as in a collection run in the app.

| Option                         | What it does                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c`, `--collection <path>`    | Run a collection or folder, such as `Orders` or `Orders/Refunds` (repeatable; all by default)                                                                                                                         |
| `-r`, `--request <name or id>` | Run only these requests (repeatable)                                                                                                                                                                                  |
| `-t`, `--tag <tag>`            | Run only requests with this tag; repeatable, or `a,b`, for any of them                                                                                                                                                |
| `--all-tags`                   | With several `--tag`, run only requests with all of them                                                                                                                                                              |
| `--exclude-tag <tag>`          | Leave out requests with this tag; it wins over `--tag`                                                                                                                                                                |
| `-e`, `--environment <name>`   | The environment to use; the first one by default                                                                                                                                                                      |
| `-v`, `--var <name=value>`     | Set a variable for the run (repeatable)                                                                                                                                                                               |
| `-v`, `--var <name>`           | Set a variable from the environment variable of the same name, to keep secrets off the command line                                                                                                                   |
| `-d`, `--data <file>`          | Run once per row of a CSV, JSON, YAML, or XML file                                                                                                                                                                    |
| `--uploads <file>`             | The files requests send, as JSON: `{"<request>": "<path>"}` for a file body, `{"<request>": {"<field>": "<path>"}}` for a form's file fields; requests by name or id, paths relative to the JSON file                 |
| `--allow-host <host>`          | Send only to this host (repeatable; `*.example.com` for its subdomains), checked after variables and pre-request scripts; a request to any other fails, unsent                                                        |
| `--list-hosts`                 | Print, as JSON, the hosts the chosen requests would go to — for every data row, with the environment and `-v` values — and send nothing; requests whose host comes from an earlier capture are listed as `unresolved` |
| `-n`, `--iterations <count>`   | Run every request this many times                                                                                                                                                                                     |
| `--delay <ms>`                 | Wait between requests                                                                                                                                                                                                 |
| `--timeout <ms>`               | Request timeout, overriding the workspace's                                                                                                                                                                           |
| `--bail`                       | Stop at the first failure                                                                                                                                                                                             |
| `--allow-scripts`              | Run the requests' pre-request and post-response scripts                                                                                                                                                               |
| `--skip-scripts`               | Run the requests without their scripts                                                                                                                                                                                |
| `-k`, `--insecure`             | Do not verify TLS certificates                                                                                                                                                                                        |
| `--reporter <list>`            | `cli`, `json`, `junit`, comma-separated (default `cli`)                                                                                                                                                               |
| `--report-junit <file>`        | Write a JUnit XML report, which CI systems show as test results                                                                                                                                                       |
| `--report-json <file>`         | Write a JSON report                                                                                                                                                                                                   |
| `--quiet`                      | Print only failures and the summary                                                                                                                                                                                   |
| `--no-color`                   | Plain output; also when `NO_COLOR` is set or the output is not a terminal                                                                                                                                             |

A request **passes** when all its tests pass. A request without tests passes when its status is from 200 to 399. A request that gets no response fails. Live protocol requests (WebSocket, gRPC, and the others) are listed but not run.

If the chosen requests have scripts, the run stops with exit code 2 until you choose `--allow-scripts` or `--skip-scripts`, because scripts run code from the workspace.

`list` shows what is in a source. It takes the same tag options, to show what a run would send, and `--json` for scripts:

```sh
api-workbench list ./api --tag smoke
api-workbench list -w "Shop API" --json
```

## Load tests

Any load option makes `run` a performance run. The chosen requests are sent over and over for `--duration` seconds, either `--concurrency` at a time or at `--rps` a second. `--mode benchmark` instead sends every request `-n` times, as fast as it can.

```sh
api-workbench run ./api -c Orders -e Staging \
  --duration 30 --concurrency 10 --p95 500 --max-error-rate 1 --report-junit load.xml
```

| Option                 | What it does                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| `--mode <mode>`        | `collection` (the default), `benchmark`, or `performance`        |
| `--concurrency <n>`    | Requests in flight at once, from 1 to 50                         |
| `--duration <seconds>` | How long a performance run lasts (default 10)                    |
| `--rps <rate>`         | Start this many requests a second                                |
| `--ramp-up <seconds>`  | Reach full concurrency or rate over this time                    |
| `--warmup <n>`         | Unmeasured requests first                                        |
| `--max-requests <n>`   | Stop after this many (default 10,000)                            |
| `--p95 <ms>`           | Fail when the 95th percentile latency is above this              |
| `--max-error-rate <%>` | Fail when more than this percentage of requests fail (default 0) |
| `--min-rps <rate>`     | Fail when throughput is below this                               |

It prints throughput, latency percentiles, failures by kind, and each threshold with its result. It exits with `1` when a threshold is missed.

> **Warning:** a load test sends many requests quickly. Only test APIs you own or are allowed to test, and prefer a staging environment.

## Send a request

```sh
api-workbench request send "Get order" -e Staging -i
```

```text
200 OK  84 ms · 412 B · HTTP/1.1
GET https://staging.example.com/orders/42

content-type: application/json
set-cookie: <hidden>

{
  "id": 42,
  "total": 18.5
}

✓ status 200
captured order_id
```

| Option                                       | What it does                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-e`, `--environment`                        | The environment to use; the workspace's active one by default                                                                                     |
| `-v`, `--var <name=value>`                   | Set a variable for this send; `-v name` reads `$name`                                                                                             |
| `-i`, `--include`                            | Show the response headers                                                                                                                         |
| `--no-body`                                  | Leave the body out                                                                                                                                |
| `--body-only`                                | Print only the body, exactly as it came, for a pipe or a file                                                                                     |
| `--json`                                     | Print the status, headers, body, tests, and captures as JSON                                                                                      |
| `--no-save`                                  | Leave the workspace as it was                                                                                                                     |
| `-k`, `--insecure`                           | Do not verify TLS certificates                                                                                                                    |
| `--timeout <ms>`                             | Request timeout, overriding the workspace's                                                                                                       |
| `--binary-file <path>`                       | The file a file body sends (20 MB at most), read for this send only                                                                               |
| `--form-file <field>=<path>`                 | The file for a form's file field, by its name; give one for each                                                                                  |
| `--allow-host <host>`                        | Send only if it goes to one of these hosts (repeatable), after variables and scripts; otherwise exit 2, unsent                                    |
| `--file <file>`                              | Send a request of a collection file, such as a `.http` file                                                                                       |
| `--base-dir <folder>`                        | The folder a `.http` file's `< ./path` files are relative to, instead of the file's own — for a copy of it, such as an editor's unsaved text      |
| `-w`, `--workspace` or `--dir` with `--file` | Fill a collection file's `{{variables}}` from that workspace's environment (`-e`, or the one it uses), under the file's own `@name = value` lines |

A file body, or a form's file field, is sent from a file you give with each send — the request saves only the file's name, as the app does:

```sh
api-workbench request send "Upload avatar" --form-file avatar=photo.png
api-workbench request send "Import" --binary-file export.csv
```

```sh
api-workbench request send "List orders" --file orders.http
api-workbench request send "Get order" --body-only | jq .total
api-workbench request send "Download invoice" --body-only > invoice.pdf
```

In one of the app's workspaces, the send goes into History and captured values go into the environment, as in the app. `--no-save` leaves the workspace unchanged, and a team folder given with `--dir` is never changed by a send.

## Manage a workspace

These commands take `-w` or `--dir` to choose the workspace, `--json` to print JSON for scripts, and `--help`. Deleting anything needs `--yes`.

Give a request by its name, as `Folder/Name` when several share a name, or by its id (`request list --json` shows ids). Give a collection or folder by its path, such as `Orders/Refunds`.

### Workspaces

| Command                               | What it does                                                       |
| ------------------------------------- | ------------------------------------------------------------------ |
| `workspace list`                      | The app's workspaces; `*` marks the active one                     |
| `workspace show [<workspace>]`        | Its collections, requests, environments, specifications, and mocks |
| `workspace create <name>`             | A new workspace                                                    |
| `workspace rename <workspace> <name>` | Rename it                                                          |
| `workspace use <workspace>`           | Make it the active workspace                                       |
| `workspace delete <workspace> --yes`  | Delete it; a team workspace's shared folder is kept                |

### Collections

| Command                                                          | What it does                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `collection list`                                                | Collections, with their folders and requests                    |
| `collection create <name>`                                       | A collection, starting with one blank request                   |
| `collection rename <path> <new path>`                            | Rename or move a collection or folder                           |
| `collection delete <path> --yes`                                 | Delete it with its requests                                     |
| `collection import <file> [--into <name>]`                       | Import any format the app imports                               |
| `collection export <name> [--format <id>] [-o <file>]`           | Export as `workbench` (default), `postman`, `bruno`, and others |
| `collection docs <name> [--format openapi\|swagger] [-o <file>]` | API documentation as OpenAPI 3 or Swagger 2                     |

### Requests

| Command                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request list [-c <collection>]`                               | Requests in explorer order, with their URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `request show <request>`                                       | Method, URL, auth, headers, tests, and captures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `request send <request>`                                       | Send it; see [Send a request](#send-a-request)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `request connect <request>`                                    | Open a WebSocket, gRPC, SSE, NDJSON, Socket.IO, or MQTT request and keep it open: each event prints as it happens (received, sent, metadata, status, closed), and each line of standard input is sent as a message; with `--json`, events and input are JSON lines (`{"action":"send","message":"…","options":{…}}`, where options are a Socket.IO `event` and `ack`, or an MQTT `topic`, `qos`, and `retain`; `finish` to end a gRPC client stream, or `stop`). `-e`, `-v`, `--timeout`, and `--allow-host` as for send (a host not listed exits 2, unconnected). A saved credential is read from the vault with `API_WORKBENCH_VAULT_PASSWORD`; one encrypted by the system's credential store, or kept by an external provider, connects from the app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `request schema <request>`                                     | A GraphQL request's schema: an introspection query sent to its endpoint as the request is sent — its URL, headers, auth, and environment (`-e`, `-v`, `-k`, `--timeout` as for send) — never saved, with no script run. Prints how many types and root fields it has; `--json` prints its types, fields, arguments, and descriptions, as the VS Code extension's suggestions use them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `request token <request>`                                      | Get an OAuth 2.0 access token for a request with OAuth 2.0 auth, as **Get new access token** does in the app, and keep it with its refresh token and expiry in the request; the token is never printed. An authorization code grant prints the address to sign in at (with `--json`, a line `{"type":"authorize","url":"…"}`) and waits for the browser to come back; `--refresh` uses the saved refresh token. `-e` and `-v` resolve its `{{variables}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `request create <name> -c <collection> --url <url>`            | A new request (a mock server made from its collection gets a route for it): `-X` method, `-H "Name: value"`, `-d <body>` or `--body-file`, `--tag`; `--protocol` (http, websocket, sse, ndjson, grpc, socketio, or mqtt) makes a live request, with its protocol's settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `request create [<name>] --curl '<command>' [-c <collection>]` | A request from a cURL command; `--curl -` reads it from standard input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `request code <request> [--lang <id>] [--client <id>]`         | Code for the request, with secrets redacted; `--list` shows the languages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `request list\|show\|send\|code --file <file>`                 | The requests of a collection file, such as a `.http` file, read as it is and never changed; name one by name or position (`1`, `2`, …)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `request update <request>`                                     | Change it: `--name`, `-X`, `--url`, `-H "Name: value"` (adds, or replaces that header), `--unset-header`, `--disable-header <name>` and `--enable-header <name>` (keep a header but stop or start sending it), `-d`, `--body-file`, `--no-body`; `--tests <lines>`, `--tag` or `--no-tags`, and `--capture name=from` or `--no-captures` replace its tests, tags, and captures; `--auth <kind>` (none, inherit, bearer, basic, api-key, digest, jwt, aws, oauth1, ntlm, wsse, edgegrid, hawk, oauth2, or credential) with `--auth-username`, `--auth-secret-from-env <VAR>` (the token or password, never an argument), `--auth-fields-from-env <VAR>` (JSON with any of `username`, `password`, `token`, and `options` — the type's settings, such as `awsRegion`, `jwtAlgorithm`, or `oauth2TokenUrl`; `<hidden>` keeps a value, `null` removes an option), `--api-key-in`, and `--credential <id>` set its auth; `--body-type` (none, raw, form-data, x-www-form-urlencoded, or binary) and `--form-fields -` (JSON on standard input; fields with `"kind": "file"` and a `fileName` are file fields, and the list is then the whole form) set its body type and form fields, and `--binary-name` names a file body's file; `--pre-script-file <file>` and `--post-script-file <file>` set its scripts (an empty file removes one); `--settings-file <file>` sets a live request's settings from JSON: `grpc` (`proto`, `method`, `tls`), `socketio` (`path`, `event`, `ack`), or `mqtt` (`clientId`, `version`, `cleanStart`, `keepalive`, `subscriptions`, `topic`, `qos`, `retain`) |
| `request delete <request> --yes`                               | Delete it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

```sh
api-workbench request create "Create order" -c Orders -X POST \
  --url '{{base_url}}/orders' -H 'Content-Type: application/json' -d '{"sku":"A-1"}'
api-workbench request code "Create order" --lang python --client requests
```

### Environments

| Command                                                       | What it does                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment list`                                            | Environments and how many variables each has; `*` marks the active one                                                                                                                                                                                                                    |
| `environment show <environment>`                              | Its variables; secret-looking values show as `<hidden>`                                                                                                                                                                                                                                   |
| `environment create <name> [--copy <environment>]`            | A new environment, empty or a copy                                                                                                                                                                                                                                                        |
| `environment rename <environment> <name>`                     | Rename it                                                                                                                                                                                                                                                                                 |
| `environment delete <environment> --yes`                      | Delete it                                                                                                                                                                                                                                                                                 |
| `environment set <environment> <name=value>…`                 | Set variables; `name` alone reads the value from `$name`                                                                                                                                                                                                                                  |
| `environment unset <environment> <name>…`                     | Remove variables                                                                                                                                                                                                                                                                          |
| `environment update <environment> --variables-from-env <VAR>` | Replace its variables with the JSON list in the environment variable — `[{"key", "value", "enabled"}]`, in order, each on or off — so values stay off the command line; a value still `<hidden>` keeps the one it had. In a team folder, secret-looking values are refused, as with `set` |

```sh
api-workbench environment create Staging --copy Local
api-workbench environment set Staging base_url=https://staging.example.com
```

### Saved credentials

| Command                                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret list`                                                                                            | Saved credentials: name, type, and the origin each may be sent to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `secret set <name> --type <kind> --origin <url> [--stdin or --from-env <VAR>] [--fields-from-env <VAR>]` | Add a credential of any kind but client certificates — bearer, basic, api-key, digest, jwt, aws, oauth1, ntlm, wsse, edgegrid, hawk, or oauth2 — or change one by its name. `--username` for Basic, `--header` for an API key (`X-API-Key` by default). The secret is read from standard input or an environment variable, never an argument; `--fields-from-env <VAR>` holds JSON with `secret`, `extraSecret` (an AWS session token, OAuth 1.0 token secret, or EdgeGrid access token), `username`, `headerName`, `options` (the type's settings, such as `awsRegion` or `jwtAlgorithm`), and `oauth` (an OAuth 2.0 client: `grantType`, `tokenUrl`, `clientId`, `clientSecret`, `scope`, …). Changing one keeps its secrets and settings not given |
| `secret delete <name> --yes`                                                                             | Delete it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

```sh
printf %s "$API_TOKEN" | api-workbench secret set "Shop API" \
  --type bearer --origin https://api.example.com --stdin
```

The secret is read from standard input or an environment variable, never from an argument. The command line opens the app's API Workbench vault with its password, from `API_WORKBENCH_VAULT_PASSWORD` or typed at a terminal. A vault the app keeps in the system's credential store (the macOS Keychain, Windows DPAPI, or a Linux keyring) opens only in the app.

### Client certificates

| Command                                                                                      | What it does                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `certificate list`                                                                           | Client certificates — host, PEM or PFX, on or off, and until when each is valid — and the CA certificates the workspace trusts                                                                                                    |
| `certificate add --host <host> [--port <port>] (--cert <file> --key <file> or --pfx <file>)` | Keep a client certificate in the vault, presented for mutual TLS to the host (or `*.example.com`) and port; `--passphrase-from-env <VAR>` reads its passphrase from an environment variable, never an argument; `--name` names it |
| `certificate enable <host>` / `certificate disable <host>`                                   | Present it again, or keep it but stop presenting it                                                                                                                                                                               |
| `certificate remove <host> --yes`                                                            | Remove it and its key from the vault; the files it was read from stay                                                                                                                                                             |
| `certificate trust <file>`                                                                   | Trust the CA certificates in a PEM file, as well as the system's                                                                                                                                                                  |
| `certificate untrust --yes`                                                                  | Trust only the system's CA certificates again                                                                                                                                                                                     |

```sh
CERT_PASSPHRASE=… api-workbench certificate add --host api.example.com \
  --cert client.pem --key client-key.pem --passphrase-from-env CERT_PASSPHRASE
```

`run` and `request send` present the most specific matching certificate — an exact host before a wildcard, a port before any port — as the app does, from the vault opened with `API_WORKBENCH_VAULT_PASSWORD`. Keys and passphrases are never printed. `request send --json` includes each hop's `timings` (DNS, connecting, TLS, waiting, and downloading) and the server's `tls` connection and certificates.

### Specifications

| Command                                              | What it does                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `spec list`                                          | The workspace's specifications, with their version and errors                                                           |
| `spec show <spec or file>`                           | Title, version, and every operation                                                                                     |
| `spec lint <spec or file>`                           | Errors and warnings with their lines; exits with `1` on an error. A `.yaml`, `.yml`, or `.json` file needs no workspace |
| `spec import <file> [--name <name>]`                 | Add an OpenAPI 3 or Swagger 2 document                                                                                  |
| `spec export <spec> [-o <file>]`                     | Its text, exactly as saved                                                                                              |
| `spec generate <spec or file> [--collection <name>]` | A collection with a request for every operation; `--replace` regenerates one                                            |
| `spec create -c <collection> [--name <name>]`        | A specification describing a collection's requests                                                                      |

### Mock servers, history, and cookies

| Command                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock list`                                 | The workspace's mock servers, with their ports and routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mock show <mock>`                          | Its port, CORS and HTTPS settings, and routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mock create <name> --spec <spec\|file>`    | A mock answering for each operation of a specification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mock create <name> -c <collection>`        | A mock answering with a collection's saved responses; `--port`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mock update <mock> --settings-file <file>` | Change its settings from a JSON file shaped as `mock show --json` prints them under `settings`: `name`, `port`, `cors` and `corsOptions` (`origins`, `methods`, `headers`, `exposeHeaders`, `credentials`, `maxAge`), `defaultHeaders` (`<hidden>` keeps a value), `https` (`enabled`, `certFile`, `keyFile`), `grpcPort`, `mqttPort`, and `routes` (`id` with `enabled`, `status`, `delayMs`, `method`, `path`, `name`, `headers`, `body`; a header still `<hidden>` keeps its value). Only what it names changes. `addRoutes` (`method`, `path`, `status`, `name`, `headers`, `body`) adds HTTP routes and `removeRoutes` (route ids) removes them; for a mock made from a collection, added routes become requests there and a changed method, path, or name changes its request, while a removed route's request stays |
| `mock sync <mock>`                          | Put a mock made from a collection in step with it, both ways: a route for each request there that no route answers, and a request there for each route without one; routes and requests answering the same are linked. As things change, the two keep in step on their own — a request added or changed by any command (`request create`, `request update`, an import) changes the mock's routes, and a renamed collection stays the mock's; `mock show --json` gives `collectionSync`, how far apart they are                                                                                                                                                                                                                                                                                                             |
| `mock start <mock> [--port <port>]`         | Serve it until <kbd>Ctrl</kbd>+<kbd>C</kbd>, logging each request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `history list [--limit <n>]`                | Recent sends, newest first (20 by default)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `history clear --yes`                       | Clear your history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cookie list [--domain <domain>]`           | The cookie jar: names, domains, paths, and expiry; values never shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cookie delete <name> [--domain <domain>]`  | Delete a cookie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cookie clear --yes`                        | Empty the jar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Team folders and Git

| Command                             | What it does                                                    |
| ----------------------------------- | --------------------------------------------------------------- |
| `team status`                       | The branch, commits to push and pull, and changed files         |
| `team commit -m <message>`          | Commit the team folder's changes                                |
| `team pull [--keep mine\|theirs]`   | Pull; `--keep` chooses for files changed on both sides          |
| `team push`                         | Push your commits                                               |
| `team sync -m <message> [--keep …]` | Commit, pull, and push in one step, as **Sync** does in the app |

## Use it in CI

Keep a team workspace folder in your repository, so CI runs the same requests your team edits in the app. Then install the command line, run it, and publish its JUnit report. In GitHub Actions:

```yaml
jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://npm.pkg.github.com
          scope: '@techieutils'
      - run: npm install --global @techieutils/api-workbench-cli@1.0.0
        env:
          # A token with read:packages, saved as a repository secret.
          NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_TOKEN }}
      - run: api-workbench run ./api -e Staging -v api_token --report-junit results.xml
        env:
          api_token: ${{ secrets.STAGING_TOKEN }}
```

Pin a version, as above, so a new release never changes your build without a commit. Where giving CI a token is awkward, download the single file from the release instead (see [As a single file](#as-a-single-file-without-npm)). It works in any CI system that runs Node.js.

## Secrets

The command line follows the app's rules, because terminal output and CI logs are often widely read:

- Credential values are never printed, and never taken as an argument.
- Values whose names look secret (tokens, passwords, keys, sessions, `Authorization` and `Cookie` headers) show as `<hidden>`.
- Reports show names, URLs, statuses, timings, and test results, never headers, bodies, or variable values.
- Team folders never hold secret values. In CI, give a secret as a variable from your CI system's secret store: `-v api_token` reads it from the `api_token` environment variable.
- **Saved credential** auth works in one of the app's workspaces (`-w`) when the API Workbench vault's password is in `API_WORKBENCH_VAULT_PASSWORD` (or typed at a terminal), and only for the origin each credential is for. A team folder (`--dir`) uses them when the app on this computer has that folder open, keeping which credential each request uses with the app's own settings for it, never in the folder; other team folders keep none. A vault encrypted by the system's credential store opens only in the app: there, put the secret in a variable instead, such as `Bearer {{api_token}}`.

## Environment variables

| Variable                       | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `API_WORKBENCH_DATA_DIR`       | The app's data folder, instead of the usual one                |
| `API_WORKBENCH_VAULT_PASSWORD` | The vault's password, for `secret` commands without a terminal |
| `NO_COLOR`                     | Plain output without colours                                   |

## Exit codes

| Code  | Meaning                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------- |
| `0`   | Every request passed, or the command did what it was asked                                          |
| `1`   | A request or test failed, a load test missed a threshold, `spec lint` found an error, or Git failed |
| `2`   | The command could not start: a mistyped option or name, a missing file, or `--yes` not given        |
| `130` | Interrupted with <kbd>Ctrl</kbd>+<kbd>C</kbd>; reports still cover what finished                    |

## Troubleshooting

| Message                                                                 | What to do                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypeError: Cannot read properties of undefined (reading 'bind')`       | Node.js is older than 22.19; `node --version` shows yours                                                                                                                                         |
| `npm error 401 Unauthorized` or `404 Not Found` from npm.pkg.github.com | npm has no token, or one without `read:packages`; see [Install](#from-github-packages-npm)                                                                                                        |
| _No API Workbench data in …_                                            | Open the app once so it creates its data folder, give `--data-dir`, or use `--dir`                                                                                                                |
| _… a saved credential, which lives in the app's vault_                  | Run it from one of the app's workspaces (`-w`), or a team folder the app on this computer has open, with `API_WORKBENCH_VAULT_PASSWORD`, or put the secret in a variable and give it with `--var` |
| _2 requests are named “…”_                                              | Give the folder too, as `Folder/Name`, or the request's id from `request list --json`                                                                                                             |
| A run passes in the app but fails in CI                                 | `run` uses the first environment unless `-e` names another; `list` shows their names                                                                                                              |

## More

- [Command line documentation](https://github.com/techieutils/api-workbench/blob/main/docs/cli.md), with every detail
- [Run API tests in CI](https://github.com/techieutils/api-workbench/blob/main/docs/guides/run-api-tests-in-ci.md), with setups for GitHub Actions, GitLab CI, Jenkins, and Azure DevOps
- [Issues](https://github.com/techieutils/api-workbench/issues)

MIT licensed.
