import { describe, expect, it } from 'vitest';
import { useDialogsStore } from './dialogs';
import { request, workspaceWith } from '../test/workspace';

function tagged() {
  return workspaceWith(
    [
      request('List users', 'Users', { tags: ['smoke'] }),
      request('Delete user', 'Users/Admin', { tags: ['destructive'] }),
      request('Health', 'Ops'),
    ],
    { collectionTags: { Users: ['users'], 'Users/Admin': ['admin'] } },
  );
}

describe('workspace search', () => {
  it('finds requests by words in their name, folder, or URL', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.search.query = 'health';
    expect(dialogs.searchResults().map((item) => item.name)).toEqual(['Health']);
    dialogs.search.query = 'admin delete';
    expect(dialogs.searchResults().map((item) => item.name)).toEqual(['Delete user']);
  });

  it('matches #tags exactly, including tags from the collection and folders', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.search.query = '#users';
    expect(dialogs.searchResults().map((item) => `${item.kind}:${item.name}`)).toEqual([
      'Requests:List users',
      'Requests:Delete user',
      'Collections:Users',
    ]);
    // A collection carries its requests' tags too, so it is found by them.
    dialogs.search.query = '#admin #destructive';
    expect(dialogs.searchResults().map((item) => item.name)).toEqual(['Delete user', 'Users']);
    dialogs.search.query = '#use';
    expect(dialogs.searchResults()).toEqual([]);
  });

  it('filters by the tag chips, leaving out pages and environments', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.search.tags = { include: ['users'], mode: 'any', exclude: [] };
    expect(
      dialogs
        .searchResults()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['Delete user', 'List users', 'Users']);
    // Leaving out admin leaves out the Users collection too, which holds an admin request.
    dialogs.search.tags = { include: ['users'], mode: 'any', exclude: ['admin'] };
    expect(dialogs.searchResults().map((item) => item.name)).toEqual(['List users']);
  });

  it('shows the request’s tags in its detail line', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.search.query = 'delete';
    expect(dialogs.searchResults()[0].detail).toContain('#users #admin #destructive');
  });

  it('narrows to one kind of result', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.search.category = 'Environments';
    expect(dialogs.searchResults().map((item) => item.name)).toEqual(['Development']);
  });
});

describe('command palette', () => {
  it('keeps tag commands out of the list until something is typed', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.palette.query = '';
    expect(dialogs.paletteResults().some((command) => command.group === 'Tags')).toBe(false);
  });

  it('offers to show or run the requests with a tag, with their count', () => {
    tagged();
    const dialogs = useDialogsStore();
    dialogs.palette.query = '#users';
    const titles = dialogs.paletteResults().map((command) => command.title);
    expect(titles).toContain('Show requests tagged users');
    expect(titles).toContain('Run requests tagged users');
    const show = dialogs
      .paletteResults()
      .find((command) => command.title === 'Show requests tagged users')!;
    expect(show.keywords).toContain('2 requests');
  });
});
