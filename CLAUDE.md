# API Workbench

@AGENTS.md

## Claude Code

- The guides listed under "More detail" are project skills here: `workbench-develop`, `workbench-test`, `workbench-docs`, `workbench-release`, `workbench-security`. Load the matching one before working in its area.
- Keep shared instructions in `AGENTS.md` so every agent sees them; put only Claude Code–specific notes in this file. When `AGENTS.md` changes, update `.github/copilot-instructions.md` with it.
- The full Playwright suite (`npm run test:e2e`) and `npm run test:ui` take over ten minutes: run them with `run_in_background` and wait for the notification, and run one spec file (`npx playwright test e2e/<file>`) or one smoke part while iterating.
- `npm run test:vscode` opens a real VS Code: run it with `run_in_background`, once as it is and once with `VSCODE_TEST_ENGINE=commandLine`. To look at an extension page, build it (`node scripts/build.mjs` in the extension), load `dist/webview.js` and `dist/webview.css` in a page of your own with a stub `acquireVsCodeApi`, and post it `{ type: 'render', view }` with Playwright — from a folder outside the repository.
- Publishing is outward-facing: never push a `v*` tag, publish a GitHub release, run `publish-cli.yml`, `npm publish`, `vsce publish`, or `ovsx publish`, or change the GitHub repository's settings unless asked to in this conversation. Building packages locally (`npm run cli:package`, `npm run vscode:package`, `npm pack --dry-run`) is fine.
