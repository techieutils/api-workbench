---
description: Build and test commands, architecture, and the exact behaviour, limits, and security rules of every feature.
icon: file-code-outline
---

# Technical reference

The detailed reference for API Workbench: build and test commands, architecture, and the exact behaviour, limits, and security rules of each feature. For task-oriented guides, start with [Getting started](getting-started.md).

## Run

Requires Node.js 22.19 or later (24 recommended) and npm.

```sh
npm install
npm start
```

- `npm run check` — strict TypeScript checking.
- `npm run lint` / `npm run lint:fix` — ESLint recommended JavaScript and TypeScript rules, with zero warnings allowed.
- `npm run format` / `npm run format:check` — format or verify HTML, Tailwind CSS, and TypeScript UI components with Prettier.
- `npm test` — vault, OAuth, callback, redirect, and cancellation tests. The callback integration tests bind temporary localhost ports.
- `npm run test:ui` — launches Electron with disposable workspace data, exercises the settings and authentication screens, and checks rendered DOM behavior. Add `-- --screenshots` to optionally capture images in `artifacts/` when the host supports graphics capture. No real provider login or credentials are used.
- `npm run compile` — compiles TypeScript, copies local assets, and generates readable Tailwind CSS in `packages/api-workbench-app/dist/`.
- `npm run compile:prod` — compiles TypeScript and minifies only the generated HTML/CSS in `packages/api-workbench-app/dist/`.
- `npm run test:ui:prod` — exercises the desktop UI using production-minified assets.
- `npm run build` — runs lint/format checks, compiles production assets, and creates an unpacked desktop application under `release/`.
- `npm run dist` — runs the same checks and production compilation, then packages an installer for the current platform.
- `npm run preview` — serves the compiled renderer at http://localhost:4173. Browser preview is subject to CORS and does not provide the credential vault or OAuth. Redirect handling is available in the desktop app.

## Import and export

Use **Import** from Collections, Overview, Documentation, or Settings → Data. Choose one or more files, a collection folder, or a ZIP, or paste JSON/YAML, WSDL, or cURL. The preview lists requests, environments, and conversion notes; **Import into workspace** appends everything only after the complete input passes validation. A failed import leaves existing data intact. Environment-only files are supported.

Use **Export** or Settings → Data → **Choose format** to export the entire workspace or a selected collection. ZIP packaging is available for every format. Credentials, recognized sensitive fields, responses, history, and attachment bytes are excluded.

| Format             | Import                                                                                                                                                                             | Export                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| API Workbench      | Workspace/collection JSON, environment bundles                                                                                                                                     | JSON; preserves all protocols, settings, environments, and assertions                                  |
| Postman            | v2.0/v2.1 collections and environment JSON; inherited auth, nested folders, raw/GraphQL/forms                                                                                      | v2.1 collection JSON; ZIP includes every environment                                                   |
| Bruno              | `.bru` files/folders/ZIPs, collection/environment defaults, Bruno collection JSON                                                                                                  | Native `.bru` requests and environments with `bruno.json` in ZIP; includes referenced gRPC proto files |
| OpenCollection     | Bundled YAML, individual request/environment files and folders                                                                                                                     | Bundled YAML with environments; gRPC proto sidecars automatically produce ZIP                          |
| Insomnia           | v4 resource JSON and v5 collection/environment YAML                                                                                                                                | v5 YAML or legacy v4 JSON, for HTTP requests                                                           |
| Hoppscotch         | REST and GraphQL collection JSON (one collection or an array); nested folders, inherited auth and headers, collection variables; environment JSON (secret values are not exported) | Not supported; export Postman or OpenAPI, which Hoppscotch imports                                     |
| OpenAPI / Swagger  | OpenAPI 3.x and Swagger 2.0 JSON/YAML; local file references inside selected folders/ZIPs                                                                                          | OpenAPI 3.1 JSON/YAML or Swagger 2.0 JSON, generated from saved HTTP requests                          |
| WSDL / SOAP        | Inline service/binding/schema definitions; generates SOAP 1.1/1.2 request templates (`.wdsl` also accepted)                                                                        | WSDL 1.1 service skeleton for SOAP requests; generic schemas require review                            |
| HAR                | HAR 1.2 request entries                                                                                                                                                            | HAR 1.2 requests; does not export captured responses                                                   |
| cURL               | Common request/header/data/form/auth options; commands are parsed, never executed                                                                                                  | Shell-quoted HTTP commands                                                                             |
| HTTP / REST Client | `.http`/`.rest` requests and file variables                                                                                                                                        | Plain text HTTP requests separated by `###`                                                            |
| ZIP                | Mixed supported documents, Bruno folders, environments, and proto sidecars                                                                                                         | Optional archive for any format; required when multiple sidecars are included                          |

Imports limit individual documents to 10 MiB, total expanded data to 50 MiB, and inputs to 1,000 files and 10,000 requests. ZIP traversal paths and nested ZIPs are rejected; files are processed in memory. Remote references and external WSDL/XSD imports are not fetched. Source JavaScript scripts/tests, advanced auth flows, and tool-specific extensions need manual configuration; conversion notes explain unsupported data. WebSocket and gRPC export through API Workbench, Bruno, or OpenCollection. Other formats export compatible HTTP requests; SSE/NDJSON retain their HTTP request data but need streaming mode selected in the receiving tool. Specifications retain one operation per method/path and report duplicate examples or incompatible Swagger servers.

