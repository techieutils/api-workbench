import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certificatesView, hostProblem, portProblem } from './certificates';

test('the Certificates page lists each certificate, its expiry, and the CAs trusted', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const view = certificatesView(
    {
      certificates: [
        {
          id: 'a',
          host: 'api.example.test',
          port: 8443,
          type: 'pfx',
          enabled: false,
          subject: 'CN=client, O=Tests',
          issuer: 'CN=Issuing CA',
          validTo: '2026-11-15T00:00:00Z',
          inVault: true,
        },
        { id: 'b', host: '*.example.test', type: 'pem', enabled: true, inVault: false },
      ],
      authorities: [
        {
          subject: 'CN=Root, O=Tests',
          issuer: 'CN=Root, O=Tests',
          validTo: '2030-01-01T00:00:00.000Z',
          fingerprint256: 'AA',
        },
      ],
    },
    { workspace: 'Shop', canAdd: true },
    now,
  );
  assert.deepEqual(view.certificates[0], {
    id: 'a',
    host: 'api.example.test:8443',
    subject: 'client',
    issuer: 'Issuing CA',
    type: 'PFX',
    enabled: false,
    expiry: 'Expires in 5 days',
    expiryTone: 'warn',
    legacy: false,
  });
  assert.equal(view.certificates[1].subject, 'Subject not read');
  assert.equal(view.certificates[1].legacy, true);
  assert.equal(view.authorities[0].name, 'Root');
  assert.equal(view.authorities[0].validTo, '2030-01-01');
});

test('a certificate’s host and port are checked as they are typed', () => {
  assert.equal(hostProblem('api.example.com'), undefined);
  assert.equal(hostProblem('*.example.com'), undefined);
  assert.equal(hostProblem('https://api.example.com/path'), undefined);
  assert.equal(hostProblem('127.0.0.1'), undefined);
  assert.match(hostProblem('')!, /Give the host/);
  assert.match(hostProblem('not a host')!, /not a host name/);
  assert.equal(portProblem(''), undefined);
  assert.equal(portProblem('8443'), undefined);
  assert.match(portProblem('70000')!, /1 to 65535/);
});
