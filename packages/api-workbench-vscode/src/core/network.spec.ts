import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certificateView, expiry, timingView } from './network';

test('timing shows each hop’s phases on one axis, with why some are missing', () => {
  const view = timingView({
    startedAt: '2026-11-10T10:00:00.000Z',
    totalMs: 200,
    preparationMs: 1.5,
    requests: [
      {
        method: 'GET',
        url: 'http://example.test/old',
        status: 301,
        startMs: 0,
        durationMs: 50,
        connectionReused: false,
        phases: [{ id: 'waiting', label: 'Waiting for server', startMs: 0, durationMs: 50 }],
      },
      {
        method: 'GET',
        url: 'https://example.test/new',
        status: 200,
        startMs: 50,
        durationMs: 150,
        connectionReused: true,
        phases: [
          { id: 'waiting', label: 'Waiting for server', startMs: 50, durationMs: 100 },
          { id: 'download', label: 'Content download', startMs: 150, durationMs: 0.01 },
        ],
      },
    ],
  })!;
  assert.equal(view.total, '200 ms');
  assert.deepEqual(view.axis, ['0 ms', '100 ms', '200 ms']);
  assert.equal(view.preparation, '1.50 ms');
  assert.equal(view.hops[0].title, '#1 · GET http://example.test/old');
  assert.equal(view.hops[0].note, 'TLS is not used for HTTP.');
  assert.match(view.hops[1].note!, /Reused connection/);
  assert.deepEqual(
    view.hops[1].phases.map(({ left, width }) => [left, width]),
    [
      [25, 50],
      [75, 0.5],
    ],
    'a tiny phase is still visible',
  );
  assert.equal(timingView(undefined), undefined);
});

test('a certificate says how long it is valid, and the chain names each one', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  assert.deepEqual(expiry('2027-11-10T00:00:00Z', now), {
    label: 'Valid for 365 days',
    tone: 'good',
  });
  assert.deepEqual(expiry('2026-11-20T00:00:00Z', now), {
    label: 'Expires in 10 days',
    tone: 'warn',
  });
  assert.deepEqual(expiry('2026-11-01T00:00:00Z', now), { label: 'Expired', tone: 'bad' });
  const view = certificateView(
    {
      host: 'api.example.test',
      port: 443,
      capturedAt: '',
      authorized: false,
      authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
      protocol: 'TLSv1.3',
      cipher: { name: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' },
      alpnProtocol: 'h2',
      clientCertificate: { subject: 'CN=client' },
      chain: [
        {
          subject: 'CN=api.example.test, O=Example',
          issuer: 'CN=Example Root',
          validFrom: 'Nov  1 00:00:00 2026 GMT',
          validTo: 'Nov 20 00:00:00 2026 GMT',
          serialNumber: '01',
          subjectAltName: 'DNS:api.example.test',
          fingerprint: '',
          fingerprint256: 'AA:BB',
          fingerprint512: '',
          publicKeyType: 'ec',
          keyBits: 256,
          ca: false,
          pem: '-----BEGIN CERTIFICATE-----',
        },
      ],
    },
    now,
  )!;
  assert.equal(view.host, 'api.example.test:443');
  assert.equal(view.verified, false);
  assert.equal(view.verifyError, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(view.client?.subject, 'CN=client');
  assert.equal(view.chain[0].name, 'api.example.test');
  assert.equal(view.chain[0].validTo, '2026-11-20');
  assert.equal(view.chain[0].expiry, 'Expires in 10 days');
  assert.equal(view.chain[0].key, 'EC · 256 bits');
  assert.ok(!JSON.stringify(view).includes('BEGIN CERTIFICATE'), 'no PEM text goes to the page');
});
