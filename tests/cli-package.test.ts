import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The command line's npm package, which publish-cli.yml publishes to GitHub Packages: what it holds,
// that it runs, and that its README describes every command the command line has.

const root = path.resolve(__dirname, '../..');
const cliFolder = path.join(root, 'packages/api-workbench-cli');
const out = mkdtempSync(path.join(os.tmpdir(), 'api-workbench-cli-package-'));
// The bundle, then the package from it, as `npm run cli:package` makes them.
execFileSync(process.execPath, ['scripts/bundle.mjs'], { cwd: cliFolder, stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/npm-package.mjs', '--out', out], {
  cwd: cliFolder,
  stdio: 'pipe',
});
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

interface Manifest {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  repository: { url: string; directory: string };
  publishConfig: { registry: string; access: string };
  [key: string]: unknown;
}
const manifest = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8')) as Manifest;
const workspacePackage = JSON.parse(
  readFileSync(path.join(cliFolder, 'package.json'), 'utf8'),
) as Manifest;
const appPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const readme = readFileSync(path.join(cliFolder, 'README.md'), 'utf8');
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [path.join(out, 'api-workbench.cjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

test('the package is the command line, published to GitHub Packages', () => {
  assert.equal(manifest.name, workspacePackage.name);
  // GitHub Packages takes a package only in its repository owner's scope.
  assert.match(manifest.name, /^@techieutils\//);
  assert.match(manifest.repository.url, /github\.com\/techieutils\/api-workbench\.git$/);
  assert.equal(manifest.repository.directory, 'packages/api-workbench-cli');
  assert.deepEqual(manifest.publishConfig, {
    registry: 'https://npm.pkg.github.com',
    access: 'public',
  });
  assert.equal(manifest.version, appPackage.version, 'released with the app, at its version');
  assert.deepEqual(manifest.engines, workspacePackage.engines);
  assert.deepEqual(manifest.bin, { 'api-workbench': 'api-workbench.cjs' });
});

test('it has no dependencies: the bundle holds everything', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'scripts'])
    assert.equal(manifest[field], undefined, field);
  assert.equal(manifest.private, undefined, 'the workspace package is private; this one is not');
});

test('it holds the bundle, its licences, and the README, and nothing else', () => {
  assert.deepEqual(readdirSync(out).sort(), [...manifest.files, 'package.json'].sort());
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: out,
      encoding: 'utf8',
    }),
  ) as { files: { path: string }[] }[];
  assert.deepEqual(
    packed[0].files.map((file) => file.path).sort(),
    [...manifest.files, 'package.json'].sort(),
  );
  assert.match(
    readFileSync(path.join(out, 'api-workbench.cjs'), 'utf8'),
    /^#!\/usr\/bin\/env node\n/,
  );
  // The README is the repository's, with its logo pointed at GitHub for the package page.
  const packaged = readFileSync(path.join(out, 'README.md'), 'utf8');
  assert.equal(
    packaged,
    readme.replace(
      'src="../api-workbench-app/src/assets/branding/app-icon.svg"',
      'src="https://raw.githubusercontent.com/techieutils/api-workbench/main/packages/api-workbench-app/src/assets/branding/app-icon.svg"',
    ),
  );
  assert.doesNotMatch(packaged, /src="\.\.\//, 'no repository paths left in the package');
  // The logo the README points at exists in the repository.
  for (const [, relative] of readme.matchAll(/src="(\.\.\/[^"]+)"/g))
    assert.ok(existsSync(path.join(cliFolder, relative)), relative);
});

test('the packaged file runs, at the package version', () => {
  assert.equal(cli('--version').trim(), manifest.version);
});

test('the README describes every command the command line has', () => {
  const help = cli('--help');
  // Lines such as "      request       list, show, send, create, delete, code".
  const resources = [...help.matchAll(/^ {6}([a-z]+) +([a-z]+(?:, [a-z]+)*)/gm)];
  assert.ok(resources.length >= 10, 'the help lists the resources');
  for (const [, resource, commands] of resources) {
    assert.ok(readme.includes(`api-workbench ${resource}`), `README lists ${resource}`);
    for (const command of commands.split(', '))
      assert.ok(
        readme.includes(`${resource} ${command}`),
        `README explains ${resource} ${command}`,
      );
  }
  for (const command of ['run', 'list'])
    assert.ok(readme.includes(`api-workbench ${command} `), `README explains ${command}`);
  // Every option the help lists for run is in the README's table.
  for (const [, option] of help.matchAll(/^\s+(?:-\w, )?(--[a-z-]+)/gm))
    assert.ok(readme.includes(`\`${option}`), `README explains ${option}`);
});
