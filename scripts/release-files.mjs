// The files each release attaches, named as electron-builder names them, from the `build` config in
// package.json: what the documentation's download picker links to. The release workflow uploads
// them with electron-builder's GitHub publisher, which turns the spaces in a name into dashes.
// tests/release-files.test.ts checks these rules against electron-builder's own.

export const RELEASES = 'https://github.com/techieutils/api-workbench/releases';
/** The command line: one file, the same for every system, named without its version. */
export const CLI_FILE = 'api-workbench-cli.cjs';

/** The extension each electron-builder target writes. */
const EXTENSIONS = {
  dmg: 'dmg',
  pkg: 'pkg',
  zip: 'zip',
  nsis: 'exe',
  portable: 'exe',
  AppImage: 'AppImage',
  deb: 'deb',
  rpm: 'rpm',
  'tar.gz': 'tar.gz',
};
/** What each file is, for the picker and the list; the first of each system is its default. */
const KINDS = {
  'mac dmg': ['Disk image (.dmg)', 'Open it and drag API Workbench to Applications.'],
  'mac pkg': ['Installer (.pkg)', 'Installs API Workbench into Applications for you.'],
  'mac zip': ['Archive (.zip)', 'The app in a zip file, as updates download it.'],
  'win nsis': [
    'Installer (.exe)',
    'Lets you choose who it is installed for and where, and adds shortcuts. One installer for x64 and arm64.',
  ],
  'win portable': ['Portable app (.exe)', 'Runs without installing.'],
  'win zip': ['Portable archive (.zip)', 'Unzip it anywhere and run API Workbench.exe.'],
  'linux AppImage': ['AppImage', 'Make it executable, then run it. Updates itself.'],
  'linux deb': ['Debian or Ubuntu package (.deb)', 'sudo apt install ./<file>'],
  'linux rpm': ['Fedora, RHEL, or openSUSE package (.rpm)', 'sudo dnf install ./<file>'],
  'linux tar.gz': [
    'Archive (.tar.gz)',
    'Extract it and run api-workbench. Does not update itself.',
  ],
};
export const SYSTEMS = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
export const ARCHITECTURES = {
  arm64: 'Apple silicon or arm64',
  x64: 'Intel or AMD (x64)',
};

/** electron-builder's name for an architecture in a file of this extension (builder-util's getArtifactArchName). */
export function artifactArch(arch, ext) {
  if (arch === 'x64') {
    if (ext === 'AppImage' || ext === 'rpm' || ext === 'flatpak') return 'x86_64';
    if (ext === 'deb' || ext === 'snap') return 'amd64';
  }
  if (arch === 'arm64' && (ext === 'pacman' || ext === 'rpm' || ext === 'flatpak'))
    return 'aarch64';
  return arch;
}

/**
 * Every installer and package for the release, with `{version}` where the version goes: one entry
 * for each system, architecture, and format. A target whose name has no architecture, such as the
 * Windows installer, is one file listed for each architecture it covers.
 */
export function releaseFiles(build) {
  const files = [];
  for (const os of Object.keys(SYSTEMS)) {
    for (const { target, arch: arches } of build[os].target) {
      const ext = EXTENSIONS[target];
      const template = build[target]?.artifactName ?? build[os].artifactName ?? build.artifactName;
      const [label, detail] = KINDS[`${os} ${target}`];
      for (const arch of arches)
        files.push({
          os,
          arch,
          target,
          label,
          detail,
          name: template
            .replaceAll('${productName}', build.productName)
            .replaceAll('${version}', '{version}')
            .replaceAll('${os}', os)
            .replaceAll('${arch}', artifactArch(arch, ext))
            .replaceAll('${ext}', ext)
            // GitHub does not allow spaces in a file's name, so electron-builder uses dashes.
            .replace(/ /g, '-'),
        });
    }
  }
  return files;
}

/**
 * A release's download URL for a file. `latest` works only for a file whose name has no version,
 * such as the command line: GitHub's latest-release links need the file's exact name.
 */
export function downloadURL(name, version) {
  if (version === 'latest') {
    if (name.includes('{version}')) throw new Error(`${name} needs a version.`);
    return `${RELEASES}/latest/download/${name}`;
  }
  return `${RELEASES}/download/v${version}/${name.replaceAll('{version}', version)}`;
}
/** The released versions the changelog lists, newest first: its `## 1.2.0` headings. */
export function changelogVersions(changelog) {
  return [...changelog.matchAll(/^## v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/gm)].map(
    (match) => match[1],
  );
}

/** The command line, as the picker's last system: one file for every system and architecture. */
export const CLI_ENTRY = {
  os: 'cli',
  arch: 'any',
  target: 'cli',
  label: 'Command line (.cjs)',
  detail: 'One file for every system, which needs only Node.js 22.19 or later.',
  name: CLI_FILE,
};

/** A file's name in a version. */
export const fileName = (name, version) =>
  name.replaceAll('{version}', version === 'latest' ? '' : version);

/** What to type to download a file, check it against the release's SHA256SUMS, and install it. */
export function downloadCommands(file, version, system = file.os) {
  const name = fileName(file.name, version);
  const url = downloadURL(file.name, version);
  const sums = downloadURL('SHA256SUMS', version);
  if (system === 'win')
    return [
      `Invoke-WebRequest '${url}' -OutFile '${name}'`,
      `Invoke-WebRequest '${sums}' -OutFile SHA256SUMS`,
      '# The two lines below print the same hash when the download is intact.',
      `(Get-FileHash '${name}').Hash.ToLower()`,
      `(Select-String -Path SHA256SUMS -SimpleMatch '${name}').Line.Split(' ')[0]`,
      ...(file.target === 'nsis' ? [`.\\${name}`] : []),
    ].join('\n');
  const check =
    system === 'mac'
      ? 'shasum -a 256 --check --ignore-missing SHA256SUMS'
      : system === 'linux'
        ? 'sha256sum --check --ignore-missing SHA256SUMS'
        : 'sha256sum --check --ignore-missing SHA256SUMS   # shasum -a 256 on macOS';
  const install = {
    dmg: `open '${name}'`,
    pkg: `sudo installer -pkg '${name}' -target /`,
    AppImage: `chmod +x '${name}' && './${name}'`,
    deb: `sudo apt install './${name}'`,
    rpm: `sudo dnf install './${name}'`,
    'tar.gz': `tar -xzf '${name}'`,
    cli: `node '${name}' --help`,
  }[file.target];
  return [`curl -fLO '${url}'`, `curl -fLO '${sums}'`, check, ...(install ? [install] : [])].join(
    '\n',
  );
}
