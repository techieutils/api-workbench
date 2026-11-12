import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_ITEMS, HELP_PAGES, diagnostics } from './support';

test('diagnostics say versions and counts, never paths or names', () => {
  const text = diagnostics({
    extensionVersion: '1.2.0',
    vscodeVersion: '1.109.0',
    appName: 'Visual Studio Code',
    platform: 'darwin',
    arch: 'arm64',
    engine: 'builtIn',
    cliVersion: '1.2.0',
    remote: 'ssh-remote+my.secret.host',
    uiKind: 'desktop',
    teamFolders: 1,
    appWorkspaces: 3,
  });
  assert.equal(
    text,
    [
      'API Workbench for VS Code 1.2.0',
      'Visual Studio Code 1.109.0 (desktop, remote: ssh-remote)',
      'Platform: darwin arm64',
      'Engine: built in, command line 1.2.0',
      'Open: 1 team folder, 3 app workspaces',
    ].join('\n'),
  );
  assert.doesNotMatch(text, /[/\\]Users|https?:|secret/);
});

test('every help entry has a command, and every page command a page', () => {
  for (const item of HELP_ITEMS) assert.match(item.command, /^apiWorkbench\./);
  for (const url of Object.values(HELP_PAGES)) assert.match(url, /^https:\/\//);
});
