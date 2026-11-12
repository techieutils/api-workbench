// Packages the extension as dist/api-workbench-vscode-<version>.vsix, from a staging folder that holds only
// what is shipped: the manifest, README, licence, icons, the bundled extension, and the command line.
// Staging keeps vsce away from the workspace's node_modules, and lets the manifest drop what only
// the repository needs (its scripts and dev dependencies).
//
//   npm run package -w api-workbench-vscode
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '..');
const root = path.resolve(extension, '../..');
const stage = path.join(extension, 'dist/stage');

const source = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
for (const file of [
  'dist/extension.js',
  'dist/webview.js',
  'dist/webview.css',
  'dist/cli/api-workbench.cjs',
])
  await readFile(path.join(extension, file)).catch(() => {
    throw new Error(`${file} is missing: run npm run build -w api-workbench-vscode first.`);
  });

// Scripts and dev dependencies stay in the repository.
const manifest = { ...source };
for (const field of ['private', 'scripts', 'devDependencies']) delete manifest[field];
// Exactly what is shipped; vsce warns without a list.
manifest.files = [
  'dist/extension.js',
  'dist/webview.js',
  'dist/webview.css',
  'dist/cli/**',
  'media/**',
  'LICENSE',
  'README.md',
];

await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'media'), { recursive: true });
await mkdir(path.join(stage, 'dist/cli'), { recursive: true });
await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// The README's logo shows on GitHub. VS Code's Extensions view shows README images only from a
// reachable https: address — not the extension's own files, nor data: — and already shows the
// extension's icon, the same logo, above it; so the packaged README leaves its copy out rather
// than show a broken image.
const readme = await readFile(path.join(extension, 'README.md'), 'utf8');
const logo = /^<p align="center">\s*<img src="media\/icon\.png"[^>]*>\s*<\/p>\s*/;
if (!logo.test(readme)) throw new Error('README.md no longer starts with media/icon.png.');
await writeFile(path.join(stage, 'README.md'), readme.replace(logo, ''));
await copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
// The extension's icon, which the README shows too, so both are the one file.
// The light and dark marks are the pages' tab icons and the .http file icon.
for (const file of [
  'icon.png',
  'icon-light.svg',
  'icon-dark.svg',
  'activity.svg',
  'http.tmLanguage.json',
  'http.language.json',
])
  await copyFile(path.join(extension, 'media', file), path.join(stage, 'media', file));
// The method and protocol badges of the tree and the editor tabs, and the walkthrough's pages.
for (const folder of ['methods', 'walkthrough'])
  await cp(path.join(extension, 'media', folder), path.join(stage, 'media', folder), {
    recursive: true,
  });
for (const file of ['dist/extension.js', 'dist/webview.js', 'dist/webview.css'])
  await copyFile(path.join(extension, file), path.join(stage, file));
await cp(path.join(extension, 'dist/cli'), path.join(stage, 'dist/cli'), { recursive: true });
for (const notices of ['dist/extension.js.LEGAL.txt'])
  await copyFile(path.join(extension, notices), path.join(stage, notices)).catch(() => undefined);

const vsix = path.join(extension, 'dist', `api-workbench-vscode-${manifest.version}.vsix`);
const vsce = path.join(root, 'node_modules/@vscode/vsce/vsce');
// The README's relative links and images resolve to the repository on GitHub.
const base = `https://github.com/techieutils/api-workbench/raw/main/packages/api-workbench-vscode/`;
execFileSync(
  process.execPath,
  [
    vsce,
    'package',
    '--no-dependencies',
    '--out',
    vsix,
    '--baseContentUrl',
    base,
    '--baseImagesUrl',
    base,
  ],
  { cwd: stage, stdio: 'inherit' },
);

console.log(`Packaged ${path.relative(process.cwd(), vsix)}`);
