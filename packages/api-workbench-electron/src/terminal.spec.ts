import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalEvent } from '@techieutils/api-workbench-common/types';
import { availableShells, defaultShell, terminalEnvironment, TerminalSessions } from './terminal';

test('the terminal uses the login shell, or the platform default', () => {
  assert.deepEqual(defaultShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }), {
    file: '/opt/homebrew/bin/fish',
    args: ['-l'],
  });
  assert.equal(defaultShell('darwin', {}).file, '/bin/zsh');
  assert.equal(defaultShell('linux', {}).file, '/bin/bash');
  assert.equal(defaultShell('win32', { SHELL: '/bin/zsh' }).file, 'powershell.exe');
});

test('shells are found per platform, with the login shell as the default', () => {
  const files =
    (...paths: string[]) =>
    (file: string) =>
      paths.includes(file);
  const mac = availableShells(
    'darwin',
    { SHELL: '/bin/zsh' },
    files('/bin/zsh', '/bin/bash', '/bin/sh', '/opt/homebrew/bin/fish'),
  );
  assert.deepEqual(
    mac.map((shell) => [shell.id, shell.path, shell.default === true]),
    [
      ['zsh', '/bin/zsh', true],
      ['bash', '/bin/bash', false],
      ['sh', '/bin/sh', false],
      ['fish', '/opt/homebrew/bin/fish', false],
    ],
  );
  assert.deepEqual(mac[0].args, ['-l']);
  const linux = availableShells(
    'linux',
    { PATH: '/usr/bin' },
    files('/bin/bash', '/bin/sh', '/usr/bin/zsh'),
  );
  assert.deepEqual(
    linux.map((shell) => [shell.id, shell.default === true]),
    [
      ['zsh', false],
      ['bash', true],
      ['sh', false],
    ],
    'without SHELL, Linux defaults to bash',
  );
  const windows = availableShells(
    'win32',
    {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      Path: 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32',
      ProgramFiles: 'C:\\Program Files',
    },
    files(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ),
  );
  assert.deepEqual(
    windows.map((shell) => [shell.id, shell.label, shell.default === true]),
    [
      ['powershell', 'Windows PowerShell', true],
      ['pwsh', 'PowerShell 7', false],
      ['cmd', 'Command Prompt', false],
      ['git-bash', 'Git Bash', false],
      ['wsl', 'WSL', false],
    ],
  );
  assert.deepEqual(
    availableShells('win32', {}, files()).map((shell) => shell.id),
    ['powershell', 'cmd'],
    'PowerShell and Command Prompt are always there on Windows',
  );
});

test('only a listed shell can be started', () => {
  const sessions = new TerminalSessions(() => {});
  assert.throws(() => sessions.start(1, {}, '/usr/bin/evil'), /not available/);
  assert.throws(() => sessions.start(1, {}, 42), /Invalid shell/);
  assert.ok(sessions.shells().some((shell) => shell.default));
});

test("the terminal's environment drops Electron's switches and declares colour", () => {
  const env = terminalEnvironment({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
});

test(
  'terminal sessions run commands, belong to their renderer, and end',
  { skip: process.platform === 'win32' },
  async () => {
    const events: TerminalEvent[] = [];
    const sessions = new TerminalSessions((owner, event) => {
      assert.equal(owner, 7);
      events.push(event);
    });
    const session = sessions.start(7, { cols: 80, rows: 24 });
    try {
      assert.throws(() => sessions.write(8, session.id, 'exit\r'), /ended/);
      assert.throws(() => sessions.write(7, session.id, 42), /Invalid input/);
      sessions.write(7, session.id, 'echo terminal-$((6*7)); exit\r');
      const deadline = Date.now() + 15_000;
      while (!events.some((event) => event.type === 'exit') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const output = events.map((event) => (event.type === 'data' ? event.data : '')).join('');
      assert.match(output, /terminal-42/);
      assert.ok(events.some((event) => event.type === 'exit' && event.id === session.id));
      assert.throws(() => sessions.write(7, session.id, 'ls\r'), /ended/);
    } finally {
      await sessions.stopAll();
    }
  },
);

test(
  'stopping all terminals waits until every shell has exited',
  { skip: process.platform === 'win32' },
  async () => {
    const exits: string[] = [];
    const sessions = new TerminalSessions((_, event) => {
      if (event.type === 'exit') exits.push(event.id);
    });
    const first = sessions.start(1, { cols: 80, rows: 24 });
    const second = sessions.start(1, { cols: 80, rows: 24 });
    assert.equal(sessions.size, 2);
    await sessions.stopAll();
    assert.equal(sessions.size, 0);
    assert.deepEqual(exits.sort(), [first.id, second.id].sort());
    assert.throws(() => sessions.write(1, first.id, 'ls\r'), /ended/);
  },
);
