---
name: workbench-test
description: How to test API Workbench — which level a test belongs at, package specs, Vue component tests (Vitest), Playwright end-to-end tests of the desktop app (e2e/, selectors, editors, suggestion lists, CSP errors), application tests including the CLI package, the Electron UI smoke suites (parts, --only, --screenshots, renderer harness), and running specs under Electron's Node. Use when writing or running tests, verifying a change, or a test fails in this repository.
---

# Testing API Workbench

## Which level

| Change                                        | Test goes in                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Logic in one package                          | `*.spec.ts` beside the code, in that package's `src/`                                                       |
| A Vue component or a Pinia store              | `*.test.ts` beside it in app `src/` (Vitest + Vue Test Utils, happy-dom)                                    |
| A flow a person goes through in the app       | `e2e/*.spec.ts` (Playwright driving the compiled Electron app)                                              |
| A flow across packages, or a build output     | `tests/*.test.ts` (e.g. `cli-package.test.ts` checks the npm package)                                       |
| The VS Code extension's logic                 | `packages/api-workbench-vscode/src/core/*.spec.ts` (`node --test`; `workbench.spec.ts` drives the real CLI) |
| The VS Code extension in the editor           | `packages/api-workbench-vscode/src/test/host.ts`, run by `npm run test:vscode`                              |
| Interface behaviour                           | `scripts/ui-smoke/NN-area.ts` (one file per area, shares `harness.ts`)                                      |
| Live protocols (WebSocket, SSE, NDJSON, gRPC) | `scripts/protocol-ui-smoke/NN-*.ts` (local servers in its `harness.ts`)                                     |

