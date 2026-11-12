---
name: workbench-release
description: Packaging and releasing API Workbench — electron-builder config in package.json, platform targets, signing (macOS identity, Windows publisherName), fuses, auto-update files, the tag-triggered release workflow with SHA256SUMS and attestations, publishing the command line to GitHub Packages (npm) after a release, and CI. Use when changing build/packaging config, cutting a release, publishing or changing the CLI's npm package, or editing .github/workflows.
---

# Building and releasing API Workbench

`RELEASING.md` is the step-by-step for people; this is the reference behind it. Releasing is outward-facing: never push a `v*` tag, publish a release, run `publish-cli.yml`, or `npm publish` unless the user asked for that in this conversation. Building locally is fine.

## Packaging config

All electron-builder config is the `build` key of the root `package.json` (electron-builder 26). Check option names against `node_modules/app-builder-lib/scheme.json` before adding one.

- **Targets:** macOS dmg/zip/pkg (x64, arm64); Windows nsis/portable/zip (x64, arm64); Linux AppImage/deb/rpm/tar.gz (x64, arm64). `x86_64` is not an electron-builder arch — AppImage and rpm are already named x86_64. `scripts/release-files.mjs` derives the published file names (the docs' download picker), and `tests/release-files.test.ts` checks them against electron-builder's rules.
- **Identity:** `appId` `com.techieutils.apiworkbench.desktop`. `APP_USER_MODEL_ID` in electron `app-links.ts` must equal it (a spec checks). URL scheme `apiworkbench` is in each platform's `protocols` and Linux `desktop.entry.MimeType`; `desktopName` is `api-workbench.desktop` (spec checks these too).
- **Signing:** macOS `mac.identity: "techieutils"` (skipped with no certificate), hardened runtime and notarization (`mac.notarize: true`; runs when the `APPLE_*` variables are set) with `packages/api-workbench-electron/resources/entitlements.mac.plist`, which holds only `allow-jit` — library validation stays on; add entitlements only when a feature needs one (a spec checks the list). Windows `win.signtoolOptions` with `publisherName: ["techieutils"]`: installed Windows copies refuse updates not signed by that publisher, so unsigned releases cannot update NSIS installs. Linux has no code signing.
- **Hardening:** `electronFuses` (no run-as-node, no NODE_OPTIONS/inspect, asar-only with integrity, cookie encryption). Source maps and non-English locales are excluded.

## Building locally

```sh
npm run dist:mac | dist:win | dist:linux | dist:all   # lint, format, compile:prod, electron-builder → release/
npx electron-builder --mac --x64 --dir                 # quick unpacked build to validate config
CSC_IDENTITY_AUTO_DISCOVERY=false …                    # skip signing locally
npm run cli:bundle                                     # the CLI as one file: packages/api-workbench-cli/dist/api-workbench.cjs
npm run cli:package                                    # its npm package: packages/api-workbench-cli/dist/npm
npm run vscode:package                                 # the VS Code extension: packages/api-workbench-vscode/dist/api-workbench-vscode-<version>.vsix
```

- Building for another architecture rebuilds node-pty in place; afterwards run `npx electron-builder install-app-deps` (with `--arch` for your machine) before `npm start`.
- Cross-building Windows from macOS needs `-c.npmRebuild=false` (node-gyp cannot cross-compile); use it only to validate config.
- Inspect a mac build's `Info.plist` with `plutil -p "release/mac/API Workbench.app/Contents/Info.plist"`.
- Check the npm package without publishing: `cd packages/api-workbench-cli/dist/npm && npm pack --dry-run`, or `npm pack --pack-destination <scratch>` and `npm install --global --prefix <scratch>/prefix <tgz>`.

## Releasing

1. Move **Unreleased** in `docs/changelog.md` under the new version and date; set `version` in `package.json`, `packages/api-workbench-cli/package.json`, and `packages/api-workbench-vscode/package.json` (`npm version X.Y.Z --no-git-tag-version`, and again with `-w @techieutils/api-workbench-cli` and `-w api-workbench-vscode`; specs check they match).
2. Tag `vX.Y.Z` (or `vX.Y.Z-beta.N`) and push. `.github/workflows/release.yml` checks the tag equals the version, builds each platform with `--publish always` into a draft GitHub release (with `latest*.yml` and blockmaps the updater needs), then the `checksums` job bundles the command line and attaches it as `api-workbench-cli.cjs`, packages and attaches the VS Code extension (`api-workbench-vscode-<version>.vsix`), downloads the draft, uploads `SHA256SUMS`, and signs build-provenance attestations (`actions/attest-build-provenance`, public repos or Enterprise Cloud only).
3. Review the draft, paste the changelog entry as notes, publish. Mark betas as pre-releases.
4. Publishing the release runs `.github/workflows/publish-cli.yml` (also `workflow_dispatch` with a `tag` input, to retry). It checks the tag is `v` + the CLI's version and the package scope is the repository owner, runs `npm ci` and `npm run cli:package`, checks the packaged file prints the version and is byte-for-byte the release's `api-workbench-cli.cjs` (the esbuild bundle is deterministic: same commit and lockfile, same bytes), then `npm publish` to `https://npm.pkg.github.com` with `GITHUB_TOKEN` (`packages: write`), dist-tag `latest`, or `next` for a version with a hyphen.

Never upload installers without their `latest*.yml`. A version published to npm can never be replaced; a mistake is fixed by a new release. Signing secrets: `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`. GitHub Packages needs none.

## The CLI's npm package

- Name `@techieutils/api-workbench-cli` — GitHub Packages accepts only the repository owner's scope. The workspace `packages/api-workbench-cli/package.json` stays `private` (it depends on unpublished internal packages); `scripts/npm-package.mjs` writes the published manifest: `bin` `api-workbench`, `files`, `engines`, `repository` (which links the package to the repo), `publishConfig.registry`, and no dependencies or scripts.
- Contents: `api-workbench.cjs` (the bundle, with its shebang), `api-workbench.cjs.LEGAL.txt` (bundled licences), `README.md` (the CLI's README), `LICENSE`.
- `tests/cli-package.test.ts` builds it and checks the manifest, the file list (`npm pack --dry-run`), that it runs at the right version, and that the README mentions every command and option in `--help`.
- Installing from GitHub Packages needs a token with `read:packages` even for public packages; the release's single file needs none. Docs: the CLI README's Install section and `docs/cli.md#install`.

## The VS Code extension

- `packages/api-workbench-vscode`, extension id `techieutils.api-workbench-vscode` (the npm workspace name is unscoped because VS Code ids cannot hold an npm scope). `scripts/build.mjs` bundles `dist/extension.js` (esbuild, `vscode` external, Node 20 target for VS Code 1.100) and copies the CLI bundle into `dist/cli/`; `scripts/package.mjs` stages only what ships (manifest without scripts or dev dependencies, README, LICENSE, icons from the app's branding, `dist/`) and runs `@vscode/vsce` 4.0.0 with `--no-dependencies`.
- Released as a `.vsix` on GitHub releases only; it is not on the VS Code Marketplace or Open VSX. Publishing there needs publisher accounts and `VSCE_PAT`/`OVSX_PAT` secrets the user creates, and a decision from the user.
- `engines.vscode` equals `^` + the pinned `@types/vscode` (a spec checks). Raising it drops older editors.

## CI (`.github/workflows/`)

- `ci.yml`: `check` job (`npm audit --omit=dev --audit-level=high`, lint, format, type check, `npm test`, `npm run vscode:package` with the `.vsix` uploaded as the `vscode-extension` artifact), `e2e` job (Playwright under `xvfb-run` on Linux, after allowing Electron's sandbox with `sysctl kernel.apparmor_restrict_unprivileged_userns=0`; uploads `test-results/` on failure), and `secrets` job (gitleaks 8.30.1, checksum-verified, whole history, config `.gitleaks.toml`; mark public sample values with `// gitleaks:allow`).
- `codeql.yml` (security-extended), `pages.yml` (docs site), `release.yml`, `publish-cli.yml`; Dependabot is configured in `.github/dependabot.yml` (weekly).
- Each workflow sets top-level `permissions` to the least it needs (`publish-cli.yml` starts from `{}`) and grants more per job. Actions are referenced by major tag; downloaded tools are pinned by version and SHA-256. `actionlint` is not installed locally: at least parse a changed workflow (`node -e "require('yaml').parse(…)"`) and say it was not run.
