import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleTagFilter,
  describeTagFilter,
  prunedTagFilter,
  tagFilterState,
  effectiveTags,
  inheritedTags,
  normalizedFolderTags,
  matchesTags,
  normalizedTags,
  parseTags,
  tagCounts,
  tagProblem,
} from './tags';

test('a tag is a short word without spaces, once per request whatever its case', () => {
  for (const tag of ['smoke', 'auth', 'v2', 'team:payments', 'api/v1', 'p0_critical', 'état'])
    assert.equal(tagProblem(tag), undefined, tag);
  assert.match(tagProblem('two words')!, /no spaces/);
  assert.match(tagProblem('-dash')!, /Start with a letter/);
  assert.match(tagProblem('x'.repeat(41))!, /40 characters/);
  assert.match(tagProblem('Smoke', ['smoke'])!, /already tagged/);
  assert.match(
    tagProblem(
      'a',
      Array.from({ length: 20 }, (_, i) => `t${i}`),
    )!,
    /up to 20/,
  );
});

test('tags from a file keep valid ones in order; typed tags split on commas and spaces', () => {
  assert.deepEqual(normalizedTags(['smoke', ' #auth ', 'Smoke', 'bad tag', 3, '']), [
    'smoke',
    'auth',
  ]);
  assert.equal(normalizedTags('smoke'), undefined);
  assert.equal(normalizedTags([]), undefined);
  assert.deepEqual(parseTags(' #smoke, auth  slow,'), ['smoke', 'auth', 'slow']);
});

test('a filter includes any or all of its tags and leaves out excluded ones, ignoring case', () => {
  const any = { include: ['smoke', 'auth'], mode: 'any' as const, exclude: ['slow'] };
  assert.equal(matchesTags(['Smoke'], any), true);
  assert.equal(matchesTags(['auth', 'SLOW'], any), false, 'excluded wins');
  assert.equal(matchesTags(['other'], any), false);
  assert.equal(matchesTags(undefined, any), false);
  const all = { ...any, mode: 'all' as const };
  assert.equal(matchesTags(['smoke'], all), false);
  assert.equal(matchesTags(['auth', 'smoke'], all), true);
  const exclusion = { include: [], mode: 'any' as const, exclude: ['slow'] };
  assert.equal(matchesTags(undefined, exclusion), true, 'only exclusions keep untagged requests');
  assert.equal(matchesTags(['slow'], exclusion), false);
  assert.equal(matchesTags(['anything']), true);
  assert.equal(describeTagFilter(any), 'smoke or auth, not slow');
  assert.equal(describeTagFilter(all), 'smoke and auth, not slow');
  assert.equal(describeTagFilter(exclusion), 'not slow');
});

test('tags are counted across requests, spelled as first seen, in name order', () => {
  assert.deepEqual(
    tagCounts([{ tags: ['smoke', 'Auth'] }, { tags: ['auth'] }, {}, { tags: ['beta'] }]),
    [
      { tag: 'Auth', count: 2 },
      { tag: 'beta', count: 1 },
      { tag: 'smoke', count: 1 },
    ],
  );
});

test('requests have their collection and folder tags, outermost first, without repeats', () => {
  const workspace = {
    collectionTags: { Shop: ['api', 'Smoke'], 'Shop/Orders': ['orders', 'api'], Other: ['x'] },
  };
  assert.deepEqual(inheritedTags(workspace, 'Shop/Orders/Refunds'), [
    { tag: 'api', from: 'Shop' },
    { tag: 'Smoke', from: 'Shop' },
    { tag: 'orders', from: 'Shop/Orders' },
  ]);
  assert.deepEqual(effectiveTags(workspace, { folder: 'Shop/Orders', tags: ['smoke', 'write'] }), [
    'api',
    'Smoke',
    'orders',
    'write',
  ]);
  assert.deepEqual(effectiveTags({}, { folder: 'Shop', tags: ['a'] }), ['a']);
  assert.deepEqual(normalizedFolderTags({ Shop: ['ok', 'bad tag'], '': ['x'], Empty: [] }), {
    Shop: ['ok'],
  });
  assert.equal(normalizedFolderTags(['Shop']), undefined);
});

test('clicking a tag requires it, then leaves it out, then stops using it', () => {
  const start = { include: [], mode: 'all' as const, exclude: [] };
  const once = cycleTagFilter(start, 'smoke');
  assert.deepEqual(once, { include: ['smoke'], mode: 'all', exclude: [] });
  assert.equal(tagFilterState(once, 'SMOKE'), 'include');
  const twice = cycleTagFilter(once, 'Smoke');
  assert.deepEqual(twice, { include: [], mode: 'all', exclude: ['Smoke'] });
  assert.equal(tagFilterState(twice, 'smoke'), 'exclude');
  assert.deepEqual(cycleTagFilter(twice, 'smoke'), start);
  assert.equal(tagFilterState(start, 'smoke'), 'off');
  assert.deepEqual(
    prunedTagFilter({ include: ['gone', 'Smoke'], mode: 'any', exclude: ['old'] }, ['smoke']),
    { include: ['Smoke'], mode: 'any', exclude: [] },
  );
});

test('collections named after Object built-ins have only their own tags', () => {
  // A lookup by folder path once found Object's built-ins ("constructor" is a function) and threw.
  const workspace = { collectionTags: { Users: ['users'] } };
  for (const folder of ['constructor', 'toString', '__proto__', 'hasOwnProperty/inner'])
    assert.deepEqual(effectiveTags(workspace, { folder, tags: ['own'] }), ['own']);
  const read = normalizedFolderTags(
    JSON.parse('{"__proto__": ["proto"], "constructor": ["built-in"], "Users": ["users"]}'),
  );
  // Kept as ordinary entries, not as the object's prototype.
  assert.deepEqual(Object.keys(read ?? {}), ['__proto__', 'constructor', 'Users']);
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.deepEqual(effectiveTags({ collectionTags: read }, { folder: '__proto__/inner' }), [
    'proto',
  ]);
});
