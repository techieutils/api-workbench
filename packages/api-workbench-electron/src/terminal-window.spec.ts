import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STAGED, dockBounds, stagedCommand, terminalPreferences } from './terminal-window';

test('a staged command can never press Enter or rewrite the line', () => {
  assert.equal(
    stagedCommand('  grpcurl -plaintext localhost:50051 list  '),
    'grpcurl -plaintext localhost:50051 list',
  );
  // Line breaks, carriage returns, escape sequences, and tabs become spaces.
  assert.equal(stagedCommand('ls\nrm -rf ~\r'), 'ls rm -rf ~');
  assert.equal(stagedCommand('echo \u001b[2Jhi\u0003'), 'echo  [2Jhi');
  assert.equal(stagedCommand('a\tb c\u0085d'), 'a b c d');
  assert.equal(stagedCommand('\n\r\t'), undefined);
  for (const value of [undefined, 42, { text: 'ls' }, ['ls']])
    assert.equal(stagedCommand(value), undefined);
  assert.equal(stagedCommand('x'.repeat(MAX_STAGED + 50))?.length, MAX_STAGED);
});

test('only a shell this computer has is kept as the default', () => {
  assert.deepEqual(terminalPreferences({ defaultShell: 'bash' }, ['zsh', 'bash']), {
    defaultShell: 'bash',
  });
  for (const saved of [{ defaultShell: '/bin/evil' }, { defaultShell: 3 }, null, 'bash', {}])
    assert.deepEqual(terminalPreferences(saved, ['zsh', 'bash']), {}, JSON.stringify(saved));
});

test('the docked terminal goes only where it fits in the window, in whole pixels', () => {
  const window = { width: 1440, height: 960 };
  assert.deepEqual(dockBounds({ x: 72.4, y: 700.6, width: 1368, height: 260 }, window), {
    x: 72,
    y: 701,
    width: 1368,
    height: 259,
  });
  // Clipped to the window: it never covers anything outside it.
  assert.deepEqual(dockBounds({ x: -50, y: 900, width: 3000, height: 500 }, window), {
    x: 0,
    y: 900,
    width: 1440,
    height: 60,
  });
  // Too small to use, off the window, or not numbers: hidden.
  for (const value of [
    null,
    'x',
    { x: 0, y: 0, width: 20, height: 400 },
    { x: 2000, y: 0, width: 300, height: 300 },
    { x: 0, y: 0, width: Infinity, height: 300 },
    { x: '0', y: 0, width: 300, height: 300 },
  ])
    assert.equal(dockBounds(value, window), undefined, JSON.stringify(value));
});
