# Copilot instructions — API Workbench

The full agent guide is [AGENTS.md](../AGENTS.md); this file is its summary for Copilot chat and code review. Keep the two in step.

API Workbench is a local-first desktop API client: Electron 45 main process (`packages/api-workbench-electron`), Vue 3 + Pinia renderer (`packages/api-workbench-app`), shared types and logic (`packages/api-workbench-common`), the `api-workbench` command line for CI and workspace management (`packages/api-workbench-cli`), and a VS Code extension that drives that command line, loaded into VS Code by default (`packages/api-workbench-vscode`; its webviews are styled with Tailwind CSS, as the app is). TypeScript strict, npm workspaces, Node 22.19+.

## Rules — flag any change that breaks one

- **Secrets stay in the main process.** No secret, token, or private key in renderer state, logs, History, exports, screenshots, or generated code.
- **IPC only through `handle()` in `main.ts`**, which accepts calls only from the app window's top frame. Never use `ipcMain.handle`/`on` directly. Validate every argument in main.
- **The renderer can never run system commands or arbitrary code.** The terminal is its own page (a view docked over dev tools, or its own window), the only one whose IPC reaches a shell (`packages/api-workbench-electron/src/terminal-window.ts`); the app window may only place it or stage a command. Text typed into the terminal goes through `promptText`, and each value through `shellQuote`/`shellWord` (`packages/api-workbench-app/src/terminal-input.ts`). Never build shell commands by string concatenation.
- **Strict content security policy.** No inline `<script>`/`<style>`, no `style="…"` from markup (use classes or `element.style`). The desktop renderer has `connect-src 'none'`: network calls happen in main, with undici's own `fetch`/`Headers`/`FormData`.
- **Untrusted content is parsed, never run.** Response previews never get `allow-scripts`. Request scripts are the one exception: QuickJS only, in a utility process, after the person allows them; never add host functions that reach files, network, processes, or the vault. The script editor's suggestions and syntax check only parse script text, never evaluate it.
- **Kept in step by tests:** a change to the `aw` API in `script-engine.ts` also updates `script-api.ts`; a new CLI command or option also goes in `packages/api-workbench-cli/README.md`. The CLI's npm package has no dependencies. The VS Code extension never runs in untrusted workspaces, its settings that choose a program or turn scripts on stay `machine`-scoped, and its webviews run only their own bundled script (nonce CSP) and render responses as text, never HTML.
- **The VS Code extension hands secrets and files to the command line, never to a page:** secrets in its environment or standard input, never as arguments; files chosen in VS Code's own dialog (or named by a `.http` file), never by a path a webview posts.
- **The workspace is a plain object**, not deeply reactive: mutate, then `render()`/`persist()`; read in-place state with `useRendered()`, not a plain `computed`.
- Import across packages by name (`@techieutils/api-workbench-common/...`), never by relative path.

## Code style

- Match the surrounding code. Comments explain why, in plain sentences.
- Reuse the controls in `packages/api-workbench-app/src/components/ui/` instead of one-off ones.
- Every control works by keyboard and screen reader, in light and dark themes, and at narrow widths; states never rely on colour alone.
- Tests: `*.spec.ts` beside the code; Vue `*.test.ts` beside components and stores; flows a person goes through in `e2e/` (Playwright, local server only); cross-package flows in `tests/`; interface behaviour in `scripts/ui-smoke/` (one part per area, independent of other parts). A bug fix includes a test that fails without it.
- Tests use made-up values; a public sample that looks like a secret gets `// gitleaks:allow`.
- User-visible changes update `docs/` and add an entry under **Unreleased** in `docs/changelog.md`.

## Checks

```sh
npm run lint && npm run format:check && npm run check && npm test
npm run test:e2e           # Playwright end-to-end tests of the desktop app
npm run test:fuzz          # fuzz the parsers of untrusted text (after npm test)
npm run test:ui            # Electron UI smoke; --only=<part> for one part
npm run cli:package        # the command line's npm package, when the CLI changes
npm run test:vscode        # the extension inside VS Code, when it or the CLI changes
```

Releases: `RELEASING.md`. `release.yml` drafts a release from a `v*` tag; publishing it runs `publish-cli.yml`, which puts the CLI on GitHub Packages.
