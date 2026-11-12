import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionOf,
  folderEntry,
  setFolderEntry,
  folderChain,
  folderLabel,
  folderName,
  folderNameProblem,
  folderPaths,
  folderTree,
  isWithin,
  moveFolderPath,
  parentFolder,
} from './folders';

test('a folder path names its collection, parent, and own name', () => {
  assert.equal(collectionOf('Shop/Orders/Refunds'), 'Shop');
  assert.equal(collectionOf('Shop'), 'Shop');
  assert.equal(folderName('Shop/Orders/Refunds'), 'Refunds');
  assert.equal(parentFolder('Shop/Orders/Refunds'), 'Shop/Orders');
  assert.equal(parentFolder('Shop'), undefined);
  assert.equal(folderLabel('Shop/Orders/Refunds'), 'Shop / Orders / Refunds');
});

test('folderChain lists every level from the collection down', () => {
  assert.deepEqual(folderChain('Shop/Orders/Refunds'), [
    'Shop',
    'Shop/Orders',
    'Shop/Orders/Refunds',
  ]);
  assert.deepEqual(folderChain('Shop'), ['Shop']);
});

test('isWithin matches the folder and its descendants, not similarly named siblings', () => {
  assert.equal(isWithin('Shop', 'Shop'), true);
  assert.equal(isWithin('Shop/Orders', 'Shop'), true);
  assert.equal(isWithin('Shopping', 'Shop'), false);
  assert.equal(isWithin('Shop', 'Shop/Orders'), false);
});

test('moveFolderPath renames a folder and everything inside it', () => {
  assert.equal(
    moveFolderPath('Shop/Orders/Refunds', 'Shop/Orders', 'Shop/Sales'),
    'Shop/Sales/Refunds',
  );
  assert.equal(moveFolderPath('Shop/Orders', 'Shop/Orders', 'Store/Orders'), 'Store/Orders');
  assert.equal(moveFolderPath('Shop/Ordersheet', 'Shop/Orders', 'X'), 'Shop/Ordersheet');
});

test('folder names must be non-empty, short, and free of the separator', () => {
  assert.equal(folderNameProblem('Orders'), undefined);
  assert.match(folderNameProblem('  ')!, /Enter a name/);
  assert.match(folderNameProblem('a/b')!, /cannot contain/);
  assert.match(folderNameProblem('x'.repeat(121))!, /120 characters/);
});

test('folderTree nests folders in first-appearance order with totals', () => {
  const requests = [
    { id: 1, folder: 'Shop' },
    { id: 2, folder: 'Shop/Orders/Refunds' },
    { id: 3, folder: 'Users' },
    { id: 4, folder: 'Shop/Orders' },
    { id: 5, folder: 'Shop/Carts' },
  ];
  const tree = folderTree(requests);
  assert.deepEqual(
    tree.map((root) => [root.path, root.total, root.requests.map((r) => r.id)]),
    [
      ['Shop', 4, [1]],
      ['Users', 1, [3]],
    ],
  );
  const orders = tree[0].folders[0];
  assert.deepEqual(
    [orders.path, orders.total, orders.requests.map((r) => r.id)],
    ['Shop/Orders', 2, [4]],
  );
  assert.deepEqual(
    orders.folders.map((folder) => folder.name),
    ['Refunds'],
  );
  assert.deepEqual(folderPaths(tree), [
    'Shop',
    'Shop/Orders',
    'Shop/Orders/Refunds',
    'Shop/Carts',
    'Users',
  ]);
});

test('folder entries are the map’s own, whatever the folder is called', () => {
  const map: Record<string, string> = { Users: 'users' };
  assert.equal(folderEntry(map, 'Users'), 'users');
  for (const name of ['constructor', 'toString', '__proto__', 'valueOf'])
    assert.equal(folderEntry(map, name), undefined);
  assert.equal(folderEntry(undefined, 'Users'), undefined);
  setFolderEntry(map, '__proto__', 'kept');
  assert.equal(folderEntry(map, '__proto__'), 'kept');
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.deepEqual(Object.keys(map), ['Users', '__proto__']);
});
