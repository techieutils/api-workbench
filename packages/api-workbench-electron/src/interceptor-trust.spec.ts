import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuthority } from './interceptor-ca';
import {
  thumbprint,
  TrustedAuthorities,
  trustCommands,
  untrustCommands,
} from './interceptor-trust';

const keychain = '/Users/someone/Library/Keychains/login.keychain-db';

test('trusting and untrusting a CA use fixed commands that name it exactly', () => {
  const { certPem } = createAuthority();
  const sha1 = new X509Certificate(certPem).fingerprint.replaceAll(':', '');
  assert.equal(thumbprint(certPem), sha1);
  assert.match(sha1, /^[0-9A-F]{40}$/);
  assert.deepEqual(trustCommands('darwin', '/ca.crt', keychain), [
    {
      command: 'security',
      args: ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, '/ca.crt'],
    },
  ]);
  assert.deepEqual(trustCommands('win32', 'C:\\ca.crt', keychain), [
    { command: 'certutil', args: ['-user', '-addstore', 'Root', 'C:\\ca.crt'] },
  ]);
  // macOS keeps trust apart from the certificate, so both go, trust first.
  assert.deepEqual(untrustCommands('darwin', '/ca.crt', certPem, keychain), [
    { command: 'security', args: ['remove-trusted-cert', '/ca.crt'] },
    { command: 'security', args: ['delete-certificate', '-Z', sha1, keychain] },
  ]);
  assert.deepEqual(untrustCommands('win32', 'C:\\ca.crt', certPem, keychain), [
    { command: 'certutil', args: ['-user', '-delstore', 'Root', sha1] },
  ]);
  assert.equal(trustCommands('linux', '/ca.crt', keychain), undefined);
  assert.equal(untrustCommands('linux', '/ca.crt', certPem, keychain), undefined);
});

test('the app remembers which CAs it trusted, so a replaced one can be removed', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-trust-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'trusted.json');
  const first = createAuthority().certPem;
  const second = createAuthority().certPem;
  const trusted = new TrustedAuthorities(file);
  assert.equal(await trusted.has(first), false, 'nothing is trusted at first');
  await trusted.add(first);
  await trusted.add(first);
  assert.equal(await trusted.has(first), true);
  assert.equal(await trusted.has(second), false, 'another CA is not mistaken for it');
  // Fingerprints, not certificates or keys, are written down.
  const saved = JSON.parse(await readFile(file, 'utf8')) as { trusted: string[] };
  assert.equal(saved.trusted.length, 1);
  assert.match(saved.trusted[0], /^[0-9A-F]{64}$/);
  await trusted.remove(first);
  assert.equal(await trusted.has(first), false);
  // A damaged list trusts nothing rather than failing.
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, '{oops'));
  assert.equal(await new TrustedAuthorities(file).has(first), false);
});
