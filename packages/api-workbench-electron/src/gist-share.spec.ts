import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CredentialRecord } from '@techieutils/api-workbench-common/types';
import { checkedGistInput, gistAPI, publishGist } from './gist-share';

/** Publishing exports as gists, against a stand-in for GitHub's API. */

const token = 'TEST-GITHUB-TOKEN';
const record = (extra: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id: 'github',
  name: 'GitHub',
  kind: 'bearer',
  allowedOrigin: 'https://api.github.com',
  secret: token,
  updatedAt: '',
  ...extra,
});
const input = checkedGistInput({
  credentialId: 'github',
  files: [{ name: 'shop.postman_collection.json', content: '{"info":{"name":"Shop"}}' }],
  description: '  Shop API  ',
  public: false,
});

function github(
  status = 201,
  body: unknown = { id: 'abc123', html_url: 'https://gist.github.com/ada/abc123', public: false },
) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    [];
  const fake = (async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  }) as unknown as Parameters<typeof publishGist>[2];
  return { calls, fake };
}

test('creates a secret gist with the token sent only to GitHub, and updates one by ID', async () => {
  const created = github();
  assert.deepEqual(await publishGist(input, record(), created.fake), {
    id: 'abc123',
    url: 'https://gist.github.com/ada/abc123',
    public: false,
    updated: false,
  });
  assert.equal(created.calls[0].url, 'https://api.github.com/gists');
  assert.equal(created.calls[0].method, 'POST');
  assert.equal(created.calls[0].headers.authorization, `Bearer ${token}`);
  assert.deepEqual(created.calls[0].body, {
    description: 'Shop API',
    public: false,
    files: { 'shop.postman_collection.json': { content: '{"info":{"name":"Shop"}}' } },
  });

  const updated = github(200);
  const result = await publishGist(
    { ...input, gistId: '0123456789abcdef0123' },
    record(),
    updated.fake,
  );
  assert.equal(result.updated, true);
  assert.equal(updated.calls[0].url, 'https://api.github.com/gists/0123456789abcdef0123');
  assert.equal(updated.calls[0].method, 'PATCH');
  assert.ok(!('public' in (updated.calls[0].body as object)), 'visibility is fixed at creation');
});

test('GitHub Enterprise Server tokens use the server’s /api/v3', async () => {
  assert.equal(gistAPI('https://github.example.com'), 'https://github.example.com/api/v3');
  const enterprise = github();
  await publishGist(
    input,
    record({ allowedOrigin: 'https://github.example.com' }),
    enterprise.fake,
  );
  assert.equal(enterprise.calls[0].url, 'https://github.example.com/api/v3/gists');
  assert.throws(() => gistAPI('http://github.example.com'), /https:\/\//);
});

test('wrong credentials, GitHub refusals, and a token inside the export fail with a reason', async () => {
  await assert.rejects(
    publishGist(input, record({ kind: 'basic' }), github().fake),
    /Bearer token/,
  );
  await assert.rejects(
    publishGist(
      { ...input, files: [{ name: 'leak.json', content: `{"token":"${token}"}` }] },
      record(),
      github().fake,
    ),
    /contains the GitHub token/,
  );
  await assert.rejects(publishGist(input, record(), github(401, {}).fake), /refused the token/);
  await assert.rejects(publishGist(input, record(), github(403, {}).fake), /“gist” scope/);
  await assert.rejects(
    publishGist({ ...input, gistId: '0123456789abcdef0123' }, record(), github(404, {}).fake),
    /not found, or it belongs to another account/,
  );
  await assert.rejects(
    publishGist(input, record(), github(422, { message: 'Validation Failed' }).fake),
    /did not accept the gist: Validation Failed/,
  );
});

test('the app’s input is checked before the vault is read', () => {
  for (const [value, message] of [
    [{}, /Choose a GitHub token/],
    [{ credentialId: 'x', files: [] }, /1 to 20 files/],
    [{ credentialId: 'x', files: [{ name: '../x', content: 'a' }] }, /without slashes/],
    [{ credentialId: 'x', files: [{ name: 'a', content: '' }] }, /empty/],
    [
      {
        credentialId: 'x',
        files: [
          { name: 'a', content: '1' },
          { name: 'a', content: '2' },
        ],
      },
      /its own name/,
    ],
    [{ credentialId: 'x', files: [{ name: 'a', content: '1' }], gistId: 'nope' }, /not a gist ID/],
    [{ credentialId: 'x', files: [{ name: 'a', content: 'x'.repeat(11 * 1024 * 1024) }] }, /10 MB/],
  ] as const)
    assert.throws(() => checkedGistInput(value), message);
  assert.equal(checkedGistInput({ ...input, public: 'yes' }).public, false, 'only true is public');
});
