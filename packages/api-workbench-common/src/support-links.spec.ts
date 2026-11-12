import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GUIDES,
  SUPPORT_LINKS,
  bugReportUrl,
  guideUrl,
  isGuideName,
  featureRequestUrl,
  issueSearchUrl,
  osName,
} from './support-links';

const root = path.resolve(__dirname, '../../..');

test('a bug report opens the issue form with what is known filled in', () => {
  const url = new URL(
    bugReportUrl({
      version: 'VS Code extension 1.2.0',
      platform: 'darwin',
      details: 'VS Code 1.109.0',
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    'https://github.com/techieutils/api-workbench/issues/new',
  );
  assert.equal(url.searchParams.get('template'), 'bug_report.yml');
  assert.equal(url.searchParams.get('version'), 'VS Code extension 1.2.0');
  assert.equal(url.searchParams.get('os'), 'macOS');
  assert.equal(url.searchParams.get('extra'), 'VS Code 1.109.0');
  // Very long details are cut, so the address still opens.
  const long = new URL(
    bugReportUrl({ version: '1', platform: 'linux', details: 'x'.repeat(10000) }),
  );
  assert.ok(long.searchParams.get('extra')!.length < 1600);
  assert.deepEqual(['win32', 'Win32', 'MacIntel', 'Linux x86_64', 'freebsd'].map(osName), [
    'Windows',
    'Windows',
    'macOS',
    'Linux',
    'Linux',
  ]);
});

test('the forms and fields filled in are the repository’s own', () => {
  // Field ids in the links must match the issue forms, or GitHub ignores them.
  const bug = readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');
  for (const id of ['version', 'os', 'extra']) assert.match(bug, new RegExp(`id: ${id}\\b`));
  assert.match(bug, /options: \[macOS, Windows, Linux\]/);
  const feature = readFileSync(
    path.join(root, '.github/ISSUE_TEMPLATE/feature_request.yml'),
    'utf8',
  );
  assert.match(feature, /id: problem\b/);
  assert.equal(new URL(featureRequestUrl({ problem: 'p' })).searchParams.get('problem'), 'p');
  // The security link is the one the issue chooser itself points to.
  const config = readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');
  assert.ok(config.includes(SUPPORT_LINKS.security));
  // Each documentation page linked to is in the docs.
  for (const page of ['index', 'troubleshooting', 'faq', 'changelog', 'vscode'])
    assert.ok(
      readFileSync(path.join(root, 'docs', `${page === 'index' ? 'README' : page}.md`), 'utf8'),
      page,
    );
  assert.match(issueSearchUrl('mock port'), /issues\?q=is%3Aissue\+mock\+port$/);
});

test('every guide a screen links to is a page in the docs', () => {
  for (const [name, page] of Object.entries(GUIDES)) {
    assert.ok(readFileSync(path.join(root, 'docs', `${page}.md`), 'utf8'), name);
    assert.ok(isGuideName(name));
  }
  assert.equal(
    guideUrl('mocks'),
    'https://techieutils.github.io/api-workbench/docs/mock-servers.html',
  );
  // Only the fixed names are guides: nothing from a page or the prototype chain.
  for (const name of ['toString', '__proto__', '../faq', 'https://example.com', 7, undefined])
    assert.equal(isGuideName(name), false, String(name));
});
