import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalLink } from './external-links';

test('web and mail links are external', () => {
  assert.equal(isExternalLink('https://example.com/docs'), true);
  assert.equal(isExternalLink('HTTP://example.com'), true);
  assert.equal(isExternalLink('mailto:team@example.com'), true);
});

test('script, data, file, app, and relative links are not', () => {
  for (const url of [
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<p>x</p>',
    'file:///etc/passwd',
    'vscode://open',
    // Schemes and paths the operating system would hand to a program, or run.
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x&crumb=location:\\\\attacker\\share',
    'smb://attacker/share/setup.exe',
    '\\\\attacker\\share\\setup.exe',
    'C:\\Windows\\System32\\calc.exe',
    'ms-settings:',
    'apiworkbench://open',
    'x-apple.systempreferences:',
    '/relative/path',
    'example.com',
    '',
  ])
    assert.equal(isExternalLink(url), false, url);
});
