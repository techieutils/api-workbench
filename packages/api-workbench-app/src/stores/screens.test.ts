import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { useScreensStore } from './screens';
import { request, workspaceWith } from '../test/workspace';

function shop() {
  return workspaceWith(
    [
      request('List items', 'Shop', { tags: ['public'] }),
      request('Create item', 'Shop/Admin', { tags: ['write'] }, 'POST'),
      request('Report', 'Shop/Admin', { tags: ['internal'] }),
      request('Health', 'Ops'),
    ],
    { collectionTags: { 'Shop/Admin': ['admin'] } },
  );
}

describe('Docs screen', () => {
  it('documents a collection’s requests, filtered by tags', () => {
    shop();
    const screens = useScreensStore();
    screens.documentation.collection = 'Shop';
    expect(screens.documentationRequests().map((item) => item.name)).toEqual([
      'List items',
      'Create item',
      'Report',
    ]);
    screens.documentation.tags = { include: ['admin'], mode: 'any', exclude: ['internal'] };
    expect(screens.documentationRequests().map((item) => item.name)).toEqual(['Create item']);
    expect(screens.collectionRequestsAll()).toHaveLength(3);
  });

  it('tags each operation with the collection, then the request’s own and inherited tags', () => {
    shop();
    const screens = useScreensStore();
    screens.documentation.collection = 'Shop';
    screens.documentation.mode = 'YAML';
    const document = parse(screens.documentationOutput().text) as {
      paths: Record<string, Record<string, { summary: string; tags: string[] }>>;
    };
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
    expect(operations.find((operation) => operation.summary === 'Create item')?.tags).toEqual([
      'Shop',
      'admin',
      'write',
    ]);
  });

  it('keeps collection and folder tags in a JSON export', () => {
    shop();
    const screens = useScreensStore();
    screens.documentation.collection = 'Shop';
    screens.documentation.mode = 'JSON';
    const output = JSON.parse(screens.documentationOutput().text) as { collectionTags: unknown };
    expect(output.collectionTags).toEqual({ 'Shop/Admin': ['admin'] });
  });
});