A bug fix gets a test that fails without the fix. Logic that must agree with another implementation gets a spec that runs both: `script-api.spec.ts` (editor's `aw` description vs. the engine) and `script-syntax.spec.ts` (acorn vs. QuickJS) are the pattern.

## Running

```sh
npm test                                # compile, application tests, every package's specs, Vue tests
npm run test:vue                        # Vue component and store tests only
npm run test:e2e                        # Playwright end-to-end tests (compiles first; ~14 min)
npm run test:fuzz                       # fuzz parsers of untrusted text (after npm test; ~2 min)
npx playwright test e2e/requests.spec.ts  # one file, after npm run compile
npx playwright test e2e/scripts.spec.ts -g "suggest" --repeat-each=2   # some tests, twice
npm run test:ui                         # Electron UI smoke, all parts
npm run test:ui -- --only=14            # just part 14 (comma-separate several)
npm run test:ui -- --screenshots        # also save PNGs to artifacts/ (gitignored)
npm run test:ui:protocols -- --only=grpc,3
npm run samples:test                    # the examples/protocol-playground servers
```

One package's specs: `npm test -w @techieutils/api-workbench-electron` (or `-app`, `-common`, `-cli`, `-assets`; the extension is `-w api-workbench-vscode`).

**The VS Code extension in a real editor:** `npm run test:vscode` builds the extension and the CLI, makes a team folder and app data with `WorkspaceStore` and a local API, and starts the installed VS Code (`VSCODE_EXECUTABLE`, or `/Applications/Visual Studio Code.app` on macOS) with a fresh profile (trust off, `apiWorkbench.dataDir` set) and `--extensionDevelopmentPath`. `src/test/host.ts` runs inside it through the extension's commands and the small API `activate` returns. Without VS Code it skips, unless `VSCODE_TEST_REQUIRED` is set. It is not part of `npm test` or CI (no VS Code there); run it after changing `src/extension.ts`. To prove a check runs, break one assertion in `dist-spec/test/host.js` once and see it exit 1.

The full e2e and UI suites take over ten minutes: run them in the background and wait for them to finish. Iterate on one spec file or one part. CI runs `npm test` in the check job and `npm run test:e2e` in its own `e2e` job (Linux, under `xvfb-run`, keeping `test-results/` as the `playwright-results` artifact on failure).

**Node older than 22.19** (undici 8 needs it — symptom: `createZstdDecompress` or `reading 'bind'` errors): run the compiled specs and application tests under Electron's Node instead:

```sh
cd packages/api-workbench-common
node ../../node_modules/typescript-build/bin/tsc -p tsconfig.spec.json
ELECTRON_RUN_AS_NODE=1 ../../node_modules/.bin/electron --test "dist-spec/**/*.spec.js"
# application tests, from the root:
node node_modules/typescript-build/bin/tsc -p tsconfig.json
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test dist/tests/*.test.js
```

Playwright needs no browser download; it drives the app's own Electron.

## Writing end-to-end tests (Playwright)

- Use `test` and `expect` from `e2e/fixtures.ts`. Each test gets `window` (the main window) and `app`, with a fresh, empty data folder. The fixture fails any test whose page logs an error. `launchApp(folder, errors)` + `mainWindow(app, errors)` restart on the same data, to test what is kept; `downloadTo(app, file, trigger)` saves a download.
- Call the local API from `e2e/server.ts` (`startServer()` in `beforeAll`: `/users`, `/missing` 404, `/redirect`, `/slow`, `/cookies/set`, others echo; `api.received` lists what arrived). Never the internet. For other protocols, start a server in the spec (`live-protocols.spec.ts` starts a WebSocket/SSE/NDJSON one with `ws`).
- A new workspace has the collections **Getting started** (Get all users, Get a user, Create a user, Update a user, Delete a user), **Posts** (Get all posts), and **GraphQL**, and the environments Development (active) and Production with `base_url`.
- Click and type as a person does (`ControlOrMeta+…` for shortcuts), and assert with `expect(locator)`, which waits.
- **Selectors that work:**
  - `UiSelect` keeps its `id` and `data-*` on a hidden native `<select>`. Open it with `.ui-select:has(#id) [role=combobox]`, then click `[role=option][data-value="…"]`. Method values are `http:GET`, `http:DELETE`, …; protocols `websocket`, `sse`, `ndjson`, …
  - Params and Headers cells show a button until edited: double-click `Edit row N key`, then fill the input labelled `Row N key` (exact), and press Enter. Body fields and environment rows are plain inputs (`Row N key`, `Row N value`).
  - Explorer menus: `getByRole('button', { name: 'Actions for X' })`, then `[data-menu-item=…]` inside `getByRole('menu', { name: 'Actions for X' })`. Right-click menus (Runner requests, table rows, History entries): `click({ button: 'right' })`, then `[data-…-menu] [data-menu-item=…]`. Confirm dialogs: `[data-confirm-dialog] [data-confirm-accept|cancel]`.
  - `#request-name` is contenteditable and saves on blur: `fill()` then `blur()`.
- **Code editors (CodeMirror):**
  - Type with `keyboard.insertText` (no auto-closed brackets) or `keyboard.type` (triggers suggestions; auto-closes `(` and quotes).
  - Delete a selection before typing over it: <kbd>ControlOrMeta+A</kbd>, <kbd>Backspace</kbd>, then type. Inserting over several selected lines lets Chrome put an inline style on the merged line; the CSP blocks it and logs an error, failing the test.
  - A suggestion list ignores keys for 75 ms after it opens: wait for `.cm-tooltip-autocomplete`, then about 150 ms, before Enter, Tab, or an arrow.
  - Syntax errors: `.cm-lintRange-error`, `.cm-lint-marker-error`, `.cm-tooltip-lint`, and the status line `[data-scripts-syntax]` (empty when there is none). The check runs 400 ms after typing stops; `expect` waits for it.
- **Finding a "the app logged no errors" failure:** the fixture prints the message. For a CSP violation, add `document.addEventListener('securitypolicyviolation', …)` in a throwaway spec and log `e.violatedDirective` and `e.target.outerHTML` to see which element did it; violations arrive asynchronously, so separate steps with short waits. Delete the probe afterwards.
- Known flaky: `history.spec.ts` "selecting an entry shows the response it got" has failed once in a full run and passed alone. Re-run before investigating a single failure there.

## Writing UI smoke parts

- Each part is `export default async function name(context: SmokeContext)` and starts from the app as it boots. It must not depend on another part having run. The runner returns to the boot screen (`view`) before each part; anything else a part changes (tabs, dialogs, settings) it should put back, or set up what it needs at its start.
- Drive the renderer with the harness's `run(code)` (executes JS in the window, 10 s timeout) and assert on the DOM. Prefer `data-*` attributes and `data-testid` as selectors.
- Test-only renderer globals come from app `src/test-globals.ts`: store state under familiar names (`state`, `view`, `devTools`, `historyUI`, `updatesStore`, …), `editorView(selector)` (a CodeMirror view), and `setEditorText(selector, text)`. Add a global there when a part needs new state, rather than reaching into Vue internals.
- The app's data folder is a disposable temp dir; the harness counts keychain checks — settings navigation must not touch the keychain.
- The renderer's CSP blocks `fetch` in desktop builds (`connect-src 'none'`), so call local servers from the test's Node side (`fetch` in the part, not in `run(...)`).
- The test window is hidden and can paint late: with `--screenshots`, look at what an image shows, but assert on the DOM.
- Console errors fail the run, except the expected `csp-probe.invalid` probe.

## Writing Vue tests

`mount()` the component; for anything that reads the workspace, start with `workspaceWith([...requests])` from `src/test/workspace.ts`. Query by `data-*` attributes and roles, and change a `UiSelect` through its native `select[data-…]` with a `change` event, as the app does. `src/test/setup.ts` stands in for icon paths and the Popover API.

## Before reporting done

Run `npm run lint`, `npm run format:check`, `npm run check`, the specs of the packages touched, the e2e specs and UI parts covering the area (both suites for live protocols), and the full e2e suite for changes that reach many screens (editor, select boxes, styles). Report failures with their output — say which ones also failed before your change — and never describe an unrun suite as passing.
