import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPHQL_STARTER,
  graphqlBody,
  graphqlErrors,
  graphqlOperations,
  graphqlParts,
  graphqlProblem,
  graphqlTokens,
  variablesTokens,
  formatGraphql,
} from './graphql';

test('a GraphQL body is read as its query, variables, and operation, and written back', () => {
  const body = JSON.stringify({
    query: 'query Orders($first: Int) { orders(first: $first) { id } }',
    variables: { first: 10, token: '{{api_token}}' },
    operationName: 'Orders',
  });
  const parts = graphqlParts(body)!;
  assert.equal(parts.operationName, 'Orders');
  assert.deepEqual(JSON.parse(parts.variables), { first: 10, token: '{{api_token}}' });
  assert.deepEqual(JSON.parse((graphqlBody(parts) as { body: string }).body), JSON.parse(body));
  // Empty variables are sent as {}, and no operation name is sent when none is chosen.
  assert.deepEqual(
    JSON.parse(
      (graphqlBody({ query: '{ a }', variables: ' ', operationName: '' }) as { body: string }).body,
    ),
    { query: '{ a }', variables: {} },
  );
  assert.ok(graphqlParts(GRAPHQL_STARTER.body));
  // Other JSON, even with a `query` field among its own, is not GraphQL.
  for (const other of [
    '{"query": "x", "page": 2}',
    '{"name": "Ada"}',
    '[1]',
    'query { a }',
    '{"query": 1}',
    '{',
  ])
    assert.equal(graphqlParts(other), undefined, other);
});

test('variables that are not a JSON object are refused, with why', () => {
  assert.match(
    (graphqlBody({ query: '{ a }', variables: '{"a":', operationName: '' }) as { error: string })
      .error,
    /not JSON/,
  );
  assert.match(
    (graphqlBody({ query: '{ a }', variables: '[1]', operationName: '' }) as { error: string })
      .error,
    /JSON object/,
  );
});

