---
description: The API Workbench extension for VS Code — browse and send a workspace's requests, run their tests, send .http files, check OpenAPI specs, and serve mock servers from the editor.
icon: microsoft-visual-studio-code
---

# VS Code extension

The **API Workbench** extension for [VS Code](https://code.visualstudio.com) brings your requests next to your code. It lists the collections, environments, specifications, mock servers, history, and saved credentials of the [team workspace folders](team-workspaces.md) in the folder you have open, and of the app's own [workspaces](workspaces.md). Open a request in the request editor and send it, run a collection's [tests](tests.md) and see each result in VS Code's **Testing** view, send the requests of `.http` files, check OpenAPI files as you save them, and serve [mock servers](mock-servers.md) — all from the editor.

Requests are sent exactly as the app sends them — the same [environments](environments.md), [variables](variables.md), [authentication](authentication.md), [captures](variables.md#capture-values-from-responses), and tests — because the extension runs the [command line](cli.md), which ships inside it. You keep editing requests in the app, or in a team folder's YAML files; the view follows the files as they change.

## Install

The extension is attached to every [release](https://github.com/techieutils/api-workbench/releases) as `api-workbench-vscode-<version>.vsix`.

1. Download the `.vsix` for the release you want.
2. In VS Code, open the **Extensions** view, choose **⋯ → Install from VSIX…**, and pick the file. From a terminal: `code --install-extension api-workbench-vscode-1.0.0.vsix`.
3. Choose **API Workbench** in the activity bar.

It needs VS Code 1.145 or later and nothing else: its command line is inside it, and runs in VS Code's own Node.js. Only with `apiWorkbench.engine` set to `commandLine`, or a VS Code whose Node.js is older than 22.19, does it need [Node.js](https://nodejs.org) 22.19 or later — `node` on your `PATH`, or `apiWorkbench.nodePath`. Install new releases the same way; the extension's version is always the app's.

> [!NOTE]
> The extension runs only in a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust). It sends requests and runs tests that come from the workspace's files, which anyone could have written.

## What it shows

The **API Workbench** sidebar has a view for each part of a workspace:

| View             | What it lists                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Collections**  | Each source, then its collections, folders, and requests in the app's order; a coloured badge shows each request's method or protocol |
| **Environments** | Each source's environments; a tick marks the one in use. Expand one to see its variables, secret-looking values hidden                |
| **API Specs**    | The [specifications](api-specs.md) of each source, with their version and errors                                                      |
| **Mock Servers** | The [mock servers](mock-servers.md) of each source, running or stopped, with their port                                               |
| **History**      | What was sent from the app's workspaces, newest first; click a send to open its request                                               |
| **Credentials**  | The names, types, and origins of an app workspace's [saved credentials](credentials.md) — never their values                          |
| **Cookies**      | The names, domains, and expiry of an app workspace's [cookies](cookies.md) — never their values                                       |

The sources are:

| Source                      | Where it comes from                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A team folder               | Any folder in the open workspace with an API Workbench `workspace.json` and `collections/`, such as one kept in your repository                                           |
| One of the app's workspaces | The workspaces of the app on this computer, unless `apiWorkbench.showAppWorkspaces` is off. A team workspace open in the app and in VS Code is listed once, as its folder |

Live requests (WebSocket, gRPC, SSE, NDJSON, Socket.IO, and MQTT) are listed with their protocol's badge. They open in a [live connection editor](#live-connections).

Each source has its own environment, which starts as the one the source uses in the app. Choose **Use Environment** (✓) beside one in **Environments**, **Switch Environment…** at the top of **Collections**, or the environment in the status bar to change it; <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>E</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>) does too while API Workbench has focus.

### Environments

Click an environment in **Environments**, or its table button, to open the **Environments** page, laid out as the app's: the workspace's environments on the left, each with how many variables it has and which one is in use, and the one chosen on the right as a table of its variables — each switched on or off, with its value — to change, add to (**+ Add variable**), remove, or edit in bulk, then **Save** (<kbd>⌘</kbd>+<kbd>S</kbd>) or **Discard**. **Use for requests** makes it the one requests, tests, and runs use; **Rename…** and **Delete** change it; **+ New environment** starts one, empty or as a copy. As in the app, a variable whose name looks secret — with `token`, `secret`, `password`, `api_key`, `credential`, or `private` in it — is typed in a password field, masked as soon as its name says so; **Show** reveals it until you **Hide** it or close the page. One the command line hides shows as **Hidden · type to replace** and is kept unless you type a new one; in a team folder, a secret value is refused, as the folder is shared. In the tree, **Add Variable…** (+) sits on each environment, and **Edit Variable…** and **Remove Variable** on each variable.

### Organize a workspace

As in the app's explorer, a workspace can be changed from the sidebar:

| Where                       | What you can do                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collections**             | **New Request…** (+) and **New Collection…**; on a collection or folder, **Rename…**, **Delete**, and **Export…** in any format the app exports; **Delete Request** on a request                                                                   |
| **Environments**            | **New Environment…**, copying the variables of one or starting empty; **Set Variable…** and **Remove Variable**; **Rename** and **Delete**                                                                                                         |
| **Collections** (more)      | **New Request from cURL…** (a command copied from a browser, read from the clipboard when it holds one); on a collection or folder, **Generate API Docs** (OpenAPI 3), **Create Spec from Collection…**, and **Start Mock Server from Collection** |
| **Workspaces**              | **New Workspace…** at the top of **Collections**; **Rename Workspace…** and **Delete Workspace** on one of the app's workspaces (a team workspace's folder is kept)                                                                                |
| **Credentials**             | **Add Credential…**: a bearer token, a username and password, or an API key header, and the one origin it may be sent to; **Delete Credential**. The secret goes to the vault only                                                                 |
| **History**                 | **Send Again** beside a send of a saved request                                                                                                                                                                                                    |
| **Cookies** and **History** | **Clear Cookies**, **Delete Cookie**, and **Clear History** (your own; teammates' stays theirs)                                                                                                                                                    |

Deleting asks first. A value set for a variable whose name looks secret is typed unseen, and goes to the command line through its environment, never as an argument.

### Make a new request

**New Request…** (the **+** in **Collections**, or on a collection or folder) opens a page to make one. First choose its kind — **HTTP**, **GraphQL**, **WebSocket**, **Server-sent events**, **NDJSON stream**, **gRPC**, **Socket.IO**, or **MQTT**; each card says what it is, and the line below says what to use it for and what VS Code does with it. Then choose the workspace and the collection or folder (or name a new collection), its method for HTTP, and its URL. A URL that does not suit the kind — `https://` for a WebSocket, or a gRPC address without its port — gets a hint; one starting with a `{{variable}}` is not checked. The name follows the URL's path until you type one, and tags are optional. **Create request** (<kbd>⌘</kbd>+<kbd>Enter</kbd>) makes it and opens it in its editor: the request editor for HTTP, the live connection editor for the others, where a gRPC call's `.proto` schema is added. **From a cURL command…** starts from a command instead.

## Send a request

Click a request to open it in the **request editor**: its collection and folders, method and URL, and tabs for its **Params**, **Headers**, **Body**, **Auth**, **Tests**, **Vars** (captures), and **Tags**. Change the method, the URL, the params (kept in step with the URL), the headers, a text body, the **Tests** (one assertion per line, such as `status 200`), the **Vars** it captures (a variable and where its value comes from, such as `body.id`), and its **Tags**, then **Save** (<kbd>⌘</kbd>+<kbd>S</kbd>); **Unsaved** shows until you do, and **Send** (<kbd>⌘</kbd>+<kbd>Enter</kbd>) saves your changes before it sends. A header whose value is hidden, as its name looks secret, keeps its value unless you type a new one. Tags a request has through its collection or folders are listed under **Tags**.

The page shows where the request is (its collection and folders), its name with its method, **Unsaved changes** while there are any, the environment its `{{variables}}` come from (click it to choose another), and **Save**. **Code**, **Copy as cURL**, and **Open file** sit at the top right. The method, URL, and **Send** form one address bar, where `{{variables}}`, query names, and values are coloured; the line under it says which environment and auth the send uses, and the keys. The request sits above its response, as in the app; drag the divider between them to give either more room, or focus it and use the arrow keys; double-click it, or press <kbd>Enter</kbd> on it, to put them side by side instead. The layout is kept for the request's tab.

**Params**, **Headers**, and form fields are tables with a heading row. A header or form field has a check box: clear it to keep it in the request without sending it (the bar above says how many are sent). A value the command line hid shows as **Hidden · type to replace**, and stays as it was unless you type a new one. **Bulk edit** shows a table as lines of `Name: value` (`name=value` for params), with `#` before one that is kept but not sent; **Table** goes back.

WebSocket, SSE, NDJSON, gRPC, Socket.IO, and MQTT requests open in the same kind of page: a protocol badge with the name and whether it is **Connected**, **Connecting…**, or **Not connected**; an address bar with **Connect** or **Disconnect**; the same status line, divider, and header tables; and a **Messages** log that counts what was received and sent, shows each event's size, and can show only received, sent, or connection events, or those containing what you search for.

The **Body** tab chooses **None**, **Raw**, **GraphQL**, **Form data**, a **URL-encoded form**, or **File (binary)**. A form's fields are edited as rows; in **Form data** each is **Text** or **File**, and a file field's **Choose file…** picks its file in VS Code's own dialog. **File (binary)** sends one file as the whole body, as it is, with its type (such as `image/png` or `application/pdf`) as `Content-Type`: **Choose file…** picks it. Files are 20 MB at most. As in the app, the request keeps only each file's name, and the file itself is chosen once a session: a file named but not chosen yet says **choose it again to send**. Runs in the **Testing** view and the runner send the files chosen in each request's editor; a request whose file is not chosen yet fails, saying to choose it in its **Body** tab. The **Auth** tab sets every kind the app has, with the same fields: **None**, **Inherit from collection**, **Bearer token**, **Basic auth**, **API key** (in a header or a query parameter), **Digest auth**, **JWT bearer** (signed with a shared secret or a private key, with its payload and extra header claims), **AWS Signature**, **OAuth 1.0**, **OAuth 2.0**, **NTLM**, **WSSE**, **Akamai EdgeGrid**, **Hawk**, or a **Saved credential** (choose one once the vault is unlocked). A line under the type says what it does, and fields that depend on another — a JWT's key, OAuth 2.0's grant type — show when they apply. A saved token, password, or other secret is never shown in VS Code: its field is marked **Saved**, and what you type replaces it when you save. Secrets go to the workspace through the command line's environment, never as arguments. A team folder never holds a secret value: one the API Workbench app on this computer has open keeps it with the app's own data for the folder, on this computer only; for one the app does not have, saving a literal secret is refused, so use a `{{variable}}` from an environment.

**GraphQL** requests are HTTP POSTs whose body is JSON with the query and its variables, as the app and GraphQL servers have them. The **Body** tab shows such a body as **GraphQL (query and variables)**: a **Query** editor, which colours keywords, fields, arguments, types, variables, values, strings, and comments in your theme's colours, beside a **Variables (JSON)** editor, coloured as JSON, where values like `"{{api_token}}"` come from the environment and stand out. When the query has several named operations, **Operation to run** chooses one. A line under them points out an unclosed bracket, variables that are not JSON, or a method other than POST. Choosing **GraphQL** for another request keeps a text body as its query and sets `Content-Type: application/json`; choose **Raw** to see the JSON itself. **Format** (<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>, as VS Code formats) lays the query out as GraphQL is usually written — two spaces a level, one field a line, arguments on the field's line, a blank line between definitions — and the variables as indented JSON. Strings, names, and comments are kept as written; a query with an unclosed bracket says where, and is left as it is. <kbd>⌘</kbd>+<kbd>Z</kbd> brings back the query as it was, and again the variables.

**Fetch schema** asks the endpoint for its schema with an introspection query, sent as the request is sent — its URL, headers, auth (saved credentials too, while the vault is unlocked), and environment — without saving anything or running its scripts; unsaved changes are saved first. With the schema, the **Query** editor suggests as you type: fields of the type at the cursor (with their types, descriptions, the arguments they need, and deprecations), a field's arguments after `(`, enum values and `true`/`false` after `:`, the operation's `$variables`, types in variable definitions and after `on`, and keywords at the top. <kbd>Ctrl</kbd>+<kbd>Space</kbd> shows suggestions anywhere; <kbd>↑</kbd> <kbd>↓</kbd> choose, <kbd>Tab</kbd> inserts (or <kbd>Enter</kbd>, once you have begun a name), <kbd>Esc</kbd> closes. **Schema** below lists the root fields and every type, searchable by name. A schema is kept until the window closes; **Fetch again** after the API changes. A server with introspection turned off says so.

GraphQL servers report a failed query with `200 OK`, so the response says when it has **GraphQL errors**, with the first message.

For **OAuth 2.0**, fill in the grant type, token URL, client, and scope, then choose **Get new access token** (unsaved changes are saved first). With **Client credentials** or **Password**, the token comes straight from the token endpoint; with **Authorization code**, your browser opens the provider's sign-in page, and the token arrives once you sign in (cancel the notification to stop waiting). The token is kept in the request (for a team folder, only when the app on this computer has it open), never shown; the tab says when it expires, and **Refresh** renews it with the saved refresh token. You can also paste a token into **Access token**.

The response appears beside the request: its status, time, size, and HTTP version, whether its tests passed, and tabs for the **Body** (**Pretty**, with JSON indented and coloured, or **Raw**), **Headers**, **Cookies**, **Tests** with captures, **Timing**, **Certificate**, and **Timeline**. **Timing** is the app's network timing: for each hop of the exchange, redirects included, how long DNS lookup, the connection, the TLS handshake, waiting for the server, and the download took, as bars on one axis, saying when a reused connection skipped the setup. **Certificate**, for HTTPS, shows the TLS connection — whether the server's certificate was verified and why not, its protocol, cipher, and HTTP version, and the client certificate presented — and each certificate of the server's chain, with its subject, issuer, validity and how long it has left, names, key, serial, and SHA-256 fingerprint. Values the send captured are listed under **Captured**. **Copy** copies the body; **Open as text** opens the whole response in an editor tab to search or save. Cookie values stay out of VS Code; the **Cookies** view lists their names.

The editor's buttons choose the environment, generate **Code**, **Copy as cURL**, and, for a team folder, **Open file** to edit the request's YAML. The editor follows your theme and fits a narrow column, where the response moves under the request.

In one of the app's workspaces the send is kept in [History](history.md), and the values it captures are saved into the environment for the requests after it, as a send in the app does. Turn `apiWorkbench.saveSends` off to leave the workspace as it was. A send never changes a team folder.

**Send Request** in the command palette lists every request of every source, grouped by workspace with each method's badge; the filter button at the top keeps it to the workspace in use. **Generate Code Snippet…** on a request asks for a language and library — the one you chose last comes first — and opens the code beside it, with secrets redacted, as the [code generator](code-snippets.md) makes it. **Import Collection…** at the top of **Collections**, or on a file in the Explorer, imports any format the app imports into the workspace you choose.

### Live connections

Click a WebSocket, gRPC, SSE, NDJSON, Socket.IO, or MQTT request, or choose **Send Request** beside it, to open it in a **live connection editor**. **Connect** opens the connection with the environment in use — its variables, headers, and auth applied as the app does — and **Disconnect** closes it, as does closing the tab.

- **Send a message** sends what you type (<kbd>⌘</kbd>+<kbd>Enter</kbd>) while the connection takes messages: an open WebSocket, or a gRPC call that streams from the client. **Finish** ends a gRPC client stream, after which the server may still reply. A **Socket.IO** message is emitted as its **Event** — the request's own, unless you change it — and **Wait for acknowledgement** shows the server's reply; an **MQTT** message is published to its **Topic** with a **QoS** and **Retain**, and the editor lists the topic filters it subscribes to when it connects.
- The request itself can be changed and saved (**Save**, <kbd>⌘</kbd>+<kbd>S</kbd>; **Unsaved** shows until you do): its URL in the bar at the top; its headers (gRPC metadata) and auth under **Headers & auth**, as in the [request editor](#send-a-request), with saved secrets never shown; and its protocol's own settings in the last tab:
  - **gRPC:** the **Method**, chosen from the methods the `.proto` schema defines once it is saved; **TLS**; the self-contained **.proto schema**; and the **Request message** of a unary or server-streaming call.
  - **Socket.IO:** the Engine.IO **Path**, the **Default event**, and **Wait for acknowledgement**; the namespace is the URL's path.
  - **MQTT:** the **Client ID** (generated when empty), **Version** (3.1.1 or 5), **Keep-alive**, **Clean start**, the **Subscriptions** made on connecting, each with its QoS, and the **Default topic**, **QoS**, and **Retain** of what it publishes.
  - **WebSocket, SSE, NDJSON:** the message **Sent when it connects**.

  A connection keeps what it opened with; the next **Connect** uses what was saved.

- **Messages** lists, newest first, what was received (↓) and sent (↑), handshake metadata, status, and errors, with JSON indented.

The connection runs in the command line (`request connect`). A request with a **saved credential** connects with it once the credential vault is unlocked in the **Credentials** view (or when you choose **Unlock and connect**); the password goes only to the connection, in its environment. A vault the app encrypts with the system's credential store, as it does on macOS and Windows unless you set a vault password, and a credential whose secret an external provider (such as AWS or Google Cloud) keeps, connect from the app.

### The network log

The **API Workbench** panel, beside the terminal, has three tabs: **Network**, a log of everything sent from VS Code in this window — sends, `.http` requests, test runs, and runner runs — with each request's method, status, type, size, time, and a waterfall; **Console**, what API Workbench did and what went wrong; and **Performance**, each request's sends, errors, and average, minimum, 95th percentile, and maximum times. **Clear Network Log** empties them.

## .http files

Files ending in `.http` or `.rest` are coloured as HTTP, and above each request are **Send request**, **Generate code**, **Open in Workbench** (the request in the request editor, to send it there), and **Save to collection**. <kbd>⌘</kbd>+<kbd>Enter</kbd> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> on Windows and Linux) sends the request under the cursor.

```http
@baseUrl = http://localhost:4010

### List orders
GET {{baseUrl}}/orders?limit=10
Accept: application/json

### Create order
POST {{baseUrl}}/orders
Content-Type: application/json

{ "sku": "TSHIRT-M", "quantity": 2 }
```

Requests are separated by `###`, followed by the request's name. `@name = value` lines are the file's variables. A file in a team folder also gets the variables of the environment that folder uses, so `{{base_url}}` and `{{token}}` work as they do in its saved requests; the file's own `@variables` win over the environment's, and values captured by its requests win over both. **Choose .http Environment…** — the status bar item shown while a `.http` file is open, or the layers button above it — picks another workspace's environment, **None** for the file's own variables only, or **Automatic** to go back to the team folder's. Environment values, secrets among them, stay with the command line: they are never written into the file or shown. What is sent is the editor's text, saved or not, and the file is never changed; the response opens beside it, and the send joins the network log. Values a request captures are given to the requests sent after it from the same file, until the window closes, and are listed under **Captured** in its response. A header line that is not `Name: value` is underlined, since the file cannot be sent until it is fixed — leave a blank line before a body.

A request can send a file. A body of one `< ./path` line sends that file as it is (`<@ ./path` too), and a `multipart/form-data` body is a form whose parts are text, or a file given by a `< ./path` line; a part's `filename="…"` names the file sent:

```http
### Import
POST {{baseUrl}}/import
Content-Type: text/csv

< ./data/export.csv

### Upload avatar
POST {{baseUrl}}/avatar
Content-Type: multipart/form-data; boundary=boundary

--boundary
Content-Disposition: form-data; name="title"

Me
--boundary
Content-Disposition: form-data; name="photo"; filename="me.png"
Content-Type: image/png

< ./images/me.png
--boundary--
```

Paths are relative to the `.http` file, even when its unsaved text is sent, and files are read when you send, 20 MB at most each; one that is missing fails that request, naming it. A path can hold `{{variables}}`, filled in as the rest of the request is — the file's `@name = value` lines, values captured by the requests before it, and built-ins such as `{{$isoDate}}` — so `< ./data/{{stage}}/users.csv` sends the file for the stage set at the top. `<@ ./path` also fills in the `{{variables}}` in the file's text before it is sent, as REST Client does; `< ./path` sends it exactly as it is. A variable nothing sets is named in the error, rather than looked for as a file. **Open in Workbench** shows the file, or the form with its file fields, under **Body**, and **Save to collection** saves the request with its file body or form — choose its files in the request editor, as for any saved request.

A `.http` file from a repository can point its requests at any server, so two things keep it from taking more than you meant:

- **Files stay in the project.** A `< ./path` file must be inside the repository the `.http` file is in (or its own folder outside one), after links are followed: `../fixtures/data.json` works, but `/Users/you/.ssh/id_rsa` or `../../.aws/credentials` is refused before anything is sent.
- **New hosts ask first.** The first time a request from the workspace's `.http` files or team folders (which come with a repository too) goes to a host, VS Code asks first. The host is worked out after the request's `{{variables}}` are filled in, so a variable cannot hide where it goes. It asks **Send to api.example.com?** with **Send** (this time) and **Always Allow This Host** (for this workspace). A run of a team folder's tests, or the Runner, first works out where its requests would go — with its environment and data file, sending nothing — and asks once about every new host, with **Run**, before anything is sent. A request whose host comes from an earlier response's capture can only be known during the run: it fails unsent, and afterwards the run asks about it, with **Run Again**, which sends the run's other requests again too. A team folder's live requests (WebSocket, gRPC, SSE, NDJSON, Socket.IO, MQTT) ask the same way before they connect to a new host, with **Connect**. Requests to this computer (`localhost`, `127.0.0.1`, `[::1]`) and from the app's own workspaces never ask; a redirect never leaves the origin it was sent to. **API Workbench: Forget Approved Hosts** asks again for every host; `apiWorkbench.confirmNewHosts` turns the question off, and only your user settings can change it.

**Save to collection** adds the request to a collection of a workspace you choose, keeping its `{{variables}}` for the workspace's environments to fill in.

## API specifications

OpenAPI 3 and Swagger 2 files (`.yaml`, `.yml`, `.json`) are checked when they open and each time they are saved: errors and warnings appear in the **Problems** panel and are underlined at their lines. Above the file are **Generate collection**, which makes a collection with a request for each operation in a workspace you choose; **Start mock**, which adds a mock server answering for each operation (with the specification's examples) to a workspace and starts it; **Preview docs**, its operations in an editor tab; **Check specification**; **Add to workspace**; and **Format**, with VS Code's formatter for YAML or JSON.

Click a specification in **API Specs** to open it read-only, with its problems; beside it, **Generate Collection from Spec…** makes its collection, asking before it replaces one, **Start Mock Server from Spec…** makes and starts its mock, and **Preview API Docs** lists its operations: its title and version, whether it is valid, and each operation's method, path, and summary, with deprecated ones struck through and marked. Type in its search box to find operations by path, method, or summary.

## Team folders in Git

A team folder in a Git repository shows its branch, commits to push (↑) and pull (↓), and changed files beside its name. Its menu has **Team: Show Changes** (open a changed file), **Team: Commit…**, **Team: Pull**, **Team: Push**, and **Team: Sync…** (commit, pull, and push, as the app's **Sync** does; also the ⟳ button beside it). When you and a teammate changed the same file, choose **Keep mine** or **Keep theirs**. git runs with your own name and email, through the command line's `team` commands.

## Mock servers

**Start Mock Server** (▶) beside a mock server in **Mock Servers** serves it, and opens its page: whether it is **Running** or **Stopped**, the address it serves at (**Copy URL**), and **Start** or **Stop** — closing the window stops it too. The status bar shows the port of the mock server running, or how many are. The page has three tabs:

- **Routes** is laid out as the app's: the routes on the left, filterable, with each one's method, path, status, and name, and the one chosen in an editor beside them. Its method and path sit in a URL bar after the mock's address (`:name` matches one part of a path, `*` the rest); then its **Name**, **Status**, **Delay**, and **Answers requests**; its **Content type** and **Body** (with **Format** for JSON, and templates such as `{{params.id}}`); and its **Response headers**, as a table that can be switched row by row or edited in bulk. **+ Add route** starts one as the app does (`GET /new-route`, answering `200 {}`), **Duplicate** copies the chosen route, and **Delete route** removes it. For a mock made from a collection, routes added become requests there and changing a route's method, path, or name changes its request, and a request added to the collection or changed there — from the request page, **New Request…**, a `.http` file, cURL, or the app — changes the mock's routes, and an open mock page shows them ([how](mock-servers.md#create-a-mock-server)); a mock running in VS Code serves that after **Restart**. Its header says whether the two are **In step with it**, or how many requests have no route and routes have no request, with **Sync now** to add what is missing on both sides. Rules, other answers, validation, and streaming messages are edited in the app.
- **Settings** changes its **Name** and **Port** (and its gRPC and MQTT ports, when it has them); **CORS** — whether browsers may call it, its allowed origins, methods, and headers, exposed headers, credentials, and max age; its **Default headers**, sent with every answer, as a table that can be switched row by row or edited in bulk (a value that looks secret stays hidden unless replaced); and **HTTPS** with your own certificate and key files.
- **Request log** lists each request it answers, newest first.

**Save** (<kbd>⌘</kbd>+<kbd>S</kbd>) keeps the changes and **Discard** drops them; **Unsaved changes** shows until you do one. A running mock keeps its old settings until **Restart**, which the page offers after a save.

A mock server that serves HTTPS with the app's own certificate authority runs only in the app; one with its own certificate files runs here too.

## Run tests

**Run Tests** (▶) on a request, a folder, a collection, or a whole source runs it, and the **Testing** view shows each request as passed, failed, or errored, with the failed tests' messages. Everything in the **Testing** view can be run from there too, with its usual buttons and filters. When a run finishes, the **Test results** page opens beside it: whether it passed; tiles for requests, passed, failed, tests, and time; each request's outcome, with its status, time, and tests — failed ones open, with what was expected and what came — filtered by **All**, **Failed**, or **Passed**; **Open request** on each; and an **Output** tab with the run's report as the command line prints it. **Run again** repeats the run, and **Show output in Testing** opens VS Code's own. Turn the page off with `apiWorkbench.showTestResults`.

A request passes when all its tests pass; one without tests passes when its status is from 200 to 399, as in the [Runner](runner.md). A request sent several times, such as once per data row, passes only when every send did.

### The runner

**Run Collection in Runner…**, at the top of **Collections** or on a source or folder, opens the runner for a workspace, as the app's [Runner](runner.md) does. Choose the requests (every one, or a collection or folder) and a mode:

| Mode            | What it does                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collection**  | Runs the requests with their tests, **Iterations** times, with a **Delay** between requests; **Stop at the first failure**, and **Use a data file…** to run once per row of a CSV, JSON, YAML, or XML file |
| **Benchmark**   | Sends each request **Iterations** times, **Concurrency** at once, as fast as it can                                                                                                                        |
| **Performance** | Keeps **Concurrency** requests in flight for **Duration** seconds                                                                                                                                          |

**Run** shows the result, the requests, failures, and tests, as tiles, then each send with its status, time, and tests, and under a failed one why it failed; a load test shows its throughput, error rate, and latency percentiles. **Stop** ends a run early. The run uses the workspace's environment, and its sends join the network log.

**Run Only Tagged Requests…** on a source limits its runs to requests with any of the [tags](requests.md#tags) you choose, as the command line's `--tag` does; choose none to run them all again. The source shows the tags in use.

## Copilot and other chat tools

In Copilot's agent mode, and other chat in VS Code that uses tools, API Workbench gives the model four tools. Mention one with `#` or let the model choose:

| Tool              | What it does                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `#apiRequests`    | Lists the requests of the open workspaces: method, folder, name, id, tags, and the environment in use                          |
| `#sendApiRequest` | Sends one request with the workspace's environment and returns its status, timing, tests, headers, and up to 16 KB of its body |
| `#runApiTests`    | Runs a workspace's requests, or one collection's, with their tests, and returns the result and each failure                    |
| `#checkOpenApi`   | Checks an OpenAPI or Swagger file in the open folder and returns its errors and warnings with their lines                      |

VS Code asks you before every send and run, saying what will be sent and where. A model's send never saves into the workspace — no History entry, no captured values in the environment — and the requests' scripts run only when **apiWorkbench.scripts** is **allow**. What the model sees is what the command line prints: header values whose names look secret stay `<hidden>`, and saved credentials are never shown. A request with a **saved credential** is sent with it only while you have the credential vault unlocked, as your own sends are, and the confirmation says so; the vault's password and the credential's secret never reach the model, though a response that repeats a secret would. With the vault locked, the model is told to ask you to unlock it, and never for the password. To keep saved credentials away from the tools altogether, even with the vault unlocked, turn off `apiWorkbench.toolsUseSavedCredentials` in your user settings: a tool then sends no request that uses a saved credential, the confirmation says so, and the model is told you can send it yourself. Turn the tools off in the chat's tool picker.

## Help and feedback

The **Help and Feedback** view under **API Workbench** (and the command palette) has **Report a Problem…**, which asks for a one-line summary and opens GitHub's bug report form with the extension's version, VS Code's version, your platform, how the command line runs, and how many workspaces are open filled in — never paths, names, URLs, or what your requests hold. Turn that off with `apiWorkbench.reportDiagnostics`. It also has **Request a Feature…**, **Search Known Issues…**, **Report a Security Vulnerability…** (privately, never in a public issue), **Open Documentation**, **Troubleshooting and FAQ**, **What's New**, **View on GitHub**, and **Copy Diagnostic Information**. The same links are in the description of `apiWorkbench.reportDiagnostics` in **Settings**.

Each page the extension opens — a request, the runner, a mock server, a specification, environments, credentials, certificates, and test results — has a **Guide** button at the top that opens the guide for that page in your browser.

## Get started

**Help → Welcome** has a **Get started with API Workbench** walkthrough: finding your workspaces, editing and sending a request, `.http` files, and testing, mocks, and Copilot.

## Scripts

Requests with [scripts](scripts.md) run code from the workspace, so the first time the extension sends or runs them in a window it asks whether to run the scripts, and keeps the answer until the window closes. Set `apiWorkbench.scripts` to `allow` or `skip` in your user settings to answer for good. Scripts run in the command line's sandbox, with no access to files, the network, or the vault.

### Edit scripts

The request editor's **Scripts** tab shows a request's **Pre-request script** and **Post-response script**. **Edit in editor** (or **Add script**) opens one beside the request in VS Code's own JavaScript editor, named after the request, such as `List users · pre-request.js`. Save it (<kbd>⌘</kbd>+<kbd>S</kbd>) to save it to the request; save it empty to remove it.

While you type, the editor suggests what the app's script editor does: the members of `aw`, the names of the environment's variables and the request's headers inside `aw.vars.get('…')` and the like, and — once you have sent the request in this window — the last response's header names and JSON keys. A syntax error is underlined, found by parsing the script, never by running it.

Saving never runs a script. In VS Code it runs only as `apiWorkbench.scripts` allows; in the app, a script changed here is new to it, so it waits for **Allow scripts** before it runs.

## Secrets

The extension never shows a secret. Header values whose names look secret show as `<hidden>`, as they do in the command line, and generated code and cURL commands are redacted.

[Saved credentials](credentials.md) stay in the app's vault, and VS Code opens only the **API Workbench vault**, with its password. **Credentials** lists their names, types, and the origins each may be sent to. **Unlock Credential Vault…** asks for the password and checks it, then keeps it **Until this window closes** or, if you choose **Remember in the system keychain**, in VS Code's secret storage (the macOS Keychain, Windows Credential Manager, or the Linux Secret Service), so new windows unlock on their own. The password is only ever given to the command line. **Lock Credential Vault** locks this window; **Forget Saved Vault Password** removes the remembered one.

**Open Credentials** (the shield in **Credentials**, or **Add Credential…** and **Edit Credential…**) opens a page laid out as the app's **Credentials** screen: cards for the vault, how many credentials there are, and OAuth connections; the credentials as a table — each one's name and kind, where its secret is kept, its allowed origin, and whether it is ready — filtered by kind and searched by name or origin; and **+ Add credential**. The form takes a name, a kind — **Bearer token**, **Basic auth**, **API key**, **OAuth 2.0**, **Digest**, **JWT**, **AWS Signature**, **OAuth 1.0**, **NTLM**, **WSSE**, **Akamai EdgeGrid**, or **Hawk** — the origin it may be sent to, and that kind's fields, as a request's **Auth** tab has them. Secrets are typed only to save them: they go to the vault through the command line's environment, are never shown again (their fields say **Saved**), and an empty one keeps what is saved. Getting an OAuth 2.0 credential's token (**Connect**) and external secret providers stay in the app; client certificates have their own page, below.

### Certificates

**Open Certificates** (the shield with a check in **Credentials**, or from the Command Palette) opens a page laid out as the app's **Settings → Certificates**. **Client certificates** lists the workspace's certificates for mutual TLS: the host each is presented to (a port, or `*.example.com` for its subdomains), its subject and issuer, **PEM** or **PFX**, how long it is valid — **Expires in 9 days** or **Expired** stand out — and a switch to stop presenting it without removing it. **Add certificate…** asks for the host and port, whether it is a **PEM certificate and key** or a **PFX/P12 bundle**, the files, in VS Code's own file dialog, and the passphrase, in a hidden box; the certificate is checked with it, then kept in the API Workbench vault, so VS Code asks to unlock the vault first. **Remove** takes it and its key out of the vault; the files stay. **Trusted CA certificates** lists the CAs the workspace trusts as well as the system's, such as a company's or a local test CA: **Add CA…** adds a PEM file's, **Stop trusting** goes back to the system's alone.

Requests sent or run from VS Code over HTTPS present the most specific matching certificate, as the app does: an exact host before a wildcard, a port before any port. Live connections — `wss://`, TLS gRPC, and the rest — present client certificates only in the app. The page never holds a key, passphrase, or file path, and the command line never prints them.

Credentials the app keeps in the system's credential store open only in the app. To use them in VS Code, choose **Use the API Workbench vault…** in the app's **Credentials** ([how](credentials.md#use-your-credentials-in-vs-code-and-the-command-line)); unlocking in VS Code says so when it finds them there.

A request that uses **Saved credential** auth — sent, run in the Testing view or the runner, or connected live — uses it once the vault is unlocked; if it is locked, the result offers **Unlock and send again**. A credential is sent only to the origin it is for, and its secret is never shown. A **team folder** in your repository uses saved credentials when the API Workbench app on this computer has the same folder open: its credentials are listed under **Credentials**, the request editor's **Saved credential** chooses among them, and requests are sent with them. Which credential a request uses is kept with your own settings in the app, never in the shared folder, so each teammate chooses their own. A team folder the app does not have keeps none: open it in the app, or keep the secret in an environment variable, such as `Bearer {{api_token}}`. Credentials kept in the system's credential store, or by an external provider such as AWS, work only in the app.

## Settings

| Setting                                 | Default   | What it does                                                                                                               |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apiWorkbench.showAppWorkspaces`        | on        | Also list the app's own workspaces                                                                                         |
| `apiWorkbench.saveSends`                | on        | Keep sends in an app workspace's History and save captured values, as the app does                                         |
| `apiWorkbench.scripts`                  | `ask`     | `ask`, `allow`, or `skip` requests' scripts                                                                                |
| `apiWorkbench.confirmNewHosts`          | `true`    | Ask before a `.http` file or team folder sends to a host not yet approved for the workspace (user settings only)           |
| `apiWorkbench.toolsUseSavedCredentials` | on        | Let Copilot's tools send requests with their saved credentials while the vault is unlocked                                 |
| `apiWorkbench.showTestResults`          | on        | Open the **Test results** page when a run finishes                                                                         |
| `apiWorkbench.reportDiagnostics`        | on        | Fill in versions and platform when you report a problem on GitHub; its description links to every help option              |
| `apiWorkbench.engine`                   | `builtIn` | `commandLine` runs each command in a process of its own; see [Run without the command line](#run-without-the-command-line) |
| `apiWorkbench.nodePath`                 | empty     | The Node.js 22.19 or later to run the command line with                                                                    |
| `apiWorkbench.cliPath`                  | empty     | Another copy of the command line, such as a newer [release file](cli.md#install)                                           |
| `apiWorkbench.dataDir`                  | empty     | The app's data folder, when it is not the usual one                                                                        |

`engine`, `scripts`, `toolsUseSavedCredentials`, `nodePath`, `cliPath`, and `dataDir` can only be set in your user settings. A workspace's `.vscode/settings.json` cannot choose the program the extension runs, turn scripts on, or hand saved credentials to the tools.

### Run without the command line

By default the extension runs its bundled command line inside VS Code: its code is loaded once and called directly, so listing, sending, and saving answer at once, with no separate process and no Node.js to install, as VS Code's own runs it. Set `apiWorkbench.engine` to `commandLine` to run each command in a Node.js process of its own instead; each then takes about a second longer to start, but a very long run is kept apart from VS Code's extension host, which it otherwise shares with your other extensions. Running inside VS Code needs its Node.js to be 22.19 or later, as recent versions have; on an older one the extension says so in its output channel and uses a process of its own. Requests, runs, mock servers, and live connections behave the same either way, and request scripts run in the same QuickJS sandbox. The output channel says which is in use.

## Troubleshooting

| What you see                                       | What to do                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _API Workbench needs Node.js 22.19 or later_       | Shown only with `apiWorkbench.engine` set to `commandLine`, or a VS Code whose Node.js is older than 22.19: install Node.js 22.19 or later, or set `apiWorkbench.nodePath` to one |
| The view says no workspaces were found             | Open a folder that holds a team folder, or open the app once so its workspaces exist, then **Refresh**. **Show Output** lists what was found                                      |
| A source shows an error instead of its collections | The message is the command line's; **Show Output** has the details                                                                                                                |
| _No environment “…”_                               | The environment was renamed or deleted: **Switch Environment…** again                                                                                                             |
| A mock server stops as it starts                   | Its port is in use, or it serves HTTPS with the app's certificate authority; the message says which                                                                               |
| A request passes in the app but fails here         | Compare the environment in the status bar with the app's: the extension keeps its own choice for each source                                                                      |
| The extension does nothing                         | Trust the workspace: **Manage Workspace Trust** in the command palette                                                                                                            |

## For contributors

The extension is `packages/api-workbench-vscode`. Its logic is in `src/core/` without VS Code's API, tested with `npm test`; `npm run test:vscode` also runs it inside an installed VS Code (set `VSCODE_EXECUTABLE` if it is not in the usual place). `npm run vscode:package` builds the `.vsix` in `packages/api-workbench-vscode/dist/`. To try a change, run `npm run build -w api-workbench-vscode`, then `code --extensionDevelopmentPath=packages/api-workbench-vscode <a folder>` starts VS Code with the extension from source.
