import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { allowedHost, hostAllowed, urlHost } from './args';
import { main } from './cli';

/** --allow-host: requests go only to the hosts named, wherever variables and scripts point them. */

test('host names are checked as URLs write them', () => {
  assert.equal(allowedHost(' API.Example.com '), 'api.example.com');
  assert.equal(allowedHost('::1'), '[::1]');
  assert.equal(allowedHost('[::1]'), '[::1]');
  for (const bad of ['https://x.test', 'x.test/path', 'a b', '*', '*.', 'x.test:8080'])
    assert.throws(() => allowedHost(bad), /--allow-host is a host name/, bad);
  assert.ok(hostAllowed('https://api.example.com/a', ['api.example.com']));
  assert.ok(hostAllowed('https://API.example.com/a', ['api.example.com']));
  assert.ok(hostAllowed('https://a.b.example.com/', ['*.example.com']));
  assert.ok(!hostAllowed('https://example.com/', ['*.example.com']));
  assert.ok(!hostAllowed('https://evilexample.com/', ['*.example.com']));
  assert.ok(!hostAllowed('https://api.example.com.evil.test/', ['api.example.com']));
  assert.ok(hostAllowed('http://[::1]:8080/', ['[::1]']));
  assert.ok(!hostAllowed('not a url', ['api.example.com']));
  // Live requests: WebSocket and MQTT URLs, and gRPC's host:port.
  assert.equal(urlHost('wss://Live.example.com/socket'), 'live.example.com');
  assert.equal(urlHost('mqtt://broker.test:1883'), 'broker.test');
  assert.equal(urlHost('localhost:50051'), 'localhost');
  assert.equal(urlHost('[::1]:50051'), '[::1]');
  assert.equal(urlHost(''), undefined);
});

test('a request to a host --allow-host does not name is not sent, wherever it was pointed', async (t) => {
  let received = 0;
  const server = createServer((_request, reply) => {
    received++;
    reply.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-allow-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.http');
  // The host comes from a variable, as in most .http files.
  await fs.writeFile(file, `@host = 127.0.0.1:${port}\n\nGET http://{{host}}/a\n`);
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(
      args,
      { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      {},
      false,
    );
    return { code, text: lines.join('\n') };
  };
  const send = (...extra: string[]) => run(['request', 'send', '1', '--file', file, ...extra]);

  const refused = await send('--allow-host', 'api.example.com');
  assert.equal(refused.code, 2);
  assert.match(refused.text, /Not sent: it goes to 127\.0\.0\.1, which --allow-host does not list/);
  assert.equal(received, 0);

  assert.equal(
    (await send('--allow-host', 'api.example.com', '--allow-host', '127.0.0.1')).code,
    0,
  );
  assert.equal(received, 1);
  // Without the option, nothing changes.
  assert.equal((await send()).code, 0);
  assert.equal(received, 2);
  // A variable given on the command line is resolved first, too.
  const moved = await send('-v', 'host=localhost:1', '--allow-host', '127.0.0.1');
  assert.equal(moved.code, 2);
  assert.match(moved.text, /goes to localhost/);
  // In a run, it is a failed request, and the run goes on.
  const report = path.join(root, 'report.json');
  assert.equal(
    (await run(['run', file, '--allow-host', 'api.example.com', '--report-json', report])).code,
    1,
  );
  const [result] = JSON.parse(await fs.readFile(report, 'utf8')).results;
  assert.match(result.error, /--allow-host does not list/);
  assert.equal(received, 2);
  assert.equal((await send('--allow-host', 'https://127.0.0.1')).code, 2);
});

test('run --list-hosts names where a run would go, for every data row, and sends nothing', async (t) => {
  let received = 0;
  const server = createServer((_request, reply) => {
    received++;
    reply.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-cli-list-hosts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.http');
  await fs.writeFile(
    file,
    [
      '@local = 127.0.0.1:1',
      '',
      '### Local',
      'GET http://{{local}}/a',
      '',
      '### Per row',
      'GET https://{{region}}.Example.com/b',
      '',
      '### From a capture',
      'GET https://{{captured_host}}/c',
      '',
    ].join('\n'),
  );
  const data = path.join(root, 'rows.csv');
  await fs.writeFile(data, 'region\neu\nus\n');
  const lines: string[] = [];
  const code = await main(
    ['run', file, '--list-hosts', '-d', data],
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    {},
    false,
  );
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(JSON.parse(lines.join('\n')), {
    hosts: ['127.0.0.1', 'eu.example.com', 'us.example.com'],
    unresolved: [{ request: 'From a capture', url: 'https://{{captured_host}}/c' }],
  });
  assert.equal(received, 0, 'nothing is sent');
});
