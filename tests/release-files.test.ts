import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The documentation's download picker links to release files by name. The names are worked out
// from the `build` config in package.json with electron-builder's own rules, so a change to the
// packaging config changes the links with it; these tests keep the two in step.

interface ReleaseFile {
  os: string;
  arch: string;
  target: string;
  name: string;
}
interface ReleaseFilesModule {
  releaseFiles(build: unknown): ReleaseFile[];
  artifactArch(arch: string, ext: string): string;
  downloadURL(name: string, version: string): string;
  downloadCommands(file: ReleaseFile, version: string): string;
  changelogVersions(changelog: string): string[];
  CLI_ENTRY: ReleaseFile;
}

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  build: unknown;
};
const load = () =>
  import(
    pathToFileURL(path.join(root, 'scripts', 'release-files.mjs')).href
  ) as Promise<ReleaseFilesModule>;

test('architecture names match electron-builder for every format', async () => {
  const { artifactArch } = await load();
  // electron-builder comes with the packaging tools; this is its own naming function.
  const builder = (await import('builder-util')) as unknown as {
    getArtifactArchName(arch: number, ext: string): string;
    Arch: Record<string, number>;
  };
  for (const arch of ['x64', 'arm64'])
    for (const ext of ['dmg', 'pkg', 'zip', 'exe', 'AppImage', 'deb', 'rpm', 'tar.gz', 'flatpak'])
      assert.equal(
        artifactArch(arch, ext),
        builder.getArtifactArchName(builder.Arch[arch], ext),
        `${arch} ${ext}`,
      );
});

test('every system, architecture, and format the build makes has one file name', async () => {
  const { releaseFiles } = await load();
  const files = releaseFiles(pkg.build);
  const name = (os: string, arch: string, target: string) =>
    files.find((file) => file.os === os && file.arch === arch && file.target === target)?.name;
  // GitHub has no spaces in names: electron-builder publishes "API Workbench" as "API-Workbench".
  assert.equal(name('mac', 'arm64', 'dmg'), 'API-Workbench-{version}-mac-arm64.dmg');
  assert.equal(name('win', 'x64', 'nsis'), 'API-Workbench-Setup-{version}.exe');
  assert.equal(name('win', 'arm64', 'nsis'), 'API-Workbench-Setup-{version}.exe');
  assert.equal(name('win', 'arm64', 'portable'), 'API-Workbench-{version}-win-portable-arm64.exe');
  assert.equal(name('linux', 'x64', 'AppImage'), 'API-Workbench-{version}-linux-x86_64.AppImage');
  assert.equal(name('linux', 'x64', 'deb'), 'API-Workbench-{version}-linux-amd64.deb');
  assert.equal(name('linux', 'arm64', 'rpm'), 'API-Workbench-{version}-linux-aarch64.rpm');
  for (const file of files) {
    assert.match(file.name, /^[\w.{}-]+$/, `${file.name} is a name GitHub keeps as it is`);
    assert.ok(file.name.includes('{version}'), `${file.name} names its version`);
  }
  // Every target in the packaging config is offered.
  const build = pkg.build as Record<string, { target: { target: string; arch: string[] }[] }>;
  for (const os of ['mac', 'win', 'linux'])
    for (const { target, arch } of build[os].target)
      for (const each of arch) assert.ok(name(os, each, target), `${os} ${each} ${target}`);
});

test('download links, checksum commands, and versions', async () => {
  const { downloadURL, downloadCommands, changelogVersions, releaseFiles, CLI_ENTRY } =
    await load();
  const releases = 'https://github.com/techieutils/api-workbench/releases';
  assert.equal(
    downloadURL('API-Workbench-{version}-mac-arm64.dmg', '1.2.0'),
    `${releases}/download/v1.2.0/API-Workbench-1.2.0-mac-arm64.dmg`,
  );
  assert.equal(
    downloadURL(CLI_ENTRY.name, 'latest'),
    `${releases}/latest/download/api-workbench-cli.cjs`,
  );
  // The newest release's links need the file's exact name, which a versioned file cannot give.
  assert.throws(
    () => downloadURL('API-Workbench-{version}-mac-arm64.dmg', 'latest'),
    /needs a version/,
  );

  const linuxDeb = releaseFiles(pkg.build).find(
    (file) => file.os === 'linux' && file.arch === 'x64' && file.target === 'deb',
  )!;
  assert.deepEqual(downloadCommands(linuxDeb, '1.2.0').split('\n'), [
    `curl -fLO '${releases}/download/v1.2.0/API-Workbench-1.2.0-linux-amd64.deb'`,
    `curl -fLO '${releases}/download/v1.2.0/SHA256SUMS'`,
    'sha256sum --check --ignore-missing SHA256SUMS',
    "sudo apt install './API-Workbench-1.2.0-linux-amd64.deb'",
  ]);
  const windows = releaseFiles(pkg.build).find((file) => file.target === 'nsis')!;
  assert.match(
    downloadCommands(windows, '1.2.0'),
    /Get-FileHash 'API-Workbench-Setup-1\.2\.0\.exe'/,
  );

  assert.deepEqual(
    changelogVersions('# Changelog\n\n## Unreleased\n\n## 1.1.0\n\n- x\n\n## v1.0.0\n'),
    ['1.1.0', '1.0.0'],
  );
  const changelog = readFileSync(path.join(root, 'docs', 'changelog.md'), 'utf8');
  assert.ok(changelogVersions(changelog).length > 0, 'the changelog lists released versions');
});
