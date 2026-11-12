# Contributing to API Workbench

Thanks for helping! Bug reports, fixes, features, and documentation are all welcome. This guide covers how to get set up, how the code is organised, the standards a change meets, and how it gets reviewed and released.

By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities privately, as described in the [security policy](SECURITY.md) — never in a public issue.

## Contents

- [Ways to help](#ways-to-help)
- [Getting help](#getting-help)
- [Set up](#set-up)
- [How the code is organised](#how-the-code-is-organised)
- [Rules the code relies on](#rules-the-code-relies-on)
- [Workflow](#workflow)
- [Engineering standards](#engineering-standards)
- [Definition of done](#definition-of-done)
- [Review and merge](#review-and-merge)
- [Versioning and releases](#versioning-and-releases)
- [Dependencies](#dependencies)
- [Documentation and screenshots](#documentation-and-screenshots)
- [License](#license)

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/techieutils/api-workbench/issues/new?template=bug_report.yml): what you did, what you expected, what happened, and your OS and app version.
- **Suggest a feature** with the [feature request form](https://github.com/techieutils/api-workbench/issues/new?template=feature_request.yml), describing the problem it solves.
- **Improve the docs** in `docs/` — every guide page has an "Edit this page on GitHub" link on the website.
- **Pick up an issue** labelled `good first issue` or `help wanted`, and comment that you are working on it so nobody duplicates the work.

For anything larger than a fix, open an issue first and agree on the approach; it saves rework for everyone.

## Getting help

Ask in the issue you are working on, or open a draft pull request early and ask there — reviewers can then see the code. The [technical reference](docs/reference.md) describes how each feature behaves.

## Set up

You need Node.js 22.19 or later and npm. Node 24 is recommended: it is what Electron 45 runs, and `.nvmrc` names it, so `nvm use` picks it up. The main process's HTTP client (undici 8) does not load on Node before 22.19, so `npm test` needs it too.

```sh
git clone https://github.com/techieutils/api-workbench.git
cd api-workbench
npm install
npm start
```

`npm start` compiles everything and opens the desktop app with your normal user data. The UI tests use a disposable profile instead.

## How the code is organised

| Folder                                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-workbench-electron/src/`     | The main process: HTTP transport, live protocols, the credential vault, OAuth, the Interceptor, and IPC handlers                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/api-workbench-app/src/`          | The renderer: Vue 3 components in `packages/api-workbench-app/src/components/`, Pinia stores in `packages/api-workbench-app/src/stores/`, styles in `packages/api-workbench-app/src/styles/`                                                                                                                                                                                                                                                                                                                              |
| `packages/api-workbench-common/src/`       | Types and logic used by both, such as assertions, collection formats, HTTP settings, and preparing a request to send                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/api-workbench-cli/src/`          | The `api-workbench` command line: runs for CI pipelines, sending requests (with file uploads and client certificates), and commands that manage workspaces, environments, credentials, certificates, specs, and mocks; `npm run cli -- run <source>` runs it from source, `npm run cli:bundle` builds the one-file release asset, and `npm run cli:package` the npm package; its `README.md` must cover every command                                                                                                     |
| `packages/api-workbench-vscode/`           | The VS Code extension, which drives the bundled command line — inside VS Code by default, or as its own process: `src/core/` holds its logic and each page's view model, tested with Node's test runner (some against the real command line); `src/extension.ts` connects it to VS Code; `src/webview/` draws its pages (`main.ts`, with `textContent` only) and styles them with Tailwind CSS (`styles.css`). `npm run test:vscode` runs it inside an installed VS Code, and `npm run vscode:package` builds the `.vsix` |
| `packages/api-workbench-assets/src/icons/` | Native application icons for macOS, Windows, and Linux, used for packaging and the development app                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `e2e/`                                     | Playwright end-to-end tests: each starts the compiled desktop app with an empty data folder and uses it as a person would; `e2e/server.ts` is the local API they call                                                                                                                                                                                                                                                                                                                                                     |
| `tests/`                                   | Application-level tests: the built app fits together, requests flow end to end across packages, and the command line's npm package holds what it should                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/`                                 | Asset copying, the Electron UI test suites, documentation screenshots, and the website build                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/`                                    | The user guides, published to the website                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Import shared code by package name, such as `import type { ApiRequest } from '@techieutils/api-workbench-common/types'`, never by a relative path into another package. Type-checkers and Vite read the common package's TypeScript source; Node and Electron load its compiled `dist/`, which `npm run compile` builds first.

Secrets stay in the main process; the renderer only ever receives metadata. Keep it that way: never send a secret, token, or private key to the renderer, logs, or exports.

### Where common features live

| Feature                                   | Code                                                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test assertions                           | `api-workbench-common/src/assertions.ts` (the language and its checks) and `test-cases.ts` (the visual builder's rules)                                                                                                                      |
| Captures                                  | `api-workbench-common/src/variables.ts` (sources and transforms) and `capture-suggestions.ts` (what a click in a response view captures)                                                                                                     |
| Capturing from response and History views | `api-workbench-app/src/stores/request-tests.ts` (`addCapture`, `captureCookie`) and the shared views in `components/response/`                                                                                                               |
| The source editor                         | `api-workbench-app/src/editor/runtime.ts` (CodeMirror 6, bundled separately) behind `EditorHandle`, used through `components/SourceEditor.vue`                                                                                               |
| Script editor suggestions                 | `api-workbench-common/src/script-api.ts` (a description of the `aw` API, and what to suggest at the cursor); `editor/runtime.ts` turns it into CodeMirror completions                                                                        |
| Script syntax checks                      | `api-workbench-common/src/script-syntax.ts` (parses with acorn, never runs); `editor/runtime.ts` underlines the error and `RequestScripts.vue` names it under the editor                                                                     |
| Sending requests                          | `api-workbench-electron/src/http.ts` and `http-transport.ts` (undici: its own `fetch`, `Headers`, and `FormData`, never Node's globals)                                                                                                      |
| Client certificates                       | `api-workbench-common/src/client-certificates.ts` (matching a host), `api-workbench-electron/src/vault-certificates.ts` (reading and checking them into the vault), and `api-workbench-cli/src/certificates.ts` (the `certificate` commands) |
| File uploads                              | `api-workbench-common/src/request-payload.ts` (`prepareBody`), `api-workbench-cli/src/uploads.ts` (reading files, `run --uploads`), and `run.ts` (a request's files, with their `{{variables}}`)                                             |
| `.http` files                             | `api-workbench-common/src/collection-formats/text-formats.ts` (`httpFile`, and `httpFileReferences` for `< ./path` files); the VS Code extension's `src/core/http-file.ts` (CodeLens lines, file bodies)                                     |
| VS Code pages                             | A view model in `api-workbench-vscode/src/core/` (such as `certificates.ts` or `network.ts`), drawn by `src/webview/main.ts`; the actions a page may post are the fixed list in `src/panels.ts`                                              |

## Rules the code relies on

- **A strict content security policy.** The renderer allows only `'self'` scripts and styles: no inline `<script>` or `<style>`, and no `style` attributes set from markup. Set styles through the CSSOM (`element.style.x = …`) or classes. CodeMirror 6 injects its base theme with a `<style>` element, which the policy blocks, so the editor bundle resolves `style-mod` to `src/editor/style-mod.ts`, which adopts a constructed stylesheet instead.
- **Secrets stay in the main process.** Never send a secret, token, or private key to the renderer, logs, the request console, History, exports, or generated code.
- **The workspace is a plain object.** It is structured-cloned to save and sent over IPC, so it is not deeply reactive. Code mutates it and calls `render()` or `persist()`; components that read state which changes in place use `useRendered()` rather than a plain `computed`.
- **Privacy of saved data.** History keeps responses, console lines, and failures for the session; `persistedWorkspace()` writes them only while **Persist response bodies** is on. Console lines are metadata only and redact query values.
- **Untrusted text is parsed, never run.** Imports, assertions, and captures are parsed by fixed grammars; response previews never get `allow-scripts`. Request scripts are the one exception: they run in QuickJS (`common/src/script-engine.ts`) in an Electron utility process, only after the person allows them (`electron/src/scripts.ts`), and the engine gets no host function that reaches files, the network, processes, or the vault. The script editor's suggestions and syntax check only read the text.
- **The `aw` API is described twice.** `script-engine.ts` builds it and `script-api.ts` describes it for the editor's suggestions. When you add, rename, or remove a member, change both: `script-api.spec.ts` runs the engine and fails when they differ. `script-syntax.spec.ts` does the same for syntax, checking acorn and QuickJS agree on what is an error.
- **The VS Code extension runs only what it ships.** It stays off in untrusted workspaces; settings that choose what it runs (`engine`, `nodePath`, `cliPath`, `scripts`, `dataDir`, `toolsUseSavedCredentials`) are `machine`-scoped; it calls the command line with argument arrays, never a shell. Secrets — tokens, passwords, certificate passphrases, the vault's password — go to the command line in its environment or standard input, never as arguments, and never back to a page. Files a request sends are chosen in VS Code's own dialog, never named by a page. `manifest.spec.ts` checks the manifest and the webviews' content security policy.
- **The command line's README covers every command.** `packages/api-workbench-cli/README.md` is what people read on GitHub Packages; `tests/cli-package.test.ts` fails when a command or option in `api-workbench --help` is missing from it.

## Workflow

1. **Branch** from `main`, named for the change: `fix/history-raw-headers`, `feat/xxhash-integrity`, `docs/captures`.
2. **Commit** in small, focused steps. Write the subject in the imperative and under about 72 characters ("Add collection menus", not "Added collection menus"), then a blank line and a body explaining what changed and why. Reference issues as `Fixes #123`.
3. **Test** as you go (see [Engineering standards](#engineering-standards)), and run the full checks before you push:

   ```sh
   npm run lint
   npm run format:check   # npm run format fixes formatting
   npm run check
   npm test
   npm run test:e2e
   npm run test:ui
   npm run test:ui:protocols
   npm run test:vscode     # for a change to the VS Code extension or the command line;
                           # VSCODE_TEST_ENGINE=commandLine runs it with the command line as its own process
   ```

4. **Open a pull request** using the template: what changed and why, how you tested it, and screenshots for interface changes. Keep it focused — one change per pull request is easier to review. Mark it as a draft until it is ready.

## Engineering standards

**Code**

- TypeScript in strict mode, ESLint with zero warnings, and Prettier formatting — CI enforces all three.
- No high or critical advisories in shipped dependencies: CI runs `npm audit --omit=dev --audit-level=high`. CodeQL scans each pull request, and Dependabot opens weekly update pull requests.
- No secrets in the repository: CI scans the whole git history with [gitleaks](https://github.com/gitleaks/gitleaks). Use made-up values in tests; for a public example that looks like a secret, add `// gitleaks:allow` to its line rather than a broader rule in `.gitleaks.toml`.
- Main-process IPC goes through `handle()` in `main.ts`, which accepts calls only from the app window; ESLint rejects `ipcMain.handle` anywhere else.
- Follow the style of the code around it: names, comments, and structure. Comments say why, in plain sentences.
- Reuse the shared UI pieces in `packages/api-workbench-app/src/components/ui/` (buttons, select boxes, tabs, expansion panels) rather than adding one-off controls.
- Import shared code by package name, never by a relative path into another package.

**Tests**

- Unit tests are `*.spec.ts` files beside the code they test, in that package's `src/`.
- `npm run test:fuzz` (after `npm test`, which builds what it loads) feeds random malformed input to every parser that reads other people's text — `scripts/fuzz/targets.mjs` lists them, `seeds.mjs` holds a valid sample of each — and fails on a crash, a hang, a memory blow-up, or a changed prototype, saving the input in `fuzz-findings/`. CI runs it on every push. `FUZZ_SECONDS=60 npm run test:fuzz -- <target>` fuzzes longer; `FUZZ_SEED` repeats a run; `npm run test:fuzz -- --replay <target> <file>` runs one saved input. A new parser of untrusted text gets a target and a seed; a bug it finds gets a test beside the code.
- Vue components and Pinia stores are tested with [Vitest](https://vitest.dev) and [Vue Test Utils](https://test-utils.vuejs.org) in a browser-like document (happy-dom): `*.test.ts` files beside them in `packages/api-workbench-app/src/`. `npm test` runs them; `npm run test:vue` runs only them, and `npm run test:vue:watch -w @techieutils/api-workbench-app` reruns them as you edit. Use `workspaceWith(...)` from `src/test/workspace.ts` for a store with a small workspace of your own; `src/test/setup.ts` stands in for the page's icon paths and the Popover API, and keeps `render()` from mounting the whole app.
- Flows a person goes through belong in `e2e/`: [Playwright](https://playwright.dev) starts the compiled desktop app with an empty data folder of its own and clicks and types in it (`npm run test:e2e`, or `npx playwright test e2e/requests.spec.ts` after `npm run compile`). Requests go to the local server in `e2e/server.ts`, never the internet. A test fails if the app logs an error. Failures keep a trace and a screenshot in `test-results/`; open a trace with `npx playwright show-trace`.
  - The app's select boxes keep their `id` on a hidden native `<select>`: open one by clicking `.ui-select:has(#id) [role=combobox]`, then the `[role=option][data-value=…]`. Params and Headers cells open for typing with a double-click on their `Edit row N key` button.
  - In a code editor, delete a selection before typing over it (<kbd>Ctrl/⌘ A</kbd>, <kbd>Backspace</kbd>, then type): inserting over several selected lines at once lets Chrome add an inline style, which the content security policy blocks and logs, failing the test.
  - CodeMirror ignores keys for 75 ms after a suggestion list opens; wait for the list and a moment before pressing <kbd>Enter</kbd> or an arrow in it.
- Flows that span packages belong in `tests/`.
- Interface behaviour belongs in `scripts/ui-smoke/` (one file per area, run in order by `scripts/ui-smoke.ts`, sharing `harness.ts`) or, for live protocols, `scripts/protocol-ui-smoke/` (with local WebSocket, SSE, NDJSON, and gRPC servers in its `harness.ts`).
- Each smoke part starts from the app as it boots, so run just the ones you are working on: `npm run test:ui -- --only=14` or `npm run test:ui:protocols -- --only=grpc,3`. A part must not rely on another having run first.
- Inside UI tests, `editorView(selector)` returns a CodeMirror view and `setEditorText(selector, text)` replaces an editor's text. Add `-- --screenshots` to save screenshots in `artifacts/`; the test window is hidden and can paint late, so check what an image shows and assert on the DOM.

**Accessibility and design**

The app works with a keyboard and a screen reader, in light and dark themes, and at narrow widths. New controls need visible focus, labels, and keyboard support (context menus open with Shift+F10 or the menu key too); states never rely on colour alone.

**Documentation**

Update `docs/` when behaviour changes, add an entry under **Unreleased** in [`docs/changelog.md`](docs/changelog.md) for anything a user would notice, and refresh screenshots with `npm run docs:screenshots` when the interface changes.

## Definition of done

A change is ready to merge when:

- [ ] It does one thing, described in the pull request with how it was tested.
- [ ] `npm run lint`, `npm run format:check`, `npm run check`, and `npm test` pass, and CI is green.
- [ ] `npm run test:e2e` and `npm run test:ui` (and `npm run test:ui:protocols` for live protocols) pass.
- [ ] For the VS Code extension, `npm run test:vscode` passes with both engines, and its pages work in light and dark themes.
- [ ] New behaviour has tests at the right level; bugs have a test that fails without the fix.
- [ ] It works by keyboard and in both themes.
- [ ] Docs and the changelog are updated, with screenshots refreshed if the interface changed.
- [ ] No secrets, tokens, or personal data appear in code, tests, fixtures, or screenshots.

## Review and merge

- A maintainer reviews every pull request. Expect questions and suggestions; reply to each, and push fixes as new commits so the review is easy to follow.
- Pull requests are merged once they meet the definition of done and a maintainer approves. Maintainers may squash commits so `main` reads as one change per pull request.
- If a pull request goes quiet for a long time, a maintainer may close it or finish it, crediting you.

## Versioning and releases

API Workbench follows [Semantic Versioning](https://semver.org): a **major** version for changes that break saved workspaces, collections, or documented behaviour; a **minor** version for new features; a **patch** version for fixes.

User-visible changes collect under **Unreleased** in `docs/changelog.md`. To release, a maintainer:

1. Moves the **Unreleased** entries under the new version and date, and sets `version` in `package.json`, `packages/api-workbench-cli/package.json` (a test checks they match), and `packages/api-workbench-vscode/package.json`.
2. Tags the commit `vX.Y.Z` (or `vX.Y.Z-beta.N` for a pre-release) and pushes the tag. The tag must match `version` in `package.json`; the workflow stops otherwise. The [Release workflow](.github/workflows/release.yml) builds every platform and uploads the installers, the command line's `api-workbench-cli.cjs`, and the VS Code extension's `.vsix` to a draft GitHub release, together with the `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` files and `.blockmap`s that installed copies read to find and verify updates. Once every platform has uploaded, the workflow adds `SHA256SUMS`, the checksum of each file in the release, and a signed build provenance attestation for each file; if you add or replace a file in the draft by hand, re-run that job.
3. Checks the draft, adds the changelog entry as its notes, and publishes it. Installed copies are offered the update only once the release is published; mark a beta as a pre-release so only people who chose **Include pre-releases** get it.
4. Publishing the release runs the [Publish the command line workflow](.github/workflows/publish-cli.yml), which publishes `@techieutils/api-workbench-cli` to GitHub Packages (`next` for a pre-release), once it has checked the package holds exactly the release's attested `api-workbench-cli.cjs`.

[RELEASING.md](RELEASING.md) walks through every step, with the commands — from creating and configuring the GitHub repository to checking a published release.

To build locally instead, `npm run dist:all` (or `dist:mac`, `dist:win`, `dist:linux` on each platform) writes the installers to `release/`, and `npm run release` with a `GH_TOKEN` uploads them to a draft release. Never upload installers without their `latest*.yml` files, or installed copies will not see the version.

macOS installs updates only into a signed app. Add the signing and notarization secrets the workflow names (`MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) to update macOS copies; unsigned builds still install from the `.dmg`, but report that the update could not be verified. The certificates must be issued to `techieutils` (`Developer ID Application: techieutils (TEAMID)`, and `Developer ID Installer` for the `.pkg`), the `identity` in `package.json`; a build without one is left unsigned. Signed builds use the hardened runtime and are notarized when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are set; a build without them skips notarization with a warning. The only entitlement in [`packages/api-workbench-electron/resources/entitlements.mac.plist`](packages/api-workbench-electron/resources/entitlements.mac.plist) is JIT for V8. Library validation stays on, so native modules such as the terminal's node-pty load because they are signed with the app's own identity, and code signed by anyone else is refused. Add an entitlement only when a feature needs it; a spec checks the list. Windows installers are signed when the `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` secrets are set; unsigned, SmartScreen warns before the first run. The certificate's subject name must be `techieutils`, the `publisherName` in `package.json`: installed Windows copies accept only updates signed by that publisher, so they do not install an unsigned update or one signed under another name.

Packaged builds are hardened with [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) (`electronFuses` in `package.json`): the app cannot be run as plain Node.js (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, loads only from its `app.asar`, checks that archive's integrity on macOS and Windows, and encrypts Chromium's cookie store. They apply only to packaged builds; `npm start` and the tests are unaffected. Packages also leave out source maps and every Chromium language except English, since the interface is English only.

macOS packages are built for both `x64` and `arm64`. Building for the other architecture rebuilds native modules such as node-pty in place, so afterwards run `npx electron-builder install-app-deps` to rebuild them for your own Mac before `npm start`.

## Dependencies

Keep dependencies on their latest versions, with these exceptions until upstream changes:

- **vue-tsc is pinned to 3.3.13.** 3.3.14 reports false `.value` errors late in large templates (such as `AuthenticationPanel.vue`).
- **TypeScript stays on 6.x** for type-checking: typescript-eslint supports `<6.1`, and TypeScript 7 has no JavaScript API for vue-tsc. The build itself uses TypeScript 7, as `typescript-build`.
- **`@types/vscode` matches the oldest VS Code the extension supports** (`engines.vscode` in `packages/api-workbench-vscode/package.json`; `manifest.spec.ts` checks), so the extension only uses APIs that VS Code has. Raise both together, and only to drop older VS Code versions on purpose.
- **`npm install` and `npm update` can move these pins**, and can leave a dependency's own older copy of `form-data` beside the overridden 4.0.6: after either, check `npm ls vue-tsc form-data` and `npm audit --omit=dev --audit-level=high`.

The command line's npm package has no dependencies of its own: `npm run cli:package` publishes the bundle, which holds everything it needs. Keep it that way — a runtime dependency it cannot bundle (a native module, say) would have to be installed on every CI machine.

After changing dependencies, run every check above, including both UI suites, and note the change in the changelog when users would notice it.

## Documentation and screenshots

The guides in `docs/` are Markdown, built into the website by `scripts/build-site.mjs`. Build it with `npm run site:build`, or preview it with `npm run site:preview`. Write in plain, direct language: what the reader can do and how, with exact names of buttons and menus in **bold**.

The images in `docs/images` are captured from the real app with a sample "Acme Store" workspace and a local mock API: run `npm run docs:screenshots`. The same run records the animated `demo.webp`, which needs `img2webp` from [libwebp](https://developers.google.com/speed/webp/download) (`brew install webp` on macOS); run `npm run docs:demo` to record only the demo.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).
