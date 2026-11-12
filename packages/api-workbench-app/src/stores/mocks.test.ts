import { describe, expect, it } from 'vitest';
import { newMock } from '@techieutils/api-workbench-common/mocks';
import { useMocksStore } from './mocks';
import { request, workspaceWith } from '../test/workspace';

describe('A mock made from a collection', () => {
  it('adds each route added to it to the collection, and keeps the request in step', () => {
    const mock = {
      ...newMock('Shop mock', [], []),
      source: { kind: 'collection' as const, name: 'Shop' },
    };
    const workspace = workspaceWith([request('List items', 'Shop')], { mocks: [mock] });
    const mocks = useMocksStore();
    const route = mocks.addRoute(mock.id)!;
    const added = workspace.state.requests.find((item) => item.id === route.requestId)!;
    expect(added.folder).toBe('Shop');
    expect(added.url).toBe('{{base_url}}/new-route');
    mocks.updateRoute(mock.id, route.id, { method: 'POST', path: '/items/:id/notes' });
    expect(workspace.state.requests).toHaveLength(2);
    expect(added.method).toBe('POST');
    expect(added.url).toBe('{{base_url}}/items/{{id}}/notes');
    // A copy of the route gets a request of its own.
    mocks.duplicateRoute(mock.id, route.id);
    expect(workspace.state.requests).toHaveLength(3);
    // Changing a route's answer leaves its request alone.
    mocks.updateRoute(mock.id, route.id, { status: 404 });
    expect(workspace.state.requests).toHaveLength(3);
  });

  it('leaves collections alone for a mock made another way', () => {
    const mock = newMock('Plain mock', [], []);
    const workspace = workspaceWith([request('List items', 'Shop')], { mocks: [mock] });
    useMocksStore().addRoute(mock.id);
    expect(workspace.state.requests).toHaveLength(1);
  });
});

describe('A collection a mock was made from', () => {
  it('adds a route for a request added to it, and changes the route as the request changes', async () => {
    const { useRequestsStore } = await import('./requests');
    const mock = {
      ...newMock('Shop mock', [], []),
      source: { kind: 'collection' as const, name: 'Shop' },
    };
    const workspace = workspaceWith([request('List items', 'Shop')], { mocks: [mock] });
    useMocksStore();
    // What was there when the workspace opened adds nothing.
    workspace.persist();
    expect(mock.routes).toHaveLength(0);
    useRequestsStore().createRequestIn('Shop');
    const added = workspace.state.requests.at(-1)!;
    expect(mock.routes).toHaveLength(1);
    expect(mock.routes[0].requestId).toBe(added.id);
    added.method = 'POST';
    added.url = '{{base_url}}/items/{{id}}/notes';
    added.name = 'Add a note';
    workspace.persist();
    expect(mock.routes).toHaveLength(1);
    expect([mock.routes[0].method, mock.routes[0].path, mock.routes[0].name]).toEqual([
      'POST',
      '/items/:id/notes',
      'Add a note',
    ]);
    // A request elsewhere leaves the mock alone.
    workspace.state.requests.push(request('Health', 'Ops'));
    workspace.persist();
    expect(mock.routes).toHaveLength(1);
  });
});

describe('Sync now, and a renamed collection', () => {
  it('puts a mock and its collection fully in step, and keeps them so after a rename', async () => {
    const { useRequestsStore } = await import('./requests');
    const { newMockRoute } = await import('@techieutils/api-workbench-common/mocks');
    const mock = {
      ...newMock('Shop mock', [], [newMockRoute({ method: 'DELETE', path: '/items/:id' })]),
      source: { kind: 'collection' as const, name: 'Shop' },
    };
    const workspace = workspaceWith([request('List items', 'Shop'), request('Health', 'Ops')], {
      mocks: [mock],
    });
    const mocks = useMocksStore();
    expect(mocks.syncStatus(mock)).toEqual({
      collection: 'Shop',
      missingRoutes: 1,
      missingRequests: 1,
    });
    mocks.syncWithCollection(mock.id);
    expect(mocks.syncStatus(mock)).toEqual({
      collection: 'Shop',
      missingRoutes: 0,
      missingRequests: 0,
    });
    expect(
      workspace.state.requests.some((item) => item.method === 'DELETE' && item.folder === 'Shop'),
    ).toBe(true);
    expect(mock.routes.map((route) => `${route.method} ${route.path}`)).toContain(
      'GET /list-items',
    );
    // Renamed, the collection is still the mock's, and new requests there still reach it.
    workspace.persist();
    expect(useRequestsStore().renameFolder('Shop', 'Store')).toBeUndefined();
    expect(mock.source.name).toBe('Store');
    useRequestsStore().createRequestIn('Store');
    expect(mock.routes).toHaveLength(3);
  });
});
