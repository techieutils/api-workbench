import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Application-level checks on the compiled app: the pieces each package builds fit together the
// way Electron and electron-builder load them. Run after `npm run compile`.
const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageDirectory = (name: string) =>
  path.dirname(require.resolve(`@techieutils/api-workbench-${name}/package.json`));

/** Module names under a package's src/, without the build-excluded specs and test helpers. */
function modules(directory: string, prefix = ''): string[] {
  return readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : modules(directory, name);
    return /(?<!\.spec|\.d)\.ts$/.test(entry.name) ? [name.replace(/\.ts$/, '')] : [];
  });
}

test('the app entry point and its preload script are built', () => {
  const main = path.join(root, manifest.main);
  assert.ok(existsSync(main), `${manifest.main} exists`);
  assert.ok(existsSync(path.join(path.dirname(main), 'main.js')), 'main.js sits beside the entry');
  assert.ok(existsSync(path.join(path.dirname(main), 'preload.js')), 'preload.js sits beside main');
});

test('the main process finds the renderer where it loads it from', () => {
  // main.ts loads ../../api-workbench-app/dist/index.html relative to its compiled file.
  const main = path.dirname(path.join(root, manifest.main));
  const page = path.resolve(main, '../../api-workbench-app/dist/index.html');
  assert.equal(page, path.join(packageDirectory('app'), 'dist/index.html'));
  assert.ok(existsSync(page), 'the renderer page is built');
});

test('every local script and stylesheet the renderer page references is built', () => {
  const dist = path.join(packageDirectory('app'), 'dist');
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]
    .map(([, reference]) => reference)
    .filter((reference) => !/^(?:[a-z]+:|#|\/\/)/i.test(reference));
  assert.ok(references.length >= 5, 'the page loads its runtimes, shell, and styles');
  for (const reference of references)
    assert.ok(existsSync(path.join(dist, reference.split(/[?#]/)[0])), `${reference} is built`);
});

test('every icon and resource electron-builder packages exists', () => {
  const build = manifest.build;
  const files = [
    build.mac.icon,
    build.win.icon,
    build.linux.icon,
    build.nsis.installerIcon,
    build.nsis.uninstallerIcon,
    ...build.extraResources.flatMap((resource: { from: string; filter: string[] }) =>
      resource.filter
        .filter((filter) => !filter.includes('*'))
        .map((filter) => path.join(resource.from, filter)),
    ),
  ];
  assert.ok(existsSync(path.join(root, build.directories.buildResources)));
  for (const file of files) assert.ok(existsSync(path.join(root, file)), `${file} exists`);
});

test('every shared module loads by package name from its compiled build', async () => {
  const names = modules(path.join(packageDirectory('common'), 'src'));
  assert.ok(names.length >= 20);
  for (const name of names)
    assert.equal(
      typeof (await import(`@techieutils/api-workbench-common/${name}`)),
      'object',
      name,
    );
});

test('every main-process module outside the Electron entry points loads under Node', async () => {
  // These need the Electron runtime; the UI smoke tests in scripts/ start them.
  const entryPoints = new Set(['bootstrap', 'main', 'preload', 'terminal-preload']);
  const names = modules(path.join(packageDirectory('electron'), 'src')).filter(
    (name) => !entryPoints.has(name),
  );
  assert.ok(names.length >= 15);
  for (const name of names)
    assert.equal(
      typeof (await import(`@techieutils/api-workbench-electron/${name}`)),
      'object',
      name,
    );
});

test('the build inputs the scripts copy resolve through the app and assets packages', () => {
  for (const file of [
    '@techieutils/api-workbench-app/public/index.html',
    '@techieutils/api-workbench-app/public/terminal.html',
    '@techieutils/api-workbench-app/styles/startup.css',
    '@techieutils/api-workbench-app/assets/favicon-32.png',
    '@techieutils/api-workbench-assets/icons/icon.icns',
  ])
    assert.ok(existsSync(require.resolve(file)), file);
});
