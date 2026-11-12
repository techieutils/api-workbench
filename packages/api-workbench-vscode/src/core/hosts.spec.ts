import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOPBACK, hostArgs, refusedHost, refusedHosts } from './hosts';

test('this computer never asks, and only host names are passed on', () => {
  assert.deepEqual(
    hostArgs([]),
    LOOPBACK.map((host) => `--allow-host=${host}`),
  );
  assert.deepEqual(hostArgs(['api.example.com', 'localhost', 'x y', '--json', '']).slice(3), [
    '--allow-host=api.example.com',
  ]);
});

test('the host a send was refused for is read from the command line', () => {
  assert.equal(
    refusedHost('Not sent: it goes to API.example.com, which --allow-host does not list.'),
    'api.example.com',
  );
  assert.equal(
    refusedHost('Not sent: it goes to [::1], which --allow-host does not list.'),
    '[::1]',
  );
  assert.equal(refusedHost('A request has scripts. Add --allow-scripts to run them.'), undefined);
  assert.equal(
    refusedHost('Not sent: it goes to a/b, which --allow-host does not list.'),
    undefined,
  );
});

test('a run names each host it did not send to, once', () => {
  const refused = (host: string) => ({
    error: `Not sent: it goes to ${host}, which --allow-host does not list.`,
  });
  assert.deepEqual(
    refusedHosts([
      refused('a.test'),
      {},
      { error: 'timeout' },
      refused('b.test'),
      refused('a.test'),
    ]),
    ['a.test', 'b.test'],
  );
  assert.deepEqual(refusedHosts(undefined), []);
});
