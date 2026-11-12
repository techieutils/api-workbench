# AGENTS.md — API Workbench

Instructions for coding agents working in this repository (Codex, Cursor, Copilot, Claude Code, and others). People should start with `CONTRIBUTING.md`. `.github/copilot-instructions.md` summarizes this file for GitHub Copilot; change both together.

## Project

A local-first desktop API client (HTTP, GraphQL, gRPC, WebSocket, SSE, mocks, runner). Electron 45 main process, Vue 3 + Pinia renderer, Tailwind v4, CodeMirror 6, node-pty. npm workspaces, Node 22.19+ (24 in `.nvmrc`).

## Layout

- `packages/api-workbench-electron/src/` — main process: transport (undici), protocols, vault, OAuth, Interceptor, updates, terminals; IPC in `main.ts`, bridge in `preload.ts`.
- `packages/api-workbench-app/src/` — renderer: `components/` (shared controls in `components/ui/`), `stores/`, `styles/`; page shell in `public/index.html`.
- `packages/api-workbench-common/src/` — shared types (`types.ts`, incl. `WorkbenchBridge`) and logic; `request-payload.ts` turns a saved request into what is sent, for both the app and the CLI. Request scripts: `script-engine.ts` (QuickJS runtime and the `aw` API), `script-api.ts` (the `aw` API described for editor suggestions), `script-syntax.ts` (syntax check with acorn).
- `packages/api-workbench-cli/src/` — the `api-workbench` command line: `run`/`list` for CI, and workspace, collection, request, environment, secret, certificate, spec, mock, history, cookie, and team commands (`commands.ts`, `send.ts`, `certificates.ts`, `auth-fields.ts`, `mock-settings.ts`, `workspace-data.ts`, helpers in `command-kit.ts`) that open workspaces through the main process's `WorkspaceStore` (`target.ts`); `run.ts` sends each request, with its client certificate and files (`uploads.ts`: `--binary-file`, `--form-file`, `run --uploads`, and a `.http` file's `< ./path` files); `npm run cli:bundle` builds the single-file release asset, and `npm run cli:package` the npm package published to GitHub Packages; `packages/api-workbench-cli/README.md` documents every command (a test checks it against `--help`).
- `packages/api-workbench-vscode/` — the VS Code extension (unscoped npm name `api-workbench-vscode`, id `techieutils.api-workbench-vscode`): `src/core/` is logic without the VS Code API (CLI engines in `cli.ts` — loaded into VS Code by default, `apiWorkbench.engine: builtIn`, or a process each; the tree model, run reports, each page's view model, `.http` parsing), tested with `node --test`, including against the real CLI (`workbench.spec.ts`); `src/extension.ts` is the VS Code glue (views, commands, CodeLens, mocks), `src/panels.ts` its webviews, and `src/webview/` their script, which renders view models as text, and `styles.css`, their Tailwind CSS stylesheet (the app's token names, VS Code's theme colours), built to `dist/webview.css`; `src/test/host.ts` runs inside a real VS Code (`npm run test:vscode`). It drives the bundled CLI's JSON output, never the app directly.
- `e2e/` Playwright tests of the compiled app (`fixtures.ts` gives each test a fresh data folder; `server.ts` is the local API) · `tests/` cross-package tests, incl. the CLI's npm package · `scripts/` UI smoke suites, screenshots, site build · `docs/` user guides and changelog.
- `.github/workflows/` — `ci.yml`, `codeql.yml`, `pages.yml`, `release.yml` (tag → draft release), `publish-cli.yml` (published release → npm package on GitHub Packages); the release also attaches the VS Code `.vsix`, and CI packages it on every push. `RELEASING.md` is the step-by-step.

Import across packages by name (`@techieutils/api-workbench-common/...`), never by relative path.

## Commands

```sh
npm start                  # compile and open the app
npm run lint               # zero warnings
npm run format:check       # Prettier; npm run format fixes
npm run check              # tsc + vue-tsc
npm test                   # application tests + every package's specs + Vue tests
npm run test:vue           # Vue component and store tests (Vitest, app *.test.ts)
npm run test:e2e           # Playwright end-to-end tests of the desktop app (e2e/)
npm run test:fuzz          # fuzz the parsers of untrusted text (after npm test; FUZZ_SECONDS, FUZZ_SEED)
npm run test:ui -- --only=14            # Electron UI smoke, one part
npm run test:ui:protocols -- --only=grpc
npm run cli -- run <folder or file>       # the command line, from source
npm run cli:package        # the CLI's npm package → packages/api-workbench-cli/dist/npm
npm run vscode:package     # the VS Code extension → packages/api-workbench-vscode/dist/*.vsix
npm run test:vscode        # the extension inside an installed VS Code (VSCODE_EXECUTABLE); VSCODE_TEST_ENGINE=commandLine for the process engine
npm run docs:screenshots   # regenerate docs/images
```

If `node --version` is below 22.19, run a package's compiled specs with Electron's Node: `ELECTRON_RUN_AS_NODE=1 ../../node_modules/.bin/electron --test dist-spec/*.spec.js` from the package folder. The extension's specs use the bundled CLI and the CLI's specs the compiled common package: run `npm --prefix ../api-workbench-cli run bundle` or `npm run compile` first. After any cross-architecture `electron-builder` build, restore node-pty with `npx electron-builder install-app-deps`.

## Rules that must not break

- **Secrets stay in the main process.** Never send a secret, token, or key to the renderer, logs, History, exports, screenshots, or generated code.
- **IPC only through `handle()` in `main.ts`** (checks the sender is the app window's top frame). ESLint bans raw `ipcMain` elsewhere. Validate every argument in main.
- **The renderer cannot run system commands.** No bridge method may execute renderer-supplied commands or code. The terminal is its own page (a view docked over dev tools, or its own window), the only one whose IPC reaches a shell (`electron/terminal-window.ts`); the app window may only place it or stage a command, cleaned again in main. Text typed into the terminal goes through `promptText`; values through `shellQuote`/`shellWord` (`app/src/terminal-input.ts`).
- **Strict CSP:** no inline `<script>`/`<style>` or `style="…"` from markup; desktop renderer has `connect-src 'none'` — network calls happen in main.
- **The workspace is a plain object** (not deeply reactive): mutate, then `render()`/`persist()`; read in-place state with `useRendered()`.
- **Untrusted content is parsed, never run;** response previews never get `allow-scripts`. The one exception is request scripts: they run only in QuickJS (`common/script-engine.ts`), in a utility process in the app, never in the renderer or Node's own context, and only once allowed (`electron/scripts.ts`). Never give the engine new host functions that reach files, the network, processes, or the vault. The script editor's suggestions and syntax check only parse; they must never evaluate script text.
- **The VS Code extension hands secrets and files to the CLI, never to a page.** Tokens, passwords, certificate passphrases, and the vault's password go in the CLI's environment or standard input, never as arguments; pages get names and whether a secret is saved, never values. A file a request sends is chosen with `vscode.window.showOpenDialog` in the extension (or named by a `.http` file), never by a path a webview posts.
- **Change the `aw` API in two places:** `script-engine.ts` and its description in `script-api.ts` (`script-api.spec.ts` runs the engine and fails when they differ). New CLI commands or options go in `packages/api-workbench-cli/README.md` too (`tests/cli-package.test.ts` checks it against `--help`). The CLI's npm package stays dependency-free: everything is bundled. The VS Code extension stays off in untrusted workspaces, and settings that choose what it runs (`nodePath`, `cliPath`, `scripts`, `dataDir`) stay `machine`-scoped; `manifest.spec.ts` checks both, that every command and view is declared and registered, and that webviews keep a nonce-only script policy and render no HTML.
- Packaging config is the `build` key in the root `package.json`; specs check that `appId`, `APP_USER_MODEL_ID`, protocols, and `desktopName` stay in sync.

## Working style

- Match the surrounding code; comments explain why in plain sentences. Reuse `components/ui/` controls.
- Every control works by keyboard, in light and dark themes, and at narrow widths.
- New behaviour gets a test at the right level; a bug fix gets a test that fails without it.
- User-visible changes: update `docs/`, add an entry under **Unreleased** in `docs/changelog.md`, refresh screenshots if the UI changed.
- Before saying a change is done, run lint, format:check, check, and the relevant tests; report failures with their output.
- Keep scratch scripts and screenshots out of the repository (use a temporary folder).
- Commit or push only when asked. Commit subjects are imperative, under ~72 characters, with a body explaining why.

## More detail

- `CONTRIBUTING.md` — full contributor guide, incl. Playwright tips (select boxes, editors, suggestion lists); `RELEASING.md` — releasing the app and publishing the CLI; `docs/reference.md` — exact feature behaviour; `SECURITY.md` — security design and reporting vulnerabilities.
- Task guides in `.claude/skills/*/SKILL.md` — plain Markdown any agent can read:
  - `workbench-develop` — layout, where features live (incl. the script editor and the CLI), adding an IPC channel or a dependency.
  - `workbench-test` — test levels, running suites, writing Playwright e2e tests (selectors, editors, CSP errors) and UI smoke parts.
  - `workbench-docs` — docs pages, changelog, the CLI README, root repository docs, screenshots, site.
  - `workbench-release` — packaging, signing, release workflow, publishing the CLI to GitHub Packages, CI.
  - `workbench-security` — security model (incl. scripts, script editor, CLI, release files) and review checklist.
