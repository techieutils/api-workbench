import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphqlCompletions,
  schemaEntries,
  schemaFrom,
  type GraphqlSchema,
} from './graphql-schema';

const schema = schemaFrom({
  queryType: 'Query',
  mutationType: 'Mutation',
  types: [
    {
      name: 'Query',
      kind: 'OBJECT',
      fields: [
        {
          name: 'orders',
          type: '[Order!]!',
          description: 'Recent orders',
          args: [
            { name: 'first', type: 'Int' },
            { name: 'status', type: 'Status' },
          ],
        },
        { name: 'order', type: 'Order', args: [{ name: 'id', type: 'ID!' }] },
        { name: 'legacy', type: 'String', deprecated: 'Use orders' },
      ],
    },
    {
      name: 'Mutation',
      kind: 'OBJECT',
      fields: [
        { name: 'addOrder', type: 'Order!', args: [{ name: 'input', type: 'OrderInput!' }] },
      ],
    },
    {
      name: 'Order',
      kind: 'OBJECT',
      fields: [
        { name: 'id', type: 'ID!' },
        { name: 'total', type: 'Float' },
        { name: 'customer', type: 'Customer' },
      ],
    },
    { name: 'Customer', kind: 'OBJECT', fields: [{ name: 'email', type: 'String' }] },
    { name: 'Status', kind: 'ENUM', enumValues: [{ name: 'OPEN' }, { name: 'SHIPPED' }] },
    { name: 'OrderInput', kind: 'INPUT_OBJECT', inputFields: [{ name: 'note', type: 'String' }] },
    { name: 'Int', kind: 'SCALAR' },
    { name: 'bad name', kind: 'OBJECT' },
    { name: 'Evil', kind: 'OBJECT', fields: [{ name: 'x', type: '<img src=x>' }] },
  ],
})!;

/** Suggestions where `|` is in the query. */
const at = (query: string, given: GraphqlSchema = schema) => {
  const offset = query.indexOf('|');
  const result = graphqlCompletions(query.replace('|', ''), offset, given);
  return { from: result.from, labels: result.items.map((item) => item.label), items: result.items };
};

test('a schema from a server keeps only well-formed names and types', () => {
  assert.ok(!schema.types.some((type) => type.name === 'bad name'));
  assert.deepEqual(schema.types.find((type) => type.name === 'Evil')?.fields, undefined);
  assert.equal(schemaFrom({ types: 'x' }), undefined);
  assert.equal(schemaFrom(null), undefined);
});

test('fields of the type at the cursor are suggested, nested and after aliases', () => {
  assert.deepEqual(at('{ |').labels, ['orders', 'order', '__typename', 'legacy']);
  assert.deepEqual(at('query { ord|').labels, ['orders', 'order']);
  assert.equal(at('query { ord|').from, 8);
  assert.deepEqual(at('{ orders { id cu|').labels, ['customer']);
  assert.deepEqual(at('{ orders(first: 2) { customer { |').labels, ['email', '__typename']);
  assert.deepEqual(
    at('{ recent: orders { t|').labels,
    ['total', '__typename'].filter((name) => name.startsWith('t')),
  );
  assert.deepEqual(
    at('{ orders { id } |').labels,
    ['orders', 'order', '__typename', 'legacy'],
    'back up a level',
  );
  assert.deepEqual(at('mutation { add|').labels, ['addOrder']);
  assert.deepEqual(at('{ order(id: 1) { ...on Order { |').labels.slice(0, 2), ['id', 'total']);
  const legacy = at('{ leg|').items[0];
  assert.equal(legacy.deprecated, 'Use orders');
  assert.match(at('{ orde|').items.find((item) => item.label === 'order')!.detail!, /needs id/);
});

test('arguments, enum values, variables, and types are suggested where they go', () => {
  assert.deepEqual(at('{ orders(|').labels, ['first', 'status']);
  assert.equal(at('{ orders(|').items[0].insert, 'first: ');
  assert.deepEqual(at('{ orders(status: |').labels, ['OPEN', 'SHIPPED']);
  assert.deepEqual(at('{ orders(first: 1, status: S|').labels, ['SHIPPED']);
  assert.deepEqual(at('query Q($id: |').labels, ['Status', 'OrderInput', 'Int']);
  assert.deepEqual(at('query Q($id: ID!, $n: Int) { order(id: $|').labels, ['$id', '$n']);
  assert.deepEqual(at('query Q($id: ID!) { order(id: $|').items[0].insert, 'id');
});

test('keywords at the top, and nothing in strings, comments, or unknown types', () => {
  assert.deepEqual(at('|').labels, ['query', 'mutation', 'fragment']);
  assert.deepEqual(at('mu|').labels, ['mutation']);
  assert.deepEqual(at('fragment F on |').labels, [
    'Query',
    'Mutation',
    'Order',
    'Customer',
    'Evil',
  ]);
  assert.deepEqual(at('{ orders(note: "ord|').labels, []);
  assert.deepEqual(at('{ # ord|').labels, []);
  assert.deepEqual(at('{ nothing { |').labels, []);
});

test('the schema list shows root fields first, and what matches a search', () => {
  const all = schemaEntries(schema, '');
  assert.equal(all[0].title, 'Query');
  assert.equal(all[1].title, 'Query.orders(first: Int, status: Status)');
  assert.equal(all[1].detail, '[Order!]!');
  assert.deepEqual(
    schemaEntries(schema, 'email').map((entry) => entry.title),
    ['Customer.email'],
  );
  assert.equal(schemaEntries(schema, '', 2).length, 2);
});
