import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import { WorkbenchVault } from '@techieutils/api-workbench-electron/workbench-vault';
import { createTLSFixture } from '@techieutils/api-workbench-electron/testing/tls-fixture';
import type { WorkspaceState } from '@techieutils/api-workbench-common/types';
import { main } from './cli';

/** certificate: client certificates kept in the vault and presented over mutual TLS, and CAs. */

test('a client certificate is added, presented to its host, switched off, and removed', async (t) => {
  const fixture = await createTLSFixture();
  t.after(() => fixture.dispose());
  // A server that answers only a client certificate its own CA signed.
  const server = createServer(
    {
      key: fixture.key,
      cert: fixture.cert,
      ca: fixture.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (incoming, reply) => {
      const peer = (incoming.socket as TLSSocket).getPeerCertificate();
      reply.end(JSON.stringify({ client: peer.subject?.CN ?? null }));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-certificates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(
    {
      requests: [
        {
          id: 'whoami',
          name: 'Who am I',
          method: 'GET',
          url: `https://localhost:${port}/whoami`,
          folder: 'TLS',
          params: [],
          headers: [],
          body: '',
          auth: 'None',
          token: '',
          username: '',
          password: '',
          tests: '',
        },
      ],
      tabs: [],
      active: 'whoami',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'default',
  );
  store.close();
  const password = 'Correct horse 9 battery';
  const vault = new WorkbenchVault(path.join(data, 'vault-key.json'), {
    cost: { N: 1024, r: 8, p: 1 },
  });
  await vault.setup(password);
  vault.lock();
  const env = {
    API_WORKBENCH_DATA_DIR: data,
    API_WORKBENCH_VAULT_PASSWORD: password,
    P12_PASSPHRASE: 'p12-secret',
  };
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      env,
      false,
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const send = async () => run(['request', 'send', 'whoami', '--json']);

  // The server's CA is trusted from a file; without a client certificate the server refuses.
  assert.equal(
    (await run(['certificate', 'trust', path.join(path.dirname(fixture.clientCertPath), 'ca.pem')]))
      .code,
    0,
  );
  const refused = JSON.parse((await send()).out);
  assert.ok(refused.error, 'no certificate, no answer');

  // A passphrase never goes in an argument, and a wrong one is refused before anything is kept.
  const wrong = await run([
    'certificate',
    'add',
    '--host',
    'localhost',
    '--pfx',
    fixture.clientPfxPath,
  ]);
  assert.equal(wrong.code, 2);
  assert.match(
    (
      await run([
        'certificate',
        'add',
        '--host',
        'localhost',
        '--pfx',
        fixture.clientPfxPath,
        '--passphrase',
        'x',
      ])
    ).err,
    /Unknown option --passphrase/,
  );

  const added = await run([
    'certificate',
    'add',
    '--host',
    'localhost',
    '--port',
    String(port),
    '--pfx',
    fixture.clientPfxPath,
    '--passphrase-from-env',
    'P12_PASSPHRASE',
    '--json',
  ]);
  assert.equal(added.code, 0, added.err);
  const row = JSON.parse(added.out);
  assert.equal(row.host, 'localhost');
  assert.equal(row.port, port);
  assert.equal(row.type, 'pfx');
  assert.equal(row.inVault, true);
  assert.match(row.subject, /workbench-client/);

  // Sent with it, and the response says how the time went and what the server's certificate was.
  const sent = await send();
  assert.equal(sent.code, 0, sent.err);
  const answer = JSON.parse(sent.out);
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { client: 'workbench-client' });
  assert.ok(answer.timings.requests[0].phases.some((phase: { id: string }) => phase.id === 'tls'));
  assert.match(answer.tls.chain[0].subject, /localhost/);
  assert.match(answer.tls.clientCertificate.subject, /workbench-client/);

  // Listed, with the CA trusted; nothing secret printed anywhere.
  const listed = JSON.parse((await run(['certificate', 'list', '--json'])).out);
  assert.equal(listed.certificates.length, 1);
  assert.equal(listed.certificates[0].enabled, true);
  assert.match(listed.authorities[0].subject, /API Workbench Test Root/);
  for (const output of [added.out, sent.out, JSON.stringify(listed)])
    assert.ok(!output.includes('p12-secret'), 'the passphrase is never printed');

  // Switched off, it is not presented; on again, it is.
  assert.equal((await run(['certificate', 'disable', `localhost:${port}`])).code, 0);
  assert.ok(JSON.parse((await send()).out).error);
  assert.equal((await run(['certificate', 'enable', row.id])).code, 0);
  assert.equal(JSON.parse((await send()).out).status, 200);

  // Removed, with its key, after confirming; the vault keeps nothing of it.
  assert.equal((await run(['certificate', 'remove', `localhost:${port}`])).code, 2);
  assert.equal((await run(['certificate', 'remove', `localhost:${port}`, '--yes'])).code, 0);
  assert.equal(
    JSON.parse((await run(['certificate', 'list', '--json'])).out).certificates.length,
    0,
  );
  assert.equal(JSON.parse((await run(['secret', 'list', '--json'])).out).length, 0);
  assert.equal((await run(['certificate', 'untrust', '--yes'])).code, 0);
  assert.equal(
    JSON.parse((await run(['certificate', 'list', '--json'])).out).authorities.length,
    0,
  );
});
