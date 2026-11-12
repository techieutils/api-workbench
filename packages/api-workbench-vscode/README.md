<p align="center">
  <img src="media/icon.png" alt="" width="88" height="88">
</p>

<h1 align="center">API Workbench</h1>

<p align="center">
  <strong>Send API Workbench requests, run their tests, send .http files, check OpenAPI specs, and serve mocks without leaving the editor.</strong><br>
  A companion to the open-source, local-first API Workbench desktop app.
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#features">Features</a> ·
  <a href="#settings">Settings</a> ·
  <a href="https://github.com/techieutils/api-workbench/blob/main/docs/vscode.md">Documentation</a> ·
  <a href="https://github.com/techieutils/api-workbench">API Workbench</a>
</p>

The **API Workbench** sidebar lists the collections, environments, specifications, mock servers, history, and saved credentials of the [team workspace folders](https://github.com/techieutils/api-workbench/blob/main/docs/team-workspaces.md) in your project, and of the app's own workspaces. Open a request in the request editor and send it, run a collection's tests and see the results in VS Code's **Testing** view, send the requests of `.http` files, check OpenAPI files as you save them, and serve mock servers. Requests go out exactly as the app sends them, with the same environments, authentication, captures, and tests, because the extension runs the `api-workbench` [command line](https://github.com/techieutils/api-workbench/blob/main/docs/cli.md) that ships inside it.

Edit requests in the app, or in their YAML files in a team folder; the view follows changes to the files as they are saved.

## Getting started

1. Download `api-workbench-vscode-<version>.vsix` from a [release](https://github.com/techieutils/api-workbench/releases), and in VS Code choose **Extensions → ⋯ → Install from VSIX…**. It needs VS Code 1.145 or later and nothing else: the command line is inside it and runs in VS Code's own Node.js.
2. Open a folder that contains an API Workbench team workspace folder (one with a `workspace.json` and `collections/`), or open the API Workbench app once on this computer so its workspaces exist.
3. Choose **API Workbench** in the activity bar. Click an environment in **Environments** to use it, or click the environment in the status bar.
4. Click a request to open it, then **Send**; or **Run Tests** (▶) on a request, folder, or workspace. In a `.http` file, press <kbd>⌘</kbd>+<kbd>Enter</kbd> or click **Send request** above a request.

The extension runs only in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust): it sends requests and runs tests from files anyone could have written.

## Features

| Feature                | How                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browse a workspace** | **Collections** (with method badges), **Environments** and their variables, **API Specs**, **Mock Servers**, **History**, **Credentials**, and **Cookies**                                                                                                             |
| **Organize**           | New, rename, delete, and export collections; requests from scratch or cURL; workspaces, environments and variables, and credentials                                                                                                                                    |
| **Team folders**       | Branch, ↑↓, and changes beside the folder; **Team: Commit**, **Pull**, **Push**, and **Sync** with Keep mine / Keep theirs                                                                                                                                             |
| **Auth and forms**     | Every auth type the app has — bearer, basic, API key, digest, JWT, AWS Signature, OAuth 1.0 and 2.0 (with **Get new access token**), NTLM, WSSE, Akamai EdgeGrid, Hawk, or a saved credential — secrets never shown; raw, form-data, or URL-encoded bodies             |
| **Scripts**            | Pre-request and post-response scripts in VS Code's editor, with `aw` suggestions and syntax errors underlined                                                                                                                                                          |
| **Live connections**   | WebSocket, gRPC (unary and streaming), SSE, NDJSON, Socket.IO events, and MQTT topics: edit, connect, send, and see every message                                                                                                                                      |
| **Request editor**     | Click a request: edit its method, URL, params, headers, and body — raw, GraphQL, forms, or a file, with **Choose file…** for uploads — **Save** with <kbd>⌘</kbd>+<kbd>S</kbd>, **Send** with <kbd>⌘</kbd>+<kbd>Enter</kbd>                                            |
| **Responses**          | Status, timing, size, tests passed; **Body** (pretty or raw), **Headers**, **Cookies**, **Tests**, **Timing** (DNS, connecting, TLS, waiting, download), **Certificate** (TLS and the server's chain), and **Timeline**; captured values                               |
| **Runner**             | **Run Collection in Runner…**: iterations, delay, data files, stop at the first failure, and benchmark and performance load tests                                                                                                                                      |
| **Run tests**          | **Run Tests** on a request, folder, or workspace, or from the **Testing** view, with failed tests' messages and the run's report                                                                                                                                       |
| **.http files**        | **Send request**, **Generate code**, **Open in Workbench**, and **Save to collection** above each request; captured values carry to later ones; `< ./file` uploads and multipart forms; `{{variables}}` from a workspace's environment (**Choose .http Environment…**) |
| **API specifications** | Checked on save, with problems in the **Problems** panel; **Generate collection**, **Start mock**, **Preview docs**, and **Add to workspace**                                                                                                                          |
| **Mock servers**       | Start and stop them, with each one's address, settings, routes, and request log; the status bar shows the port                                                                                                                                                         |
| **Panel**              | **Network** (every send, with a waterfall), **Console**, and **Performance** (each request's average and percentile times)                                                                                                                                             |
| **Environments**       | One per workspace; click to use it, or the status bar                                                                                                                                                                                                                  |
| **Generate code**      | Any language and library the app has, with secrets redacted; **Copy as cURL** too                                                                                                                                                                                      |
| **Import**             | **Import Collection…**: Postman, Insomnia, Bruno, OpenAPI, HAR, `.http`, cURL, and the app's own format                                                                                                                                                                |
| **Tags**               | **Run Only Tagged Requests…** limits runs to requests with any of the chosen tags                                                                                                                                                                                      |
| **Copilot tools**      | `#apiRequests`, `#sendApiRequest`, `#runApiTests`, and `#checkOpenApi` in agent mode; you confirm every send and run                                                                                                                                                   |
| **Credentials**        | Names, types, and origins of saved credentials — never their values; add and change them on a page; **Unlock Credential Vault…** when the vault has a password                                                                                                         |
| **Certificates**       | **Open Certificates**: client certificates for mutual TLS, added from PEM or PFX files, switched on and off, and removed; trusted CA certificates                                                                                                                      |

WebSocket, gRPC, SSE, NDJSON, Socket.IO, and MQTT requests open in a live connection editor.

### Scripts

Requests with pre-request or post-response scripts run code from the workspace, so the extension asks the first time it sends or runs them in a window. Set `apiWorkbench.scripts` in your user settings to always run them, or never. Scripts run in the command line's sandbox, with no access to files, the network, or the vault.

A `.http` file or team folder from a repository asks before its first send to each new host (after its `{{variables}}` are filled in), and sends only files from inside its own repository. Requests to this computer never ask.

### Secrets

Saved credentials stay in the app's API Workbench vault. The **Credentials** view lists their names and origins; unlock the vault with its password, kept until the window closes or, if you choose, in the system keychain, and given only to the command line. Requests that use **Saved credential** auth are then sent with it, only to the origin it is for. Nothing the extension shows contains a secret: header values the command line hides stay `<hidden>`, and generated code and cURL commands are redacted. Webviews show responses as text only, and run no script but the extension's own.

## Settings

| Setting                                 | Default   | What it does                                                                                                     |
| --------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `apiWorkbench.showAppWorkspaces`        | `true`    | Also list the app's own workspaces                                                                               |
| `apiWorkbench.saveSends`                | `true`    | Keep sends from VS Code in an app workspace's History, and save captured values, as the app does                 |
| `apiWorkbench.scripts`                  | `ask`     | `ask`, `allow`, or `skip` requests' scripts (user settings only)                                                 |
| `apiWorkbench.confirmNewHosts`          | `true`    | Ask before a `.http` file or team folder sends to a host not yet approved for the workspace (user settings only) |
| `apiWorkbench.toolsUseSavedCredentials` | on        | Let Copilot's tools send requests with their saved credentials while the vault is unlocked (user settings only)  |
| `apiWorkbench.engine`                   | `builtIn` | Runs commands inside VS Code, at once; `commandLine` starts a process for each (user settings only)              |
| `apiWorkbench.nodePath`                 | empty     | The Node.js to run the command line with (user settings only)                                                    |
| `apiWorkbench.cliPath`                  | empty     | Another copy of the command line to use (user settings only)                                                     |
| `apiWorkbench.dataDir`                  | empty     | The app's data folder, when it is not the usual one                                                              |

Settings that choose a program to run, or whether scripts run, can only be set in your user settings, so a project you open cannot change them.

## Troubleshooting

| Message                                      | What to do                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| _API Workbench needs Node.js 22.19 or later_ | Shown only for `apiWorkbench.engine: commandLine` or an old VS Code: install Node.js 22.19+, or set `apiWorkbench.nodePath` to one |
| The view is empty                            | Open a folder with a team workspace folder, or the app once; then **Refresh**. **Show Output** says what was found                 |
| _No environment “…”_                         | The environment was renamed or deleted: **Switch Environment…** again                                                              |
| A request passes in the app but fails here   | Check the environment in the status bar: the extension keeps its own choice for each workspace                                     |

## More

- [VS Code guide](https://github.com/techieutils/api-workbench/blob/main/docs/vscode.md) · [Command line](https://github.com/techieutils/api-workbench/blob/main/docs/cli.md) · [API Workbench](https://github.com/techieutils/api-workbench) · [Issues](https://github.com/techieutils/api-workbench/issues)

MIT licensed.