Format references: [Postman v2.1 schema](https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json), [Bruno language parser](https://github.com/usebruno/bruno/tree/main/packages/bruno-lang), [OpenCollection specification](https://spec.opencollection.com), [Insomnia v4/v5 formats](https://developer.konghq.com/insomnia/import-export/), [Hoppscotch collection schema](https://github.com/hoppscotch/hoppscotch/tree/main/packages/hoppscotch-data), and [WSDL 1.1](https://www.w3.org/TR/wsdl.html).

## Local protocol samples

See [the protocol playground](../examples/protocol-playground/README.md) for local HTTP, GraphQL, WebSocket, SSE, NDJSON, and gRPC samples. Install its isolated dependencies with `npm install --prefix examples/protocol-playground`, then run `npm run samples:start`. Import [collection.json](../examples/protocol-playground/collection.json) for 14 HTTP examples, including finite SSE/NDJSON responses. Run `npm run samples:test` for real protocol client checks on temporary local ports.

Import [live-collection.json](../examples/protocol-playground/live-collection.json) for seven native WebSocket, SSE, NDJSON, and gRPC examples. Choose the protocol beside the request URL, or use **Use local sample** in a live connection editor.

## Live protocol connections

The select at the start of the URL bar lists the HTTP methods (**GET**, **POST**, **PUT**, **PATCH**, **DELETE**, **HEAD**, **OPTIONS**, **TRACE**, **CONNECT**) under **HTTP · REST and GraphQL**, then the live protocols **WebSocket**, **SSE**, **NDJSON**, **gRPC**, **Socket.IO**, and **MQTT**; choosing a method makes the request HTTP with it. Existing requests default to HTTP. Protocol, message, headers, authentication fields, timeout, gRPC schema/method/TLS settings, Socket.IO path/event/acknowledgement, and MQTT client/session/subscription/publish settings save with each request and survive collection export/import. Connection editors share the HTTP composer and tab styling, with Message/Schema, Headers/Metadata, Auth, and Settings tabs. Message and schema fields use the shared source editor. All request types share the response layout: a line-numbered Body editor, Headers table, Timeline, Pretty/Raw controls, language selection, Format, Copy, and Download. For live protocols, Pretty combines JSON messages into an array; Raw retains the original decoded message data in arrival order. Timeline shares HTTP timing bars and adds sent/received activity markers, first-message/setup timing, decoded byte counts, an endpoint snapshot, and expandable event history with SSE names/IDs and protocol status. Timings use captured application events; DNS/TCP/TLS phases are not inferred. Raw shows the measured report and all retained events. Live messages stay in memory; Download exports the selected response tab.

- **WebSocket:** connect to `ws://` or `wss://`, send text or base64 binary frames, and inspect inbound/outbound messages.
- **SSE:** connect to an HTTP(S) event stream; events appear immediately with names and IDs. Multi-line event data and split UTF-8/CRLF chunks are supported. Reconnect manually after a disconnect; automatic retry/resume is not yet implemented.
- **NDJSON:** connect to an HTTP(S) newline-delimited JSON endpoint and inspect each complete message as it arrives.
- **gRPC:** import or paste a self-contained `.proto`, click **Discover methods**, and enter/select a service method. Supply a `host:port` and a JSON message, then **Invoke**. Unary, server-streaming, client-streaming, and bidirectional calls are supported. Writable calls send the initial message when invoked; use **Send message** for subsequent messages and **Finish sending** to close the send side. Metadata, messages, status, and errors appear live. Enable TLS for system certificate validation. Proto imports, reflection, custom CAs, and mutual TLS are not yet supported.
- **Socket.IO:** connect to `http(s)://` or `ws(s)://`; the URL path is the namespace and **Settings → Socket.IO path** the Engine.IO path (`/socket.io`). Connections use the WebSocket transport only, without polling or automatic reconnection. Every incoming event appears with its name (`onAny`): one string argument as text, one Buffer as base64, other arguments as JSON (several as an array). **Emit** sends the message as the **Event**: valid JSON as its value, other text as a string, or base64 bytes. **Wait for acknowledgement** emits with a 10-second callback whose reply appears as `<event> (ack)`. Reserved event names (`connect`, `disconnect`, …) are refused. Only header-based authentication works: Digest and URL-covering signatures (AWS, OAuth 1.0, EdgeGrid, Hawk) are refused because Engine.IO adds its own query.
- **MQTT:** connect to `mqtt://` (1883), `mqtts://` (8883), `ws://`, or `wss://` with MQTT 3.1.1 or 5, a client ID (generated as `api-workbench-xxxxxxxx` when empty, up to 256 bytes), keep-alive (0–65535 s), and clean start. Enabled **Topics** rows (up to 50, each with QoS 0–2) are subscribed after CONNACK; the timeline reports each grant or refusal. **Publish** sends to **Publish to** with the chosen QoS and retain flag; publish topics may not contain wildcards, and filters must use `+` and `#` as whole levels (`#` last). Incoming messages appear with their topic, as UTF-8 text or base64. Basic auth becomes the CONNECT username and password; other Authorization headers and signing need ws(s), where headers go on the handshake. Proxies apply to ws(s) only. MQTT 5 clients advertise a 2 MiB maximum packet size. There is no automatic reconnection.

Live protocols require Electron. They use the same Auth template as HTTP, including None, saved credentials, OAuth 2.0, Bearer, Basic, and API-key authentication. Vault secrets are resolved in the main process at connection time. Credentials keep their exact origin restrictions: ws/wss map to HTTP/HTTPS, gRPC maps to HTTP for plaintext or HTTPS with TLS, and MQTT brokers map to HTTP (`mqtt`, `ws`) or HTTPS (`mqtts`, `wss`) with the broker's port, 1883 or 8883 by default. Refresh or connect OAuth profiles in Credentials before use. The HTTP assertion/benchmark runner currently applies to HTTP requests. OpenAPI/Swagger exports include HTTP/SSE/NDJSON endpoints; API Workbench JSON exports also retain WebSocket, gRPC, Socket.IO, and MQTT requests. Mock servers do not serve Socket.IO or MQTT, so mocks generated from a collection skip those requests. gRPC binary metadata keys end in `-bin` and accept base64 values.

Connections stay active while switching request tabs. Closing a tab, changing its protocol, deleting its request, reloading, or quitting disconnects it. Disconnect live connections before changing workspaces. Session timeout defaults to five minutes and is configurable from 100 ms to one hour. Up to ten sessions may run; messages are limited to 1 MiB and each session to 10 MiB total event data. The viewer retains the latest 500 entries, capped at 2 MiB. HTTP streaming redirects are surfaced as errors so authentication headers are not forwarded to another destination.

`npm run test:ui:protocols` tests the actual Electron editor and IPC using disposable data and local protocol servers. `packages/api-workbench-electron/src/protocols.spec.ts` covers parser chunk boundaries, WebSocket frames, all gRPC call types, validation, and cleanup; `pubsub-protocols.spec.ts` runs Socket.IO against a real server and MQTT against an in-process broker (aedes).

## Source and production assets

`packages/api-workbench-app/public/index.html` and `packages/api-workbench-app/src/styles/styles.css` remain formatted source files. Development commands copy formatted HTML and generate readable CSS from the Tailwind source. Production compilation uses `html-minifier-terser` for HTML and the Tailwind CLI optimizer for CSS to write minified output under `packages/api-workbench-app/dist/`; it never rewrites the source. Script loading order, the content security policy, and CSS rule order are preserved.

ESLint uses a flat configuration in `eslint.config.mjs`, ignores generated output, and understands the renderer's shared browser scripts. The application continues to compile with TypeScript 7 through the `typescript-build` package alias. The `typescript` dependency is pinned to the compatible 6.0 series for ESLint's compiler API, since `typescript-eslint` does not yet support TypeScript 7. Use the npm scripts for application compilation and type checking.

## Branding and desktop icons

The selected assets from the API Workbench Electron Icon Pack are checked into `packages/api-workbench-assets/src/icons/` and `packages/api-workbench-app/src/assets/`. No Downloads-folder references are used at runtime.

- macOS uses the multi-resolution `icon.icns` for Dock/Finder and packaged applications. It includes transparent padding to match the visual scale of neighboring Dock icons; the runtime fallback uses the matching `icon-mac.png`.
- Windows uses `icon.ico`, with dedicated NSIS installer and uninstaller icons.
- Linux and development windows use the supplied 1024px PNG; macOS development runs launch a cached API Workbench.app with its ICNS icon embedded before startup.
- The header uses the crisp SVG app mark. Settings and the overview use the supplied wordmarks for dark/light backgrounds and a 512px app illustration. Browser previews include favicons and an Apple touch icon.
- **Navy** and **Pearl** themes use the logo's navy (`#07194E`), violet (`#6D1CFF`), and turquoise (`#06D8C0`). Violet identifies primary actions; turquoise identifies successful responses. Text accents adapt for contrast in each theme.

See `assets/README.md` for the selected source files and usage.

Typography uses `Geist` for headings, `Inter` for body text, and `Geist Mono` for code, URLs, and parameter fields, with the configured system fallbacks. Variable WOFF2 fonts and their licenses are bundled locally from the Fontsource packages during compilation; no font CDN or system installation is required.

## Tailwind design system and UI components

Tailwind CSS 4 is compiled locally with the official CLI; no browser CDN or runtime CSS injection is used. `packages/api-workbench-app/src/styles/styles.css` defines the brand, typography, light/dark tokens, and reusable component styles using Tailwind `@theme`, `@layer`, and `@apply`. Tailwind scans renderer TypeScript files for utility classes.

- `npm run styles:build` generates readable CSS.
- `npm run styles:prod` generates optimized/minified CSS.
- `npm run styles:watch` rebuilds CSS during styling work; use alongside the desktop app or browser preview.

The renderer is Vue 3 with Pinia (`packages/api-workbench-app/src/`). `packages/api-workbench-app/src/components/ui/` holds the shared primitives: buttons, icon buttons, badges, fields, select boxes, expansion panels, tabs, empty states, and metric cards. `UiSelect` is a searchable combobox (filter for lists over ten options, groups, type-ahead, arrow/Home/End/Page keys) whose list opens in the top layer; a hidden native select keeps forms, labels, and `change` handlers working. Confirmations use `confirmAction()` and an in-app modal dialog instead of `window.confirm`; destructive ones start on Cancel and Escape cancels. Toasts (`toast(message, tone)`) appear bottom right above the status bar with a success, error, warning, or info icon and colour, an optional action, a close button, and a countdown that pauses on hover or focus; errors stay longest and are announced as alerts, up to four stack, and a repeated message refreshes instead of duplicating. The screens, request editors, response viewers, and dialogs are components backed by stores in `packages/api-workbench-app/src/stores/`, which hold the workspace document, sending, authentication, live protocols, and the vault. Tabs support arrow keys, Home, and End; credential dialogs retain focus trapping and secret masking. See `packages/api-workbench-app/src/README.md` for how it fits together.

## Workspace

- HTTP and GraphQL requests, collections, tabs, request duplication and deletion.
- Editable query parameters, headers, raw bodies, request names, and environment substitution with `{{variable}}`.
- Reorder saved header and parameter rows by dragging the MDI handle, or focus it and use Arrow Up/Down, Home/End. Values, descriptions, and enabled states move together; parameter order updates the URL and persists with the request. Automatic headers remain pinned above custom rows.
- Pretty/raw responses, headers, HTTP status, response size, total duration, and assertions.
- HTTPS responses include a **Certificate** tab with the public peer chain, subject/issuer, validity, SANs, serial number, key type/size, fingerprints, TLS protocol/cipher/ALPN, Pretty/Raw JSON, and PEM downloads. Metadata comes from the actual request socket and follows pooled connections and exact resumed TLS sessions; trust verification is enabled by default and reflects the effective HTTP settings. The chain may omit a root. Old responses and browser preview may lack certificate data; resend in Electron. Public certificate metadata follows the existing response-persistence setting.
- Collection runner, API benchmarks, and duration-based performance tests with live metrics and exportable reports.
- Request history with configurable retention; response persistence is off by default.
- Generated collection documentation, multi-language request code generation, response downloads, API Workbench backup import/export, Postman v2 collection import, and Swagger 2.0 / OpenAPI 3.x JSON and YAML import.
- Locally bundled Material Design Icons (MDI) SVGs with consistent sizing and theme colors; no icon CDN or remote font required.
- Overview dashboard, consistent navigation, dark/light/system themes, comfortable/compact density, response font size, line wrapping, and keyboard shortcuts.

## Runner benchmarks and performance tests

Open **Runner**, choose a collection, environment, and requests, then select a mode:

- **Collection:** sequential requests with saved assertions and configurable iterations/delay; updates the latest responses and normal history.
- **API benchmark:** a fixed number of iterations per request with concurrent workers and excluded warm-up iterations.
- **Performance test:** repeated requests for a configured duration and a maximum request count, using one of two load models:
  - **Concurrent workers (closed):** each worker sends its next request when the previous one finishes, with gradual worker ramp-up and per-worker delay. A slower API therefore receives less load.
  - **Target request rate (open):** requests start on a fixed schedule at the target req/s whatever the API's latency, as real traffic arrives, with an optional linear ramp-up from zero to the target. The worker count becomes the in-flight limit; a start that would exceed it is skipped and counted as **dropped**, so saturation is reported instead of silently lowering the rate.

Runs support 1–50 workers, up to 100,000 measured requests, and durations up to one hour. Stop cancels active requests and pending worker waits. Stop-on-failure prevents further scheduling while already active requests finish. Each run snapshots the selected requests and environment before dispatch. In collection runs, values captured by a request's **Vars** are available to the requests after it; benchmarks and performance tests keep the environment as it was when the run started.

Results include completed/cancelled counts, requests per second, successful throughput in JSON reports, error rate, average/min/max and p50/p90/p95/p99/p99.9 latency, the standard deviation and 95% confidence interval of the mean, received bytes, assertion totals, status breakdowns, per-request statistics (average, median, p95, p99, max), and filterable samples. In the desktop app each sample also records **network time** (measured in the main process, without the renderer's dispatch and assertion overhead) and **time to first byte**, summarized as network p50/p95/p99 and TTFB p95.

Charts show **activity over time**—throughput, p95 latency, and failed requests per interval, on a shared time axis—and the **latency distribution** with the p95 marked; point at either, or focus it and use the arrow keys, to read values, and each has a table view. **Top errors** groups failures by kind and message (transport errors keep their message, with the request URL and likely secrets redacted; a host and port named by a network error remain). **Save as baseline** keeps a run's key metrics for its collection and mode in this browser profile; later runs show the change in throughput, latency percentiles, network p95, and error rate, flagging changes over 10% in the worse direction as regressions. Configure successful HTTP status bounds plus pass/fail thresholds for p95, error rate, and minimum throughput. HTTP, transport, and assertion failures are distinguished; HTTP and assertion counts can overlap.

This is a desktop client workload. With workers, each waits for its response before sending its next request; with a target rate, starts follow the schedule up to the in-flight limit. Client latency includes dispatch, response transfer, and assertion evaluation; network time and TTFB exclude them. Warm-ups are sequential and excluded from measured statistics. Ramp-up is included in measured elapsed time. The duration deadline stops new dispatches, drains in-flight requests, and includes drain time in throughput calculations. Percentiles use nearest rank; cancelled samples are excluded from latency, error-rate, and throughput counts, while completed failures are included.

Runner also samples **application CPU and memory** every 500 ms, with initial and final readings so short runs receive resource data. Monitoring begins after warm-up and continues through request draining. Live cards show the latest CPU percentage and memory in MiB; results show time-weighted average and sampled peak CPU, initial/peak/latest memory, and signed memory change. The first CPU reading establishes a baseline and is excluded from CPU statistics. Missing readings are reported without interrupting requests.

Resource scope is the API Workbench Electron application, including its helper processes, rather than the remote API server. CPU sums Electron-reported process percentages; memory sums process working sets and can count shared pages more than once. Peaks are sampled peaks, not continuous maxima, and other activity in the app can affect these readings. Browser preview shows resources as unavailable. Full resource samples and summaries are included in JSON reports, and **Resources CSV** exports the timestamp offsets, intervals, CPU, memory bytes, and process counts separately from request samples.

Benchmark/performance runs preserve normal request history and response snapshots. Reports stay in memory for the active workspace and clear when switching workspaces. JSON exports contain configuration, thresholds, workspace/environment/collection names, request names, the per-interval timeline, grouped errors, and all measured samples; CSV exports contain all measured samples, including start offset, network time, TTFB, and the failure message. Exports omit request URLs, headers, payloads, response bodies, and environment values. The UI displays the latest 100 matching samples.

## HTTP settings at workspace, collection, and request levels

Open **Settings → Requests** for workspace defaults. Use the gear beside a collection to edit its defaults, or open a request's **Settings** tab. The Request/Collection switch changes the scope being edited; **Workspace defaults** opens workspace settings.

Values inherit per field in this order: **app defaults → workspace → collection → folders → request**. Enable **Override** for a request/collection field, edit it, and save. Unchecked fields remain inherited, including explicit false/zero/blank values set by a parent. **Reset overrides** restores inheritance for that scope. Source labels identify inherited fields. Settings are workspace-local, persist with requests/collections, and round-trip through API Workbench backup imports/exports. Collection settings are associated with the collection's name.

Supported settings:

- Total timeout (100–300,000 ms), connection timeout, response headers timeout, and response body idle timeout. Total timeout includes saved-credential lookup and all redirect/download work.
- HTTP/1.1, automatic HTTP/2 negotiation with HTTP/1.1 fallback, and HTTP/2 only. HTTP/2 only requires HTTPS and `h2` ALPN support; HTTP/3 and cleartext HTTP/2 are not supported. Response metadata shows the negotiated HTTP version.
- Follow redirects and maximum redirect count (0–30). Redirects to another origin remain blocked.
- Minimum/maximum TLS version (TLS 1.0–1.3), OpenSSL cipher list, certificate/hostname verification, and optional public PEM CA bundle. A custom CA bundle replaces default trust roots. Runtime security policy still determines whether legacy TLS/ciphers can negotiate. Verification defaults to enabled; turning it off is reflected in the Settings panel and Certificate tab.
- Connection reuse and idle keep-alive timeout, response header size limit (1–1,024 KiB), and decoded body limit (1–500 MiB, default 50 MiB). Response body limits apply after decompression.
- Automatic/IPv4/IPv6 DNS address selection, dual-stack connection attempts, and alternate-address delay (10–10,000 ms). Explicit IP URLs retain their address; dual-stack attempts apply only in Automatic mode.
- Per-origin connection pool limit (0 means unlimited), HTTP/1.1 pipelining depth (default 1), and HTTP/1.1 connection rotation once a connection has served a configurable number of requests (0 disables rotation). The pool limit applies to requests sharing effective settings; disabling reuse creates a separate connection per request. Pipelining requires a compatible server.
- Initial HTTP/2 peer stream limit, before the server advertises its own limit. The server's settings replace this initial value.
- Body integrity header: a hash of the final request body, computed just before sending and before any request signing, so signatures cover it. Presets add `Content-Digest` SHA-256 or SHA-512 (RFC 9530), `Digest` SHA-256 (RFC 3230), `Content-MD5`, or S3's `x-amz-checksum-sha256` / `x-amz-checksum-sha1`. **Custom** sends a header you name with one of CRC-32, CRC-32C, SHA-1, SHA-256, SHA-512, MD5, XXHash64, XXHash3, or XXHash128, written as Base64 of the checksum bytes (as S3 expects, for example `x-amz-checksum-crc32c`) or lowercase hex. Multipart bodies are hashed as encoded, boundary included. Requests without a body send no integrity header, a header the request sets itself is left as is, and a redirect that drops the body drops the header too. The custom name must be a valid header name and cannot be a header that frames or authorizes the request, such as `Host`, `Content-Length`, or `Authorization`.

Connection pools are separated by effective settings, including verification, protocol range, ciphers, and CA bundle, so a verified request cannot reuse an unverified connection. Runner requests snapshot the same inherited settings. Browser preview requires Electron for custom transport settings. These API request settings do not change the HTTPS verification of external secret-provider or OAuth token endpoints.

## Credentials and OAuth

Open **Credentials → Add credential** to create a Bearer token, Basic credential, API key header, or OAuth 2.0 profile. Set an **Allowed API origin**, such as `https://api.example.com`. Credentials are restricted to that exact scheme, host, and port. Then choose **Saved credential** or **OAuth 2.0** in the request's **Auth** tab and select the profile.

The keychain is first accessed when you open **Credentials**, after that screen is displayed. Startup and other workspace screens do not unlock the vault. After restarting the app, open **Credentials** before sending requests that use saved credentials. macOS controls whether an authorization dialog is needed.

When a request, live connection, or run needs the locked vault, its error offers **Unlock vault** (with **and resend**, **and connect**, or **and run again** where that applies) and **Open Credentials**, so you can unlock where you are; the Auth tab's saved-credential picker offers the same. If the system keychain refuses access, the error says so and offers **Try again**, as does the Credentials screen. If OS encryption is unavailable (for example, the keychain is locked, or on Linux no keyring service such as GNOME Keyring or KWallet is running), the error and the Credentials screen offer **Restart app** instead: unlock the keychain or start the keyring, then restart. API Workbench saves the workspace before it relaunches. No secrets are ever saved as plain text.

In **Add credential → Secret source**, choose the local vault or an external provider. Select the API authentication type independently: a remote value can supply a Bearer token, API key, Basic password, or OAuth client secret. Basic usernames remain configurable in the profile. For OAuth, use Basic or body client authentication; Connect/Refresh reads the client secret from the provider before exchanging tokens.

| Secret source                       | Supported authentication and lookup                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS Secrets Manager                 | Default SDK credential chain, shared AWS profiles, or access keys with optional session token; region, name/ARN, optional version stage; UTF-8 string/binary secrets.                                          |
| AWS Systems Manager Parameter Store | Same AWS authentication; reads with decryption enabled.                                                                                                                                                        |
| Azure Key Vault                     | Public-cloud Entra client credentials or an existing vault access token; vault URL, secret name, optional version.                                                                                             |
| HashiCorp Vault / OpenBao           | Token or AppRole; KV v1/v2, custom mount, optional namespace and KV v2 version.                                                                                                                                |
| SAP BTP Credential Store            | Basic-auth service key username/password plus `encryption.client_private_key`; namespace, name, password/key type; decrypts RSA-OAEP-256/A256GCM JWE responses. Key values retain their base64 representation. |
| Google Cloud Secret Manager         | Application Default Credentials, public-cloud service account JSON, or an existing access token; project, secret, version (`latest` by default).                                                               |

For structured secrets, set **JSON Pointer to secret value** to a string field such as `/api_key` or `/credentials/password`. Vault KV responses require a field pointer because their secret data is an object. Leave it blank for plain string values. JSON Pointer supports `~1` for `/` and `~0` for `~` in property names.

Save the profile and use **Test access** to verify authentication, read permission, and field selection without displaying the value. Source filtering and last-check status are available on the Credentials page. In a request's Auth tab, choose **Saved credential** (or **OAuth 2.0**) and select the profile. Existing access tokens must be replaced manually when they expire; app/service-account and SDK flows obtain tokens when used. AWS profiles/Google ADC must already be configured outside the app; this UI does not perform cloud SSO or MFA login.

Provider authentication is stored in the workspace's encrypted vault and excluded from workspace backups, code generation, and credential metadata. Blank authentication fields on edit retain stored values for the same provider and authentication mode. Changing providers or modes requires the new authentication fields. Remote secret values are fetched on each use in the main process and are not persisted or cached; high-concurrency benchmarks therefore also make provider calls. Requests check the allowed API origin before a lookup. Provider HTTP redirects are rejected, TLS verification stays enabled, and provider endpoints require HTTPS (HTTP is allowed on localhost for development). Reading remote credentials does not create or modify secrets in the provider. Credential lookups have a 30-second timeout and follow request cancellation; failures omit provider response bodies and sensitive SDK messages.

Provider API references: [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-javascript.html), [AWS Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html), [Azure Key Vault](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secret/get-secret), [Vault KV v2](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2), [SAP Credential Store encryption](https://help.sap.com/docs/credential-store/sap-credential-store/encrypting-payloads), and [Google Secret Manager](https://docs.cloud.google.com/secret-manager/docs/create-secret-quickstart).

Saved credentials and OAuth tokens are encrypted using Electron `safeStorage` in a separate `credentials.enc` file. Secrets and tokens remain in the main process; the renderer receives metadata. The vault refuses to save when OS-backed encryption is unavailable, including Linux's `basic_text` fallback. Unlock/configure your system keychain if the vault is unavailable.

OAuth supports:

- Authorization code with PKCE S256, random state validation, and login in the system browser.
- A loopback callback at `http://127.0.0.1:43821/oauth/callback`; configure the port in the profile and register the matching redirect URI with your provider.
- Client credentials for service accounts.
- Public clients, HTTP Basic client authentication, or client secrets in form bodies.
- Scopes, optional audience, token expiry, explicit refresh, reconnect, cancellation, and local disconnect.
- **Discover** fills a profile or request-level OAuth 2.0 from an API URL (protected resource metadata, RFC 9728, or its `401` `resource_metadata` challenge), an issuer (RFC 8414 or OpenID Connect discovery), or a `/.well-known/` URL. Documents must use HTTPS (HTTP on localhost), are fetched without redirects, and must name the identifier they were fetched for; Microsoft's multi-tenant `{tenantid}` issuers are accepted for the matching endpoint.
- An optional **Resource** (RFC 8707 resource indicator) is sent with authorization, token, and refresh requests.

Use **Connect** to acquire a token. Authorization code flows wait up to three minutes; token endpoint calls time out after 30 seconds. Use **Refresh** when a refresh token is available, or **Reconnect** to acquire a new token. Expired tokens are blocked until refreshed. Provider support for grants, loopback redirects, and refresh token issuance varies. Local disconnect removes saved tokens; it does not revoke authorization at the provider. This is an OAuth API client, not an OIDC identity-token validator.

OAuth endpoints require HTTPS; HTTP is allowed only for loopback development endpoints. Token endpoint redirects are rejected. API requests follow at most 10 same-origin redirects when enabled; cross-origin redirects are blocked to protect credentials and request bodies.

### Client certificates (mutual TLS)

Add a client certificate in **Credentials → Add credential → Client certificate**. Enter the host it is for (`api.example.com` or a `*.example.com` wildcard) and optionally a port, then choose a PEM certificate and private key or a PFX/P12 bundle, with its passphrase if it has one. When you save, the main process reads the files once, checks that the key matches the certificate and that the passphrase is correct, and copies the certificate, key or bundle, and passphrase into the encrypted vault. The files are not read again, so choose new files in the credential to renew a certificate.

Certificates are presented automatically to matching hosts over HTTPS, `wss://`, HTTPS streams, and TLS gRPC; the most specific match wins (exact host over wildcard, a specific port over any port). The workspace keeps only what matching needs—host, port, on/off, the credential reference, and the certificate's subject and expiry—so requests can find their certificate while the vault is locked. Sending one needs the vault unlocked: open **Credentials** first, as for saved credentials; a locked vault fails the request with that instruction rather than sending it without the certificate. The main process loads the certificate from the vault and checks it against the request's host and port before using it. Turn a certificate off from its switch in Credentials or **Settings → Certificates**. Client certificates cannot be chosen as a request's **Saved credential** authorization.

Certificates saved by file path in **Settings** by earlier versions keep working from their files, and move into the vault the first time you open **Credentials**; any that cannot be read stay as they were and are reported. CA certificates remain in **Settings → Certificates** and the HTTP settings, as they are public trust anchors.

## Settings

- **General:** workspace name and the default Accept header for new requests.
- **Requests:** workspace HTTP/TLS defaults, total/phase timeouts, protocol negotiation, redirect/size limits, connection reuse, runner delay, and stop on failure.
- **Appearance:** theme, density, response font size, and line wrapping.
- **Privacy:** history recording/retention, response persistence, and clear history.
- **Certificates:** client certificates in use (managed in Credentials) and the CA certificates this workspace trusts.
- **Data:** import previews and export format/scope selection for collections, specifications, SOAP services, and ZIP archives.
- **Shortcuts:** Command/Ctrl+Enter sends, Command/Ctrl+N creates a request, Command/Ctrl+S saves, Command/Ctrl+K filters collections, Escape closes a credential dialog.

Settings and collections save locally in Electron's user data directory with serialized, atomic writes. Existing workspaces migrate automatically. A workspace read error blocks new writes to preserve the existing file.

Inline authentication and environment values are stored as plain text in the workspace file. Prefer the vault for secrets. Exports exclude vault data, credential references, response bodies, history, inline tokens/passwords, and recognized sensitive header/variable names. Review arbitrary URLs, bodies, and custom variable names before sharing; automatic redaction cannot identify every embedded secret.

## Interceptor

**Interceptor** runs a capture proxy on `127.0.0.1` (port 8899 by default) so you can see what a browser, mobile simulator, CLI, or other app sends. Point the app's HTTP and HTTPS proxy at it; each request appears with its headers, body, status, size, and time. Search and filter by HTTP, HTTPS, tunnels, or errors, export what is shown as HAR 1.2, or save captures as requests in the **Intercepted** collection (per-connection headers such as `Host` and `Content-Length` are dropped).

- **HTTPS decryption** (on by default) uses a local certificate authority created the first time you start. Apps must trust it: **Trust certificate** adds it to your user trust store on macOS (Keychain asks to confirm) and Windows (a security prompt asks to confirm); on Linux, or for apps with their own store such as Firefox, Node.js (`NODE_EXTRA_CA_CERTS`), or cURL (`--cacert`), use **Save certificate…**. The CA's private key is encrypted with the same OS-backed encryption as the credential vault; without it HTTPS passes through undecrypted. **New certificate** replaces the CA, first removing the old one from the user trust store if **Trust certificate** added it (declining keeps the old CA); remove it yourself from other stores.
- With decryption off, or for a client that does not trust the CA, HTTPS is passed through as a tunnel: only the host and byte counts are recorded, and a client that rejects the certificate is reported as an error.
- Captures are kept in memory for the session (the most recent 1,000; up to 1 MB of each body), are never written to the workspace unless you save them, and **Record** can be turned off to forward without recording. Only this device can connect. WebSocket upgrades are relayed; their messages are not recorded.

## Proxy settings

Open **Settings → Requests → Proxy** for workspace defaults. Open a collection’s gear → **Settings → Collection**, or a request’s **Settings → Request**, to override them. Live WebSocket, SSE, NDJSON, and gRPC Settings also expose the same scoped proxy controls. Settings inherit per field in **Workspace → Collection → Request** order. **Direct connection** explicitly disables an inherited proxy; **Reset overrides** restores inheritance. Resetting proxy controls on a live request preserves its session timeout.

Choose **HTTP(S) proxy**, enter `http://localhost:8080` or an HTTPS proxy URL, and optionally configure Basic proxy authentication. The bypass list accepts comma-separated hostnames, domain suffixes, optional ports, and bracketed IPv6 literals, for example `localhost, 127.0.0.1, .internal.example, [::1]:8080`. Domain rules match the domain and its subdomains, never unrelated suffixes; `*` bypasses all hosts. CIDR blocks and SOCKS proxies are not supported.

HTTP/GraphQL, SSE, NDJSON, and WebSocket connections use HTTP or HTTPS proxies. HTTPS requests retain origin certificate validation and HTTP/2 negotiation through CONNECT tunnels. Proxy connections use the configured TLS trust/verification options. gRPC supports HTTP CONNECT proxies (with optional Basic authentication); selecting an HTTPS proxy endpoint for gRPC returns an explicit error. Direct connections and bypass matches do not use application proxy credentials or mutate process-wide proxy settings. Failed proxies never fall back to direct connections.

Proxy usernames/passwords are stored locally with settings, like inline request authentication. Workspace, collection, request, and documentation exports retain proxy routing settings while excluding proxy credentials. Proxy authentication is configured separately from destination authentication and is never added as a destination request header. Custom proxy routing requires the desktop app; browser preview cannot select a proxy.

## Assertions

One assertion per line:

```text
status 200
response-time < 3000
body-contains example
```

The Tests tab opens a **Visual builder** with named test cases, check/target/comparison/value fields, typed JSON values, inline validation, and a live assertion preview. Edit, enable/disable, duplicate, reorder, or delete case cards. **Text** mode retains the category/example picker with 37 ready-to-edit assertions. Both modes include **Add basic suite** and **Run tests** for the latest captured response. Sending requests and running collections execute the same assertions. Pretty results show pass/fail, source line, and actual-value diagnostics; Raw results include the same details as JSON.

Supported checks include:

```text
// Status, performance, and size
status between 200 299
status in 200, 201, 204
response-time < 3000
response-size <= 1048576

// Headers and body
header-exists content-type
header-not-exists x-powered-by
header content-type contains application/json
content-type application/json
header etag matches /^"[\w-]+"$/
body-not-contains error
body starts-with "{"
body contains-ignore-case "success"
body-length between 1 10000
body-not-empty

// JSON paths and typed values
json-valid
json-exists $.data.id
json $.active equals true
json $.count >= 1
json-type $.items array
json-length $.items > 0
json $["field.name"] equals "value"
json $.count between 1 100
json $.status in ["active", "pending"]
json $.email matches /@example\.com$/i
json $.tags contains "admin"
json-schema {"type": "object", "required": ["id"]}
```

Numeric checks support `==`, `!=`, `<`, `<=`, `>`, `>=`, and inclusive `between min max`. Headers, cookies (`cookie <name> <comparison> <text>`), the body (`body <comparison> <text>`), and JSON strings support `equals`, `not-equals`, `contains`, `not-contains`, `starts-with`, `not-starts-with`, `ends-with`, `not-ends-with`, `equals-ignore-case`, `contains-ignore-case`, `matches`, and `not-matches`; headers, cookies, and JSON values also take the format checks `is-uuid`, `is-email`, `is-url`, `is-date` (calendar-valid ISO 8601), `is-number`, `is-integer`, `is-empty`, and `is-not-empty`, with no argument; JSON arrays take `contains-all` / `contains-any` with a JSON array, and `is-unique`, `is-sorted`, `is-sorted-desc`; `cookie-exists` / `cookie-not-exists` check the cookies the response set; `timing <phase>` compares a network phase in ms and `certificate-days-left` the days until the certificate expires, with the numeric comparisons; patterns are regular expressions written `/pattern/flags`, and one that could take exponential time to match — a repeated group holding another repeat, a lookaround, or alternatives that can match the same text, or a back-reference — is refused with the reason ([Tests](tests.md)). `status not-in` excludes codes, `json <path> in` / `not-in` compare against a JSON array of values, and `contains` / `not-contains` on a JSON array check for an equal element. `body-length` counts characters. `json-schema [path] {schema}` validates the body, or a value in it, against a JSON Schema and lists each problem with its path. JSON equality uses JSON literals and strict types; objects compare structurally. Paths support dot notation, array indices, and double-quoted bracket keys. Blank lines and comments beginning with `//` or `#` are ignored. Unrecognized assertions and invalid JSON/path syntax fail with an explanation. For logic beyond assertions, see [Request scripts](#request-scripts).

## Request scripts

A request's `scripts.pre` and `scripts.post` are JavaScript, saved as text in its YAML file. They run in QuickJS (`quickjs-emscripten`, WebAssembly) — in the desktop app inside an Electron utility process started by the main process, and in the command line in its own process — with a fresh engine per script. The engine has no `require`, `process`, `fetch`, timers, or file access; the request, response, and variables are copied in as JSON, and results are copied out and checked (types, counts, and lengths) before use. Hashing, HMAC, random bytes, UUIDs, and Base64 are provided by the host through a single text-in, text-out function. Limits: 2 seconds of run time (the app also kills a utility process that has not answered 3 seconds later), 64 MB of memory, a 1 MB stack, 256 KB of source, 200 console lines of up to 10,000 characters, 1,000 tests, and 1,000 variable changes.

Scripts also exist for the workspace (`workspaceScripts`, saved in `workspace.json`, the shared file in team workspaces) and per collection and folder (`collectionScripts`, keyed by folder path, saved in `_collection.yaml` / `_folder.yaml` under `scripts`). Each phase runs workspace → collection → folders (outermost first) → request; each script receives the variables and, before sending, the request as earlier scripts left them. Pre-request scripts stop at the first failure; post-response scripts all run. Results are labelled with the folder path (`Shop / Orders · Post-response script`). Folder scripts follow folder renames, moves, duplication, scoped export, and deletion. Workspace scripts are kept by whole-workspace exports, left out of collection exports, and imported only into a workspace without its own.

Library: `scriptLibrary` is a list of modules (`name`, `source`), saved as `scripts/<name>.js` (names match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, at most 100 modules of up to 256 KB). Each allowed module is defined in the engine as a CommonJS-style factory `(module, exports, require)` and runs on its first `aw.require(name)` in a script, after which its exports are cached for that script; a cycle returns the partial exports. Modules whose fingerprint is not allowed are passed in by name only; requiring one stops the script as paused. Logging: `aw.log`, `aw.info`, `aw.warn`, and `aw.error` write console lines at their level; scripts have no `console` object, so `console.log` fails with `ReferenceError: 'console' is not defined (line N). Write to the console with aw.log, aw.info, aw.warn, or aw.error.`

Saved snippets: `scriptSnippets` holds up to 200 snippets (`id`, `title` up to 80 characters, optional `description` up to 200, `places` from `pre`, `post`, `module`, and `code` up to 64 KB) in `workspace.json`, the shared file in team workspaces. Snippets that fail these rules are dropped when read. The panel lists them first, under **My snippets**, filtered by place and search; inserting one is an edit like typing.

Order of a send: pre-request scripts → payload preparation (variables, auth, saved credentials) → send → assertions → cookies → captures → post-response script. Pre-request changes to `url`, `method`, `headers`, and `body` (raw bodies only) apply to a copy of the request; the URL's query string replaces the Params table of that copy. `aw.vars.set` writes the active environment (the run's environment in collection runs, or a run-local set on the command line without `-e`) and enables the variable; `unset` removes it. A failed pre-request script stops the send with `Pre-request script failed: <message> (line N)`. When pre-request scripts ran, the resolved URL's origin (scheme, host, and port) after them must equal the origin before them; otherwise the send stops with `A pre-request script changed where this request is sent, from <origin> to <origin>…`, whether the URL was assigned or changed through a variable. A URL whose host is still an unresolved `{{variable}}` is left to the request's own validation. A post-response script runs only when a response arrived; its `aw.test` results join the request's test results, and a thrown error adds a failed `Post-response script error` result. Collection runs run scripts with each iteration's data row readable through `aw.vars`; benchmark and performance runs do not run scripts.

Trust: the main process stores SHA-256 fingerprints of allowed scripts in `script-trust.json` in the user data folder (at most 20,000, oldest dropped). An edit in the app allows the new text when the previous text was allowed or blank; **Allow scripts** allows every paused script in the request's collection — requests', folders', the collection's own, and the workspace's — after confirmation. The main process refuses to run a script whose fingerprint is not allowed, returning it as paused. The command line requires `--allow-scripts` or `--skip-scripts` when a selected request has scripts, and has no allow list.

## Request tags

A request's `tags` is a list of up to 20 labels, each up to 40 characters: a letter or digit, then letters, digits, `_`, `-`, `.`, `:`, or `/`. Collections and folders have tags too (`collectionTags`, keyed by folder path, saved in `_collection.yaml` / `_folder.yaml` under `tags`); a request's effective tags are its collection's and folders' (outermost first) followed by its own, each once. Search, runs, the command line, and `list` use the effective tags; `request show` lists inherited ones with their folder. Folder tags follow renames, moves, duplication, scoped export, and deletion. Tags compare without case, and each request keeps its own spelling; invalid or repeated tags in a hand-edited file are dropped when it is read. The explorer search matches tags, and `#tag` matches one exactly. The explorer's **Tags** bar is a tag filter like a run's — include, exclude, any or all — applied together with the search for the session; it lists the first six tags until **More** is clicked, keeping chosen ones in view, and drops tags no request has any more. A run's tag filter has tags to include (any or all of them) and tags to exclude; an excluded tag wins, and with only exclusions, untagged requests run. In the app the filter applies with the request checkboxes and resets when the collection changes; the run's metadata and JSON report record it in words. On the command line, `--tag`/`-t` (repeatable, comma-separated), `--all-tags`, and `--exclude-tag` apply after `-c` and `-r`; a tag none of the chosen requests has is a usage error (exit code 2).

## Source layout

```text
packages/api-workbench-app/        Renderer: Vue 3 components, Pinia stores, HTML, Tailwind CSS, assets
  src/editor/                      CodeMirror 6 runtime, bundled separately by esbuild
packages/api-workbench-electron/   Main process: HTTP (undici), live protocols, vault, OAuth, Interceptor, preload
packages/api-workbench-common/     Code both use: types, assertions, captures, collection formats, HTTP settings
packages/api-workbench-assets/     Native application icons for packaging
scripts/                           Asset copier, website build, and the desktop UI smoke checks
tests/                             Application-level tests across packages; unit specs live beside each package's code
dist/                              Generated build output (ignored)
```

## Scope

Provider token revocation is not implemented. Collection imports preserve supported folders, methods, URLs, body modes, variables, and authentication templates. Scripts written for other tools (Postman's `pm`, Insomnia, Bruno, Hoppscotch) are neither imported nor run, and are not translated into assertions; API Workbench's own [request scripts](#request-scripts) are kept by its own export format. Multiple local workspaces are supported; it does not provide enterprise SSO, organization roles, or cloud synchronization.

### Parameters, headers, and specifications

The Params and Headers tables include editable descriptions and append a blank row as soon as you type, without moving the cursor. Descriptions persist in workspace backups and are not sent with requests.

Choose **Bulk edit** to enter one `Key: Value` per line. Values can contain colons; prefix disabled rows with `// `. Apply validates the entire draft before replacing rows; Cancel discards the draft. Descriptions are retained by matching keys in occurrence order, including duplicate keys. Multiline values and keys containing colons use the table editor.

Use **Import** in Collections or **Import specification** in Documentation to select Swagger 2.0 or OpenAPI 3.x JSON/YAML. Operations become requests grouped by tag (or API title), with server URLs, query/header descriptions, required flags, defaults/examples, path placeholders, and example bodies. Relative servers retain their relative URL; configure a complete base URL before sending. Missing servers use `{{base_url}}`. Local parameter/body/schema references are resolved. File references resolve from the selected folder or ZIP; remote references are never fetched. Basic/bearer/API-key security templates, form fields, and schema-generated body examples are imported. Review authentication, generated examples, and advanced parameter serialization before sending.

### Request bodies and header suggestions

The Body tab supports None, form-data, x-www-form-urlencoded, Raw, and Binary. Raw formats include JSON, text, XML, HTML, JavaScript, GraphQL, CSV, YAML, JSON:API, NDJSON, and custom MIME types. An enabled Content-Type header takes precedence; choosing a raw format updates an existing Content-Type row. URL-encoded forms use the correct content type, and multipart boundaries are generated automatically. GET and HEAD requests omit body data.

Form-data supports Text/File fields and duplicate keys. Binary sends the selected file bytes directly. File uploads require Electron and allow up to 20 MB per file. File contents remain in memory and are excluded from saved workspaces and backups; reselect files after restarting. Raw text and form field configuration are saved. The Code panel generates upload commands for cURL and shows file-content placeholders for other adapters.

Headers and Params use searchable, theme-aware dropdowns with keyboard navigation. Headers offer more than 50 names; common parameters include descriptions and contextual values. Value suggestions include environment variable references without exposing their contents. Names and values remain freely editable, and bulk editing remains available.

### Multi-language code generation

Click **Code** on a request to open the local generator. Choose from 26 language/tool groups and 52 library adapters, preview the code, copy it, or download a file with the correct extension. This uses HTTPSnippet plus application adapters for C++, Perl, Ansible, Terraform, CMD, TypeScript, and additional Node clients.

| Language / tool         | Libraries / clients                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| Go                      | net/http                                                                       |
| Java                    | java.net.http, OkHttp, Unirest, AsyncHttp                                      |
| C / C++                 | libcurl, CPR (C++)                                                             |
| Python                  | http.client, Requests                                                          |
| Perl                    | HTTP::Tiny, LWP::UserAgent                                                     |
| Ruby                    | Net::HTTP, Faraday                                                             |
| Shell                   | cURL, Wget, HTTPie                                                             |
| PowerShell / CMD        | Invoke-WebRequest, Invoke-RestMethod, curl.exe through PowerShell              |
| JavaScript / TypeScript | Fetch, Axios; JavaScript also jQuery and XHR                                   |
| Node.js                 | HTTP, Request, Unirest, Axios, node-fetch, Native Fetch, Got, Undici           |
| C# / .NET               | HttpClient, RestSharp                                                          |
| PHP                     | cURL, Guzzle, HTTP v1/v2                                                       |
| Kotlin                  | OkHttp                                                                         |
| Ansible / Terraform     | uri; HTTP provider or terraform_data + cURL                                    |
| More                    | Rust/Reqwest, Swift/NSURLSession, Objective-C, R/httr, Clojure, OCaml, Crystal |

The generator uses the active environment, enabled parameters/headers/fields, and current body mode. Redaction is enabled by default for recognized auth headers, secret query/form fields, and JSON properties. Raw non-JSON data remains unchanged; review it before sharing. Saved credentials always use placeholders, without unlocking or reading the credential vault. No snippet is executed by the application.

cURL generates multipart and binary file arguments using selected filenames. Other adapters represent multipart bodies explicitly and show clearly marked file/binary content placeholders when needed. Configure file reads before running those examples. Library setup and adapter limitations appear below the preview. Terraform's HTTP provider supports GET/HEAD/POST; its cURL adapter supports other methods and requires a POSIX shell. CMD snippets require Windows PowerShell and curl.exe and are subject to Windows command-line length limits. Clients use their own timeout/redirect defaults. These are request snippets; some require a surrounding application or installed dependencies.

### Request panels and console

Each collection has a **⋯** menu (New request here, Rename, Duplicate, Run in Runner, Export, Collection settings, Delete), and **New collection** in the explorer starts one. Drag requests onto another collection or between requests to move or reorder them, or use a request's **⋯** menu or Alt+↑/↓; moves between collections can be undone from their notification. Request tabs that do not fit scroll with arrows and the mouse wheel, keep the active tab in view, and show a **+N** count that opens the tab list. Press **?** for a searchable keyboard shortcuts sheet. Double-click a request or collection in Collections, or focus it and press **F2**, to rename it inline. **Enter** or leaving the field saves the name; **Escape** cancels. Existing request contents remain available in the editor. Renaming a collection moves its requests, collection HTTP settings, default authentication, and runner baselines to the new name; a name another collection already uses is refused, and the typed name stays in the field to correct.

The request page toolbar toggles Request, Response, Code, and Console panels. The request heading’s **Code** button also toggles the docked Code panel. Choose **Stacked** or **Side by side** from the layout icon before Local workspace in the status bar, then drag the divider to resize the request/response split. Code always appears on the right, independently of the request/response layout. The divider also supports arrow keys and Home/End. At least one of Request or Response remains visible. The Code panel updates after request edits and request switches, with language/library, redaction, copy, and download controls. In narrow workspaces, Code stays on the right and uses at most 40% of the available width. Panel visibility, layout, and split size are retained for the current session.

Console records request start, completion, HTTP errors, cancellation/preparation/network failures, timing, byte counts, and assertion summaries. Filter by current/all requests, level, or text; copy matching events or clear the current request/all requests. Logs are held in memory, capped at 300 entries, and excluded from saved workspaces and backups. Query values are redacted; bodies, header values, and file contents are not included. This is a request activity console, without JavaScript evaluation or detailed DNS/TCP/TLS traces.

### Source editors and formatting

Raw request bodies and response bodies use locally bundled CodeMirror editors. They provide syntax highlighting, line numbers, folding, bracket matching, search (Ctrl/Cmd+F), undo/redo, and two-space indentation. **Shift+Alt+F** formats the current editor. Response bodies are read-only. Word wrapping and font size follow Appearance settings. Press Escape to leave the editor before tabbing to other controls.

The request Content type controls the sent MIME type. Its separate Language selector supports automatic detection or a manual highlighting/formatting override. Responses also provide Auto detect and manual languages, including vendor JSON and XML MIME types. Highlighting covers JSON/JSONC, JavaScript, TypeScript, XML, HTML, CSS/SCSS, YAML, GraphQL, Markdown, NDJSON, SQL, Python, and shell scripts; CSV and plain text remain available.

**Format** supports JSON/JSONC, JavaScript, TypeScript, XML, HTML (including embedded CSS/JavaScript), CSS/SCSS, YAML, GraphQL, Markdown, and NDJSON. Strict JSON uses two-space indentation with consistently expanded non-empty objects and arrays, preserving numeric literals beyond JavaScript's safe integer range. NDJSON keeps one record per line. XML documents with mixed text/element content preserve significant whitespace. Unsupported formatters are disabled, rather than rewriting SQL, Python, shell, CSV, or plain text using an unrelated parser. Format operations support text up to 2 MB.

Pretty responses format supported languages automatically. On the Body tab, **Raw**, Copy response, and Download response preserve the original payload. Invalid source stays intact and displays an error; changing the response language affects only its view. HTML/XML/JavaScript are displayed as source and are never executed. Editor assets and formatter plugins are bundled during compilation, with no CDN or relaxed Content Security Policy.

### Pretty and Raw response inspectors

Pretty/Raw also applies to Headers, Tests, and Timeline. Pretty Headers uses a name/value table; Raw Headers shows captured header lines. Header names/values come from the HTTP client's normalized header collection, rather than a byte-for-byte capture of the HTTP exchange. Pretty Tests shows assertion pass/fail rows; Raw Tests exposes a JSON report with totals and individual results. Pretty Timeline shows the available request/response summary; Raw Timeline exposes the same metadata as JSON with explicit duration/size units. Captured DNS/TCP/TLS and transfer phases are included when available.

All Raw inspector views use read-only editors with search, selection, and line numbers. Copy and Download export the active inspector's data (header text, assertion JSON, timeline JSON, or the original response body). Switching views never changes the original response body.

### macOS startup icon

`npm start` / `npm run dev` compile the app and launch a locally branded development bundle on macOS. macOS reads its API Workbench ICNS icon before Electron initializes, preventing the generic Electron Dock icon during startup. The main-process bootstrap also applies the PNG fallback before loading the application modules.

The development bundle is copied into ignored `dist/development/`, rebranded, and ad-hoc signed with Electron's original JIT entitlements preserved. It is cached by Electron version, architecture, and icon content, so normal source edits do not recopy Electron. The installed Electron.app under node_modules and application data are not modified. Packaged releases continue to use electron-builder's macOS icon configuration. Direct `electron .` launches use the runtime fallback; use `npm start` for the branded native startup icon.

`npm run test:ui:branded` runs the disposable-data Electron UI checks through the branded launcher.

### Startup screen and network waterfall

The first document includes a centered app mark and animated circular loader. A small local stylesheet paints it while the workspace and editors initialize; reduced-motion settings stop the rotation. The native window stays hidden until its first rendered frame, avoiding an empty blue window. The loader is removed when workspace initialization completes, without an artificial delay.

New desktop requests capture real transport timings: request preparation, queueing/stalled time, DNS, TCP connection, TLS handshake (HTTPS), request sending, waiting for response headers (TTFB), and content download/decoding. The Timeline tab shows a color-coded waterfall with a shared millisecond axis and separate rows for redirect hops. Reused connections skip setup phases. Raw Timeline JSON and exports contain the same measurements. Failed/cancelled requests keep partial timings; unavailable phases are not estimated. Older responses and browser-preview requests without timing data show a prompt to resend for detailed measurements.

These timings use Node/Undici connection and request events. They resemble the Chrome Network Timing view but are measurements of API Workbench's desktop HTTP client, not Chrome DevTools internals. DNS may be unnecessary for IP addresses; TTFB includes network latency and time until response headers; download time includes decoding. The request console continues to show summary metadata.

Automatic request headers (Accept, Connection, User-Agent, and Accept-Encoding) are sent by default and hidden beneath an eye visibility control in Headers. Explicit enabled headers override these defaults case-insensitively. The expanded list also describes Host and body-related headers managed by the HTTP client.

### Documentation by collection

Documentation includes a collection picker and a Swagger-style expandable reference with saved parameters, headers, authentication, body examples, and links to open requests. Source tabs offer OpenAPI YAML, API Workbench collection JSON, OpenAPI 3.0.3 JSON, and Swagger 2.0 JSON in read-only syntax editors, with Copy and Download for the selected collection. All assets run locally.

Specifications are generated from saved requests, following the [OpenAPI specification](https://spec.openapis.org/oas/v3.0.3.html). Environment variables stay unresolved; common credential fields and JSON body secrets are redacted. Imported response schemas and definitions are not retained or reconstructed by the request importer. Repeated query keys use array examples; alternate requests with the same path and method are retained under `x-workbench-variants`. Swagger 2.0 uses a single root server, while OpenAPI keeps per-operation servers.

### Request tab menu

The three-dot button after the tab plus button opens tab actions and recent history. Close the active tab, other tabs, tabs to either side, or all tabs; navigate Previous/Next; duplicate the current request; or reopen a closed tab. Recently opened and closed lists each show up to eight entries from a locally saved history of twenty. Closing tabs leaves their saved requests in Collections. Command/Ctrl+Shift+T reopens the last closed tab, and middle-click closes a tab. Closing every tab displays Overview.

### Multiple workspaces

Use the workspace button in the top bar to create, switch, rename, or delete workspaces. Each workspace has separate requests/collections, environments, tabs and recent-tab history, request history, preferences, and an encrypted credential vault. A new workspace starts with one blank request and a Development environment. Changes save automatically before switching; active requests and credential operations must finish first. Switching clears temporary uploads, console entries, response formatting caches, and credential metadata. Open Credentials in the selected workspace to unlock that workspace's vault.

Existing installations become the default workspace without moving or rewriting the existing `workspace.json` or `credentials.enc` during initialization. The `workspaces.json` index tracks names and the active workspace. New workspace data lives under `workspaces/<id>/workspace.json` and `workspaces/<id>/credentials.enc` within Electron's user-data directory. Saves carry an explicit workspace ID so an older queued save cannot overwrite the newly selected workspace. Invalid or missing workspace files are reported without creating replacement data. The browser preview uses separate localStorage keys for each workspace and has no credential vault.

Switch to another workspace before deleting the current workspace. Deleting requires confirmation and removes that workspace's stored requests, settings, history, and encrypted credentials. Workspace backup/import continues to operate on the selected workspace.

Visual test cases use the existing request test text as their persisted source. A case name is stored in an immediately preceding `// @case "Name"` comment, and disabled assertions use `// @disabled <assertion>`. These markers survive workspace saves and API Workbench backup/import. Text comments and unrecognized/custom assertions are preserved when switching modes; custom lines appear as editable Custom assertion cases. Disabled cases are excluded from request and collection-run execution. Response results show the case name alongside its assertion and diagnostics.
