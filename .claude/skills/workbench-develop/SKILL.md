---
name: workbench-develop
description: How API Workbench is built and changed — the Electron/Vue monorepo layout, commands, where features live (requests, editor, request scripts and their editor suggestions and syntax checks, the command line), adding an IPC channel or dependency, and the rules the code relies on (CSP, secrets in main, IPC through handle(), plain-object workspace). Use before adding or changing any feature, IPC channel, store, component, setting, editor behaviour, script API, or CLI command in this repository.
---

# Developing API Workbench

API Workbench is a local-first desktop API client: Electron 45 main process, Vue 3 + Pinia renderer, Tailwind v4 styles, CodeMirror 6 editors, node-pty terminal. npm workspaces; Node 22.19+ (24 recommended, `.nvmrc`). Full contributor guide: `CONTRIBUTING.md`; feature behaviour: `docs/reference.md`.

## Layout

| Package                           | What it holds                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-workbench-electron` | Main process: HTTP (undici), live protocols, vault, OAuth, Interceptor, updates, terminals, IPC (`main.ts`), `preload.ts` bridge      |
| `packages/api-workbench-app`      | Renderer: `src/components/` (shared controls in `components/ui/`), `src/stores/` (Pinia), `src/styles/`, `public/index.html`          |
| `packages/api-workbench-common`   | Types (`types.ts`, including `WorkbenchBridge`) and logic shared by the app and the CLI: assertions, captures, formats, scripts       |
| `packages/api-workbench-cli`      | The `api-workbench` command line; opens workspaces through the main process's `WorkspaceStore` (`target.ts`)                          |
| `packages/api-workbench-vscode`   | VS Code extension (npm name `api-workbench-vscode`): logic in `src/core/`, VS Code glue in `src/extension.ts`; drives the bundled CLI |
| `packages/api-workbench-assets`   | Native app icons used for packaging                                                                                                   |
| `e2e/`, `tests/`, `scripts/`      | Playwright tests; cross-package tests; UI smoke suites, screenshots, site build, asset copying (`scripts/copy-assets.ts`)             |

Import across packages by name (`@techieutils/api-workbench-common/script-api`), never by relative path. Each package exports `./*` with a `source` condition: type-checkers, Vite, and the esbuild bundles read the TypeScript source; Node and Electron load the compiled `dist/`, so run `npm run compile` after changing common before running the app or tests.

## Commands

```sh
npm start                 # compile and open the app with your real profile
npm run compile           # build every package without launching
npm run check             # tsc + vue-tsc for every package
npm run lint              # ESLint, zero warnings
npm run format:check      # Prettier (npm run format fixes); Markdown is not covered: npx prettier --write <file>.md
npm test                  # application tests + every package's specs + Vue tests (see workbench-test)
npm run cli -- <command>  # the command line from source
```

If `node --version` is below 22.19, undici fails to load (`createZstdDecompress` / `reading 'bind'`): run Node-side code with `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron <file>`.

## Rules the code relies on

- **Strict CSP** (`public/index.html`): only `'self'` scripts/styles; no inline `<script>`/`<style>` and no `style="…"` from markup — set styles via classes or `element.style.x`. Desktop builds also add `connect-src 'none'` (`src/content-policy.ts`): the renderer cannot fetch; all network goes through the main process. A blocked inline style is logged as an error, which fails every UI and e2e test.
- **Secrets stay in the main process.** The renderer gets metadata only. Never put a secret, token, or key in renderer state, logs, the console, History, exports, or generated code.
- **IPC goes through `handle(channel, listener)` in `main.ts`**, which rejects calls not from the app window's top frame. ESLint forbids `ipcMain.handle/on/once` elsewhere. Adding a channel means: `handle('area:action', …)` in `main.ts` (validating every argument), a method in `preload.ts` (`ipcRenderer.invoke`), and its type on `WorkbenchBridge` in common `types.ts`; the renderer calls `window.workbench.area.action()` from a store. Prefer doing work in the renderer or common when it needs no privileges — the script syntax check, for example, is pure parsing and needs no channel.
- **The workspace is a plain object**, structured-cloned to save and over IPC — not deeply reactive. Mutate, then call `render()`/`persist()`; components reading in-place state use `useRendered()`, not a plain `computed`.
- **Untrusted text is parsed, never run.** Imports, assertions, captures use fixed grammars; previews never get `allow-scripts`. Request scripts are the exception: QuickJS only (`common/script-engine.ts`), in a utility process (`electron/scripts.ts`, `script-worker.ts`), gated by the trust list. The script editor's suggestions and syntax check only read the text.
- **Text typed into a terminal** goes through `src/terminal-input.ts`: `promptText` strips control characters, `shellQuote`/`shellWord` quote values. Never build a shell command by concatenating user data.
- **HTTP in main uses undici's own `fetch`, `Headers`, `FormData`**, never Node's globals.

## Where things live

- **Assertions:** common `assertions.ts`, `test-cases.ts`. **Captures:** common `variables.ts`, `capture-suggestions.ts`; renderer `stores/request-tests.ts`.
- **Sending requests:** common `request-payload.ts` (saved request → what is sent, for the app and the CLI); electron `http.ts`, `http-transport.ts`.
- **Editors:** app `src/editor/runtime.ts` behind `EditorHandle`, used only via `components/SourceEditor.vue`. The runtime is a separate esbuild bundle (`editor-runtime.js`, the global `WorkbenchEditor`, built by `scripts/copy-assets.ts`), so a change to it needs `npm run compile` to show up. CodeMirror's `style-mod` is redirected to `src/editor/style-mod.ts` (adopted stylesheets, for the CSP). Editor options: `completions` (`{{template}}` suggestions), `scriptContext` (script suggestions), `syntax` + `onSyntax` (script syntax check); `SourceEditor` passes them as props and emits `syntax`.
- **Request scripts:**
  - Engine and `aw` API: common `script-engine.ts` (the `PRELUDE`); orchestration and trust in common `scripts.ts`, electron `scripts.ts`; the tab in app `components/editor/RequestScripts.vue`, store `stores/scripts.ts`; snippets in common `script-snippets.ts`.
  - Editor suggestions: common `script-api.ts` (`SCRIPT_API` describes every `aw` member; `scriptCompletions(text, context)` decides what to offer — members after a dot, names in string arguments, keys of the last JSON response). `runtime.ts` turns the result into CodeMirror completions; `RequestScripts.vue` supplies the context (variables, modules, headers, parsed last response).
  - Syntax check: common `script-syntax.ts` (`scriptSyntaxProblem(source, 'script' | 'module')`, acorn at ES2023, modules may `return`); `runtime.ts` adds `@codemirror/lint` and F8; `RequestScripts.vue` shows the status line with **Go to line**.
  - **Changing the `aw` API means changing `script-engine.ts` and `script-api.ts` together** — `script-api.spec.ts` runs the engine and fails when they differ — and adding snippets and docs (`docs/scripts.md`).
- **Command line:** `packages/api-workbench-cli/src/` — `cli.ts` (entry and `--help`), `run.ts`, `commands.ts`, `send.ts`, `workspace-data.ts`, helpers in `command-kit.ts`. A new command or option also goes in `packages/api-workbench-cli/README.md` and `docs/cli.md` (`tests/cli-package.test.ts` checks the README against `--help`). The npm package is the esbuild bundle with no dependencies (`npm run cli:package`).
- **VS Code extension:** `packages/api-workbench-vscode/`. Everything it shows comes from the bundled CLI's JSON (`list --json`, `environment list --json`, `workspace list --json`, `request send --json`, `run --report-json`); exit 0/1 are results, 2 is a usage error (`CliError`, `needsScriptChoice` when scripts need `--allow-scripts`/`--skip-scripts`). Logic without the VS Code API lives in `src/core/` (`cli.ts` runtime discovery and calls, `model.ts` tree, `report.ts` run selection and outcomes, `response.ts`, `files.ts`, `workbench.ts`); `src/extension.ts` is the tree view, Testing controller, commands, and status bar. `-c` and `-r` narrow each other, so partial runs pass request ids (`selectionArgs`); live-protocol requests cannot be run or targeted. A CLI change to that JSON must keep the extension's specs passing. A new command goes in `package.json` `contributes.commands` and `registerCommand` (`manifest.spec.ts` checks both).
- **Settings:** `components/settings/*Settings.vue`; open a section with `openSettings('Privacy')` from `stores/navigation.ts`.
- **Updates:** electron `updates.ts` (`UpdateService`), app `stores/updates.ts`, `components/settings/UpdateSettings.vue`.
- **Web-content hardening:** electron `web-security.ts` (permissions, navigation, `fromAppWindow`).
- **Test-only renderer globals** for the UI smoke suites: app `src/test-globals.ts`.

## Dependencies

- The renderer's libraries (CodeMirror, Vue, …) are bundled, so the app keeps them in `devDependencies`; common's runtime libraries (QuickJS, acorn, yaml, …) are `dependencies`. Add with `npm install <pkg>@^<version> -w <workspace>`.
- Prefer a package already in the lockfile through another one; check `npm ls <pkg>`.
- New dependencies go through the `workbench-security` checklist; the CLI bundle must stay installable with no dependencies.

## Style

Match the surrounding code. Comments explain why in plain sentences. Reuse `components/ui/` controls (buttons, `UiSelect` — icons via `withIcons` in `src/select-options.ts` — tabs, panels) instead of one-off ones. Every control works by keyboard and screen reader, in light and dark themes, and at narrow widths; states never rely on colour alone. Status that a sighted user sees as a mark (an underline, a dot) also needs text a screen reader hears (`role="status"`).

## Before calling a change done

Run lint, format:check, check, and the relevant tests (workbench-test skill); update docs and the changelog for anything a user would notice (workbench-docs skill). Report failures with their output.
