import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseText } from '@techieutils/api-workbench-common/collection-transfer';
import { run } from '@techieutils/api-workbench-common/assertions';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { sendHttpRequest } from '@techieutils/api-workbench-electron/http';
import { closeHTTPTransports } from '@techieutils/api-workbench-electron/http-transport';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';

// End-to-end flows through several packages, the way the app runs them: common parses and checks,
// the main process sends and stores.

/** A local API that echoes what it received as JSON. */
async function echoServer(t: { after(callback: () => Promise<void>): void }) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ method: request.method, team: request.headers['x-team'], body }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await closeHTTPTransports();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a pasted cURL command imports, sends, and passes its response tests', async (t) => {
  const origin = await echoServer(t);
  const imported = parseText(`curl -X POST ${origin}/items -H 'X-Team: api' -d '{"name":"one"}'`);
  assert.equal(imported.format, 'cURL');
  const [request] = imported.data.requests;

  const headers = Object.fromEntries(
    request.headers!.filter((header) => header.enabled).map(({ key, value }) => [key, value]),
  );
  const response = await sendHttpRequest(
    { id: 'flow', url: request.url!, method: request.method!, headers, body: request.body ?? '' },
    new AbortController(),
  );
  if (response.error !== undefined) throw new Error(response.error);

  const results = run(
    ['status 200', 'json $.method equals "POST"', 'json $.team equals "api"'].join('\n'),
    response,
  );
  assert.deepEqual(
    results.filter((result) => !result.pass),
    [],
  );
  assert.equal(JSON.parse(response.body).body, '{"name":"one"}');
});

test('an imported request survives a save and a restart of the workspace store', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [imported] = parseText("curl https://api.example.com/users -H 'Accept: application/json'")
    .data.requests;
  const request = { ...imported, id: 'users', response: null } as ApiRequest;
  const state: WorkspaceState = {
    requests: [request],
    active: request.id,
    tabs: [request.id],
    environments: [{ name: 'Default', variables: [] }],
    environment: 0,
    history: [],
  };

  await new WorkspaceStore(directory).save(state);
  // A new store reads only what is on disk, as the app does when it starts again.
  const reloaded = await new WorkspaceStore(directory).load();
  assert.deepEqual(reloaded, state);
});
