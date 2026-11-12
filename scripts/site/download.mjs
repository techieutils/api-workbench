// The download picker on the Installation page: it starts from the reader's own system and
// architecture, and makes the link, the commands to check the file, and the list of every file for
// the system, architecture, format, and version chosen. Names come from release-files.mjs, which the
// site build uses too, so the page and its links always agree.
import { SYSTEMS, downloadCommands, downloadURL, fileName } from './release-files.mjs';

const picker = document.querySelector('.download-picker');
if (picker) setUp(picker);

const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const STORE_KEY = 'download-choice';

function remembered() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}
function remember(choice) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(choice));
  } catch {
    /* Remembered for this visit only. */
  }
}

/** The reader's system and architecture, as well as the browser can tell; a guess on macOS. */
async function detect() {
  const agent = navigator.userAgent;
  const os = /Windows/.test(agent)
    ? 'win'
    : /Macintosh|Mac OS X/.test(agent) && !/iPhone|iPad/.test(agent)
      ? 'mac'
      : /Linux|X11|CrOS/.test(agent) && !/Android/.test(agent)
        ? 'linux'
        : undefined;
  let arch;
  // Chromium browsers say the architecture outright when asked.
  try {
    const data = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
    if (data?.architecture) arch = data.architecture === 'arm' ? 'arm64' : 'x64';
  } catch {
    /* Not allowed here: guessed below. */
  }
  if (!arch && /aarch64|arm64|ARM64/.test(agent)) arch = 'arm64';
  // Safari and Firefox report every Mac as Intel. The graphics renderer tells Apple silicon apart.
  if (!arch && os === 'mac') {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      arch = /Intel|AMD|Radeon|NVIDIA/i.test(renderer) ? 'x64' : 'arm64';
    } catch {
      arch = 'arm64';
    }
  }
  return { os, arch: arch ?? 'x64', sure: Boolean(os && arch) };
}

async function setUp(root) {
  const files = JSON.parse(root.dataset.files);
  const versions = JSON.parse(root.dataset.versions);
  const field = (name) => root.querySelector(`[name="${name}"]`);
  const [os, arch, format, version, custom] = [
    'os',
    'arch',
    'format',
    'version',
    'custom-version',
  ].map(field);
  const link = root.querySelector('.download-link');
  const linkFile = root.querySelector('.download-file');
  const detail = root.querySelector('.download-detail');
  const problem = root.querySelector('.download-problem');
  const commands = root.querySelector('.download-commands');
  const detected = root.querySelector('.download-detected');
  const allVersion = root.querySelector('.download-all-version');
  const allRows = root.querySelectorAll('.download-all tr[data-name]');

  const options = (select, list, value) => {
    select.replaceChildren(
      ...list.map(([key, label]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        return option;
      }),
    );
    select.value = list.some(([key]) => key === value) ? value : list[0][0];
  };
  const archLabel = (system, key) =>
    system === 'mac'
      ? { arm64: 'Apple silicon (arm64)', x64: 'Intel (x64)' }[key]
      : { arm64: 'arm64', x64: 'x64 (Intel or AMD)' }[key];

  options(os, [...Object.entries(SYSTEMS), ['cli', 'Command line (any system)']], undefined);

  /**
   * The list of every file, written by the site build: each row's link moves to the chosen
   * version, and the file the picker chose is marked.
   */
  function renderAll(chosen, file) {
    allVersion.textContent = chosen;
    for (const row of allRows) {
      const name = row.dataset.name;
      const anchor = row.querySelector('a');
      const code = anchor.querySelector('code');
      // "latest" names the newest release, whose versioned file names only the release knows.
      const known = !(chosen === 'latest' && name.includes('{version}'));
      anchor.toggleAttribute('aria-disabled', !known);
      if (known) anchor.href = downloadURL(name, chosen);
      else anchor.removeAttribute('href');
      code.textContent = known ? fileName(name, chosen) : fileName(name, '<version>');
      const chosenRow =
        file &&
        row.dataset.os === file.os &&
        row.dataset.target === file.target &&
        (file.os === 'cli' || row.dataset.arch.split(' ').includes(arch.value));
      row.classList.toggle('is-chosen', Boolean(chosenRow));
      if (chosenRow) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }

  function update(save = true) {
    const system = os.value;
    const cli = system === 'cli';
    arch.disabled = cli;
    if (cli) options(arch, [['any', 'Any']], 'any');
    else
      options(
        arch,
        ['arm64', 'x64'].map((key) => [key, archLabel(system, key)]),
        arch.value,
      );
    const formats = files.filter((file) => file.os === system && (cli || file.arch === arch.value));
    options(
      format,
      formats.map((file) => [file.target, file.label]),
      format.value,
    );
    // The newest release has a link of its own only for the command line, whose name has no version.
    options(
      version,
      [
        ...(cli ? [['latest', 'Latest release']] : []),
        ...versions.map((item) => [item, item]),
        ['other', 'Another version…'],
      ],
      version.value,
    );
    custom.hidden = version.value !== 'other';
    const chosenVersion =
      version.value === 'other' ? custom.value.trim().replace(/^v/, '') : version.value;
    const file = formats.find((item) => item.target === format.value);
    const valid = chosenVersion === 'latest' || VERSION.test(chosenVersion);
    // An empty box is still being filled in: the link waits, without a message yet.
    problem.hidden = valid || !chosenVersion;
    link.toggleAttribute('aria-disabled', !valid);
    if (!valid) {
      problem.textContent = 'Enter a version such as 1.2.0, as listed on the releases page.';
      link.removeAttribute('href');
      linkFile.textContent = fileName(file.name, '<version>');
      commands.textContent = '# Enter a version above for its download and checksum commands.';
      return;
    }
    link.href = downloadURL(file.name, chosenVersion);
    linkFile.textContent = fileName(file.name, chosenVersion);
    detail.textContent = `${cli ? 'Any system' : `${SYSTEMS[system]}, ${archLabel(system, arch.value)}`} · ${file.label}. ${file.detail}`;
    commands.textContent = downloadCommands(file, chosenVersion);
    renderAll(chosenVersion, file);
    if (save)
      remember({
        os: system,
        arch: arch.value,
        format: format.value,
        version: version.value,
        custom: custom.value,
      });
  }

  const saved = remembered();
  const guess = await detect();
  const start = saved ?? { os: guess.os ?? 'mac', arch: guess.arch };
  os.value = start.os in SYSTEMS || start.os === 'cli' ? start.os : 'mac';
  options(
    arch,
    [
      ['arm64', ''],
      ['x64', ''],
    ],
    start.arch,
  );
  update(false);
  if (saved?.format) format.value = saved.format;
  if (saved?.version) version.value = saved.version;
  if (saved?.custom) custom.value = saved.custom;
  update(false);
  if (!saved && guess.os)
    detected.textContent = `Detected ${SYSTEMS[guess.os]}, ${archLabel(guess.os, guess.arch)}${guess.sure ? '' : ' (best guess)'}`;
  else detected.textContent = saved ? 'Your last choice' : 'Choose your system';
  for (const select of [os, arch, format, version])
    select.addEventListener('change', () => update());
  custom.addEventListener('input', () => update());
  root.querySelector('.download-fields').hidden = false;
}
