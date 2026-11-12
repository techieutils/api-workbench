import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRequestFile, isTeamFolder, teamFolderName } from './files';

test('a team folder is found by its workspace.json, and its requests by their id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-vscode-files-'));
  try {
    const team = path.join(root, 'api');
    await mkdir(path.join(team, 'collections/Orders/Refunds'), { recursive: true });
    await writeFile(
      path.join(team, 'workspace.json'),
      JSON.stringify({ storage: 'team', name: 'Shop API' }),
    );
    await writeFile(path.join(team, 'collections/Orders/_collection.yaml'), 'id: order\n');
    await writeFile(
      path.join(team, 'collections/Orders/Get order.yaml'),
      'id: order\nname: Get order\n',
    );
    await writeFile(
      path.join(team, 'collections/Orders/Refunds/Refund.yaml'),
      'id: "r.1+2"\nname: Refund\n',
    );
    await writeFile(
      path.join(root, 'workspace.json'),
      JSON.stringify({ name: 'not a team folder' }),
    );
    await writeFile(path.join(root, 'broken.json'), '{');

    assert.equal(await isTeamFolder(path.join(team, 'workspace.json')), true);
    assert.equal(await isTeamFolder(path.join(root, 'workspace.json')), false);
    assert.equal(await isTeamFolder(path.join(root, 'broken.json')), false);
    assert.equal(await isTeamFolder(path.join(root, 'missing.json')), false);
    assert.equal(await teamFolderName(team), 'Shop API');
    assert.equal(
      await teamFolderName(path.join(team, 'collections')),
      'collections',
      'falls back to the folder name',
    );

    // The collection's own _collection.yaml is not a request, though it holds an id line.
    assert.equal(
      await findRequestFile(team, 'order'),
      path.join(team, 'collections/Orders/Get order.yaml'),
    );
    // Ids are matched exactly, never as patterns.
    assert.equal(
      await findRequestFile(team, 'r.1+2'),
      path.join(team, 'collections/Orders/Refunds/Refund.yaml'),
    );
    assert.equal(await findRequestFile(team, 'r'), undefined);
    assert.equal(await findRequestFile(path.join(root, 'nowhere'), 'order'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