test('operations are found, and likely mistakes pointed out, without reading strings or comments', () => {
  const doc =
    'query Orders { orders { id } }\n# mutation Ignored\nmutation AddOrder { add(note: "query Nope {") { id } }';
  assert.deepEqual(graphqlOperations(doc), [
    { kind: 'query', name: 'Orders' },
    { kind: 'mutation', name: 'AddOrder' },
  ]);
  assert.match(graphqlProblem(doc)!, /2 operations: choose/);
  assert.equal(graphqlProblem(doc, 'AddOrder'), undefined);
  assert.match(graphqlProblem(doc, 'Gone')!, /No operation is named “Gone”/);
  assert.match(graphqlProblem('{ orders { id }')!, /Line 1: “\{” is never closed/);
  assert.match(graphqlProblem('{ orders(first: 1] }')!, /“]” closes the “\(”/);
  assert.match(graphqlProblem('   ')!, /Write the query/);
  assert.equal(graphqlProblem('{ orders { id } }'), undefined);
});

test('a GraphQL response’s errors are found, and other APIs’ errors left alone', () => {
  assert.deepEqual(
    graphqlErrors('{"data": null, "errors": [{"message": "Cannot query field \\"x\\""}, {}]}'),
    ['Cannot query field "x"', 'An error without a message'],
  );
  assert.deepEqual(graphqlErrors('{"data": {"a": 1}}'), []);
  assert.deepEqual(graphqlErrors('{"errors": [{"message": "x"}], "status": 422}'), []);
  assert.deepEqual(graphqlErrors('not json'), []);
});

test('a query is split into coloured pieces that join back into it exactly', () => {
  const query = `# Orders, newest first
query Orders($first: Int = 10, $status: [Status!]) @cached {
  recent: orders(first: $first, status: OPEN, note: "a { (", archived: false) {
    id
    ... on Order { total }
    ...Customer
  }
}
fragment Customer on Order { customer { email } }
"""unclosed`;
  const tokens = graphqlTokens(query);
  assert.equal(tokens.map((token) => token.text).join(''), query);
  const kind = (text: string, nth = 0) => tokens.filter((token) => token.text === text)[nth]?.kind;
  assert.equal(kind('# Orders, newest first'), 'comment');
  assert.equal(kind('query'), 'keyword');
  assert.equal(kind('Orders'), 'operation');
  assert.equal(kind('$first'), 'variable');
  assert.equal(kind('Int'), 'type', 'a variable’s type');
  assert.equal(kind('Status'), 'type', 'inside a list type');
  assert.equal(kind('10'), 'number');
  assert.equal(kind('@cached'), 'directive');
  assert.equal(kind('recent'), 'property', 'an alias');
  assert.equal(kind('orders'), 'field');
  assert.equal(kind('first', 0), 'property', 'an argument');
  assert.equal(kind('OPEN'), 'constant', 'an enum value');
  assert.equal(kind('"a { ("'), 'string');
  assert.equal(kind('false'), 'constant');
  assert.equal(kind('id'), 'field');
  assert.equal(kind('on', 0), 'keyword');
  assert.equal(kind('Order', 0), 'type');
  assert.equal(kind('total'), 'field', 'brackets in the string were not counted');
  assert.equal(kind('fragment'), 'keyword');
  assert.equal(kind('Customer', 1), 'operation', 'a fragment’s name');
  assert.equal(kind('Order', 1), 'type');
  assert.equal(kind('"""unclosed'), 'string');
  assert.equal(kind('{'), 'punctuation');
  // Every character is kept, whatever is typed.
  for (const text of ['', '{', '"', '"""', '$', '@', 'query (', '}}}', '\u0000 ü 🙂'])
    assert.equal(
      graphqlTokens(text)
        .map((token) => token.text)
        .join(''),
      text,
    );
});

test('variables are coloured as JSON, with {{environment}} values inside strings', () => {
  const text =
    '{\n  "first": 10,\n  "token": "Bearer {{api_token}}",\n  "draft": false,\n  "note": null\n}';
  const tokens = variablesTokens(text);
  assert.equal(tokens.map((token) => token.text).join(''), text);
  const kind = (piece: string) => tokens.find((token) => token.text === piece)?.kind;
  assert.equal(kind('"first"'), 'property');
  assert.equal(kind('10'), 'number');
  assert.equal(kind('"Bearer '), 'string');
  assert.equal(kind('{{api_token}}'), 'variable');
  assert.equal(kind('false'), 'constant');
  assert.equal(kind('null'), 'constant');
  // Half-typed JSON keeps every character.
  for (const partial of ['{"a', '{"a": "{{b', '', '[1, {"x": tr'])
    assert.equal(
      variablesTokens(partial)
        .map((token) => token.text)
        .join(''),
      partial,
    );
});

test('a query is formatted as GraphQL is usually written, and formatting twice changes nothing', () => {
  const messy =
    'query Orders($first:Int=10,$status:[Status!]!)@cached{recent:orders(first:$first,status:OPEN,note:"a {  ( b"){id,total ...on Order{customer{email}} ...Parts}} # done\nfragment Parts on Order{createdAt}';
  const formatted = formatGraphql(messy) as { text: string };
  assert.equal(
    formatted.text,
    [
      'query Orders($first: Int = 10, $status: [Status!]!) @cached {',
      '  recent: orders(first: $first, status: OPEN, note: "a {  ( b") {',
      '    id',
      '    total',
      '    ... on Order {',
      '      customer {',
      '        email',
      '      }',
      '    }',
      '    ...Parts',
      '  }',
      '}',
      '',
      '# done',
      'fragment Parts on Order {',
      '  createdAt',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(formatGraphql(formatted.text), formatted, 'already formatted');
  // Nothing but layout changes: the same words, strings, and punctuation, in order.
  const words = (text: string) =>
    graphqlTokens(text)
      .filter((token) => token.text.trim() && token.text !== ',')
      .map((token) => token.text);
  assert.deepEqual(
    words(formatted.text),
    words(messy).filter((word) => word !== ','),
  );
  // An input object in arguments stays on the field's line, a brace in a string untouched.
  assert.equal(
    (formatGraphql('{a(list:[1,2],obj:{x:1,y:{z:"}"}})@skip(if:$no) b}') as { text: string }).text,
    '{\n  a(list: [1, 2], obj: {x: 1, y: {z: "}"}}) @skip(if: $no)\n  b\n}\n',
  );
  assert.deepEqual(formatGraphql('   '), { text: '' });
  assert.match((formatGraphql('{ orders { id }') as { error: string }).error, /never closed/);
  assert.match((formatGraphql('{ a(b: 1] }') as { error: string }).error, /closes the “\(”/);
});
