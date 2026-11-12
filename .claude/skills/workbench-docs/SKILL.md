---
name: workbench-docs
description: How API Workbench's documentation is written and generated — user guides in docs/, the changelog, the command line's README (its npm package page), the root repository docs (README, CONTRIBUTING, SECURITY, RELEASING, COMPARISON, AGENTS and its Copilot summary), screenshots, and the documentation website. Use when behaviour visible to users changes, when adding or editing a page or a CLI command, refreshing screenshots or the demo, building the docs site, or updating the repository's own docs.
---

# API Workbench documentation

## Where

| File                                                                           | What it is                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/*.md`                                                                    | User guides (front matter: `description`, `icon`); `docs/guides/` for task guides; `docs/reference.md` for exact behaviour; `docs/cli.md` for the command line |
| `docs/changelog.md`                                                            | Every user-noticeable change, under **Unreleased**                                                                                                             |
| `docs/images/`                                                                 | Screenshots and `demo.webp`, all generated; never edit by hand                                                                                                 |
| `packages/api-workbench-vscode/README.md`, `docs/vscode.md`                    | The extension's page inside VS Code (images: PNG, never SVG — the Marketplace rejects SVG in READMEs) and its user guide                                       |
| `packages/api-workbench-cli/README.md`                                         | The command line's guide, shown on its GitHub Packages page; must cover every command and option in `--help` (`tests/cli-package.test.ts` checks)              |
| `README.md`                                                                    | The repository's front page: features, quick start, platforms, architecture, development commands                                                              |
| `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`                         | Contributor guide, security policy and design, conduct; **also published on the website** under Community                                                      |
| `RELEASING.md`                                                                 | Step-by-step release, including publishing the CLI to npm                                                                                                      |
| `COMPARISON.md`                                                                | API Workbench against other API clients, with sources and dates                                                                                                |
| `AGENTS.md`, `.github/copilot-instructions.md`, `CLAUDE.md`, `.claude/skills/` | Instructions for coding agents; the Copilot file summarises `AGENTS.md`, so change both together                                                               |
| `scripts/build-site.mjs`, `scripts/site/`                                      | The website: navigation order, favicons, CSS/JS                                                                                                                |

## Writing

Plain, direct language: what the reader can do and how. Exact names of buttons, menus, and settings in **bold** (**Settings → Updates**), keys in `<kbd>`. Link related pages with relative links and anchors (`installation.md#check-a-download`). Describe what the app does today, not how it changed — history belongs in the changelog.

- **Accuracy first.** Check each claim against the code or by running it: option names from `api-workbench <command> --help`, labels from the component, defaults from the store. For other products (`COMPARISON.md`), mark what could not be confirmed with ❓ and keep the dates in its accuracy note current.
- **Links on the website.** In `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`, links to repository files outside `docs/` become GitHub links; links into `docs/` become site pages. A new page in `docs/` also needs its entry in the navigation in `scripts/build-site.mjs`.
- **Formatting.** `npm run format:check` covers no Markdown, so CI does not catch it: run `npx prettier --write` on every `.md` file you change — in `docs/`, at the root, and the CLI README.

## Changelog

Add entries under **Unreleased**, in the section for the area (`### Scripts`, `### Command line and CI`, `### Runner`, `### Fixes`, …), adding a section only when none fits. Lead with the feature in bold and a colon, say what a person can now do, and end with a link to the page that explains it (`See [Syntax errors](scripts.md#syntax-errors).`). A fix says what used to go wrong and that it no longer does.

## Command line docs

A new command or option goes in three places: the CLI's `--help` (in `packages/api-workbench-cli/src/`), `packages/api-workbench-cli/README.md` (the command table and, for `run`, the options table), and `docs/cli.md`. The README writes the command as `api-workbench …`; `docs/cli.md` as `node api-workbench.cjs …`, the single-file form.

## Screenshots

```sh
npm run docs:screenshots   # all images + demo.webp (needs img2webp: brew install webp)
npm run docs:demo          # only the demo
```

Both build the production app and capture it with the sample "Acme Store" workspace and a local mock API, defined in `scripts/docs-screenshots.ts`. To add an image, add a `capture(name)` step there (pass `keepToasts` to keep toasts visible) and reference `images/<name>.png` from the page. Use `captureThemes(name)` instead to also save `images/<name>-light.png` in the light theme: the site shows whichever matches the reader's theme, and Markdown viewers show the dark one. `DOCS_ONLY=name,… npm run docs:screenshots` writes only the images named (with their light twins). Run it whenever the interface changes and check the images look right — never include real secrets or personal data. If you cannot run it, say which images are out of date.

## Site

```sh
npm run site:build     # dist/site; reports pages and search entries
npm run site:preview   # build and serve on http://localhost:4174
```

## Checklist

1. Page(s) updated, with screenshots refreshed if the UI changed.
2. Changelog entry under **Unreleased**.
3. CLI change: `--help`, the CLI README, and `docs/cli.md` agree; `tests/cli-package.test.ts` passes.
4. `AGENTS.md` changed: `.github/copilot-instructions.md` updated with it.
5. `npx prettier --check docs <other changed .md files>` and `npm run site:build` pass.
