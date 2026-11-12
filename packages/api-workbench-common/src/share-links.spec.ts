import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionLink,
  gitRemoteProblem,
  repositoryName,
  withoutCredentials,
} from './share-links';

test('page links on GitHub, GitLab, and Bitbucket become raw file links; gists use the API', () => {
  assert.deepEqual(
    collectionLink('https://github.com/acme/api/blob/main/collections/orders.json#L4'),
    {
      kind: 'file',
      url: 'https://raw.githubusercontent.com/acme/api/main/collections/orders.json',
      name: 'orders.json',
      source: 'https://github.com/acme/api/blob/main/collections/orders.json',
    },
  );
  const urlOf = (link: string) => (collectionLink(link) as { url?: string }).url;
  assert.equal(
    urlOf('https://gitlab.com/acme/group/api/-/blob/v2/specs/openapi.yaml'),
    'https://gitlab.com/acme/group/api/-/raw/v2/specs/openapi.yaml',
  );
  assert.equal(
    urlOf('https://bitbucket.org/acme/api/src/main/shop.postman_collection.json'),
    'https://bitbucket.org/acme/api/raw/main/shop.postman_collection.json',
  );
  for (const link of [
    'https://gist.github.com/ada/0123456789abcdef0123',
    'https://gist.github.com/0123456789abcdef0123',
    'https://gist.github.com/ada/0123456789abcdef0123/raw',
  ])
    assert.deepEqual(
      { ...collectionLink(link), source: '' },
      {
        kind: 'gist',
        id: '0123456789abcdef0123',
        api: 'https://api.github.com/gists/0123456789abcdef0123',
        source: '',
      },
    );
  const plain = collectionLink(' https://example.com/files/shop%20api.yaml?token=x ');
  assert.equal(plain.kind === 'file' && plain.name, 'shop api.yaml');
});

test('collection links must be http(s), without credentials', () => {
  for (const [link, message] of [
    ['', /Enter a link/],
    ['orders.json', /full link/],
    ['file:///etc/passwd', /Only http/],
    ['javascript:alert(1)', /Only http/],
    ['https://ada:secret@example.com/c.json', /user name and password/],
    ['https://gist.github.com/ada', /no gist ID/],
    [`https://example.com/${'a'.repeat(2100)}`, /2,048/],
  ] as const)
    assert.throws(() => collectionLink(link), message);
});

test('Git remote URLs: common forms pass; command transports, options, and tokens do not', () => {
  for (const url of [
    'https://github.com/acme/api.git',
    'https://ada@github.com/acme/api.git',
    'ssh://git@github.com/acme/api.git',
    'git@github.com:acme/api.git',
    'git@gitlab.example.com:group/sub/api.git',
    'file:///srv/git/api.git',
    '/Volumes/team/api.git',
    'C:\\repos\\api.git',
    '\\\\server\\share\\api.git',
  ])
    assert.equal(gitRemoteProblem(url), '', url);
  for (const [url, message] of [
    ['', /Enter the repository/],
    ['ext::sh -c touch% /tmp/pwned', /spaces|not supported/],
    ['ext::sh', /not supported/],
    ['--upload-pack=touch /tmp/x', /spaces|repository URL/],
    ['-uhttps://x', /repository URL/],
    ['https://ada:ghp_secret@github.com/acme/api.git', /token/],
    ['ftp://example.com/api.git', /not supported/],
    ['https://github.com/acme/api.git\nrm', /spaces/],
    ['api.git', /repository URL/],
  ] as const)
    assert.match(gitRemoteProblem(url), message, url);
});

test('credentials are removed from URLs in text, and clones are named after the repository', () => {
  assert.equal(
    withoutCredentials("fatal: unable to access 'https://ada:ghp_x@github.com/acme/api.git/'"),
    "fatal: unable to access 'https://github.com/acme/api.git/'",
  );
  assert.equal(withoutCredentials('git@github.com:acme/api.git'), 'git@github.com:acme/api.git');
  assert.equal(repositoryName('https://github.com/acme/orders-api.git/'), 'orders-api');
  assert.equal(repositoryName('git@github.com:acme/api.git'), 'api');
  assert.equal(repositoryName('C:\\repos\\Team API'), 'Team-API');
  assert.equal(repositoryName('https://x/..'), 'team-workspace');
});
