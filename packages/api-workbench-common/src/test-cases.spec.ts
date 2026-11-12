import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examples, run } from './assertions';
import {
  defaultRule,
  buildAssertion,
  parseCases,
  ruleFromAssertion,
  writeCase,
  toggleCase,
  duplicateCase,
  removeCase,
  moveCase,
} from './test-cases';
import type { HttpResponse } from './types';
const response: HttpResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"id":1,"active":true,"items":[1,2]}',
  time: 80,
  size: 24,
  url: 'https://example.com',
};
test('all assertion examples can be parsed, edited, and retain execution behavior', () => {
  for (const example of examples) {
    const rule = ruleFromAssertion(example.syntax);
    assert.notEqual(rule.kind, 'custom', example.syntax);
    const built = buildAssertion(rule);
    assert.equal(
      run(built, response)[0].pass,
      run(example.syntax, response)[0].pass,
      example.syntax,
    );
  }
});
test('typed JSON values serialize with strict types and correct string escaping', () => {
  const rule = { ...defaultRule('json'), target: '$.value' };
  assert.equal(
    buildAssertion({ ...rule, valueType: 'string', value: 'A "quote"\nline' }),
    'json $.value equals "A \\"quote\\"\\nline"',
  );
  assert.equal(
    buildAssertion({ ...rule, valueType: 'boolean', value: 'false' }),
    'json $.value equals false',
  );
  assert.equal(buildAssertion({ ...rule, valueType: 'null' }), 'json $.value equals null');
  assert.equal(
    buildAssertion({ ...rule, valueType: 'object', value: '{"a":1}' }),
    'json $.value equals {"a":1}',
  );
  assert.throws(() => buildAssertion({ ...rule, valueType: 'array', value: '{}' }), /JSON array/);
  assert.throws(() => buildAssertion({ ...rule, valueType: 'object', value: '[' }), /valid JSON/);
});
test('named and disabled cases round trip through text without dropping comments', () => {
  const original = '// Keep this comment\n# Another comment\n\nstatus 200\nunknown-test';
  let source = writeCase(original, null, 'ID is correct', {
    ...defaultRule('json'),
    target: '$.id',
    value: '1',
  });
  assert.ok(source.startsWith(original));
  let entries = parseCases(source);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].name, 'ID is correct');
  assert.equal(entries[1].rule.kind, 'custom');
  source = toggleCase(source, 2, false);
  assert.equal(parseCases(source)[2].enabled, false);
  assert.equal(run(source, response).length, 2);
  source = toggleCase(source, 2, true);
  assert.equal(run(source, response).at(-1)!.name, 'ID is correct');
  source = writeCase(source, 2, 'Updated name', { ...entries[2].rule, value: '2' });
  entries = parseCases(source);
  assert.equal(entries[2].name, 'Updated name');
  assert.equal(entries[2].assertion, 'json $.id equals 2');
  assert.ok(source.startsWith(original));
});
test('case duplicate, reorder, and delete retain names, state, and unrelated comments', () => {
  let source = writeCase('// suite', null, 'Status', defaultRule());
  source = writeCase(source, null, 'JSON', defaultRule('json-valid'), false);
  source = duplicateCase(source, 1);
  assert.deepEqual(
    parseCases(source).map((entry) => entry.name),
    ['Status', 'JSON', 'JSON (copy)'],
  );
  source = moveCase(source, 2, -1);
  assert.deepEqual(
    parseCases(source).map((entry) => entry.name),
    ['Status', 'JSON (copy)', 'JSON'],
  );
  assert.equal(parseCases(source)[1].enabled, false);
  source = removeCase(source, 1);
  assert.deepEqual(
    parseCases(source).map((entry) => entry.name),
    ['Status', 'JSON'],
  );
  assert.ok(source.startsWith('// suite'));
  assert.equal(moveCase(source, 0, -1), source);
  assert.equal(moveCase(source, 1, 1), source);
});
test('designer rejects invalid paths, status ranges, header names, and multiline custom rules', () => {
  assert.throws(
    () => buildAssertion({ ...defaultRule('json-field'), target: '$.items[*]' }),
    /JSON path/,
  );
  assert.throws(
    () =>
      buildAssertion({ ...defaultRule(), operator: 'between', value: '400', secondValue: '200' }),
    /Minimum/,
  );
  assert.throws(() => buildAssertion({ ...defaultRule(), value: '999' }), /Status codes/);
  assert.throws(
    () => buildAssertion({ ...defaultRule('header'), target: 'invalid header' }),
    /header name/,
  );
  assert.throws(
    () => buildAssertion({ ...defaultRule('custom'), value: 'status 200\njson-valid' }),
    /one assertion/,
  );
});
test('disabled named cases never rename following active results', () => {
  const source =
    '// @case "Disabled name"\n// @disabled status 500\nstatus 200\n// @case "Orphan name"\n\njson-valid';
  const results = run(source, response);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => !result.name));
});

test('the builder writes and reads the new body checks and comparisons', () => {
  const cases: [Partial<ReturnType<typeof defaultRule>> & { kind: string }, string][] = [
    [{ kind: 'body', operator: 'starts-with', value: '{' }, 'body starts-with "{"'],
    [{ kind: 'body', operator: 'matches', value: '"id":\\s*\\d+' }, 'body matches /"id":\\s*\\d+/'],
    [{ kind: 'body', operator: 'not-matches', value: '/error/i' }, 'body not-matches /error/i'],
    [
      { kind: 'body', operator: 'contains-ignore-case', value: 'Success' },
      'body contains-ignore-case "Success"',
    ],
    // The original body checks keep their names.
    [{ kind: 'body', operator: 'contains', value: 'ok' }, 'body-contains "ok"'],
    [{ kind: 'body-length', operator: '>', value: '0' }, 'body-length > 0'],
    [
      { kind: 'body-length', operator: 'between', value: '1', secondValue: '500' },
      'body-length between 1 500',
    ],
    [
      { kind: 'response-time', operator: 'between', value: '10', secondValue: '900' },
      'response-time between 10 900',
    ],
    [{ kind: 'status', operator: 'not-in', value: '401, 403' }, 'status not-in 401, 403'],
    [
      { kind: 'header', target: 'etag', operator: 'ends-with', value: '"' },
      'header etag ends-with "\\""',
    ],
    [
      { kind: 'json', target: '$.status', operator: 'in', value: '"active", "pending"' },
      'json $.status in ["active","pending"]',
    ],
    // Plain words in a list are strings.
    [
      { kind: 'json', target: '$.status', operator: 'not-in', value: 'active, pending' },
      'json $.status not-in ["active","pending"]',
    ],
    [
      { kind: 'json', target: '$.price', operator: 'between', value: '1', secondValue: '9.5' },
      'json $.price between 1 9.5',
    ],
    [
      { kind: 'json', target: '$.email', operator: 'matches', value: '@example\\.com$' },
      'json $.email matches /@example\\.com$/',
    ],
    [
      { kind: 'json', target: '$.tags', operator: 'not-contains', value: 'admin' },
      'json $.tags not-contains "admin"',
    ],
    [
      { kind: 'json-length', target: '$.items', operator: 'between', value: '1', secondValue: '3' },
      'json-length $.items between 1 3',
    ],
    [
      { kind: 'json-schema', target: '$', value: '{ "type": "object" }' },
      'json-schema {"type":"object"}',
    ],
    [
      { kind: 'json-schema', target: '$.data', value: '{"required": ["id"]}' },
      'json-schema $.data {"required":["id"]}',
    ],
  ];
  for (const [fields, assertion] of cases) {
    const rule = { ...defaultRule(fields.kind as Parameters<typeof defaultRule>[0]), ...fields };
    assert.equal(buildAssertion(rule), assertion, JSON.stringify(fields));
    // Reading the assertion back gives a rule that writes the same assertion.
    const read = ruleFromAssertion(assertion);
    assert.notEqual(read.kind, 'custom', assertion);
    assert.equal(buildAssertion(read), assertion, `round trip: ${assertion}`);
  }
});
test('the builder rejects incomplete or invalid new comparisons', () => {
  const rule = (fields: Partial<ReturnType<typeof defaultRule>> & { kind: string }) => ({
    ...defaultRule(fields.kind as Parameters<typeof defaultRule>[0]),
    ...fields,
  });
  assert.throws(
    () => buildAssertion(rule({ kind: 'body', operator: 'matches', value: '(' })),
    /Invalid regular expression/,
  );
  assert.throws(
    () => buildAssertion(rule({ kind: 'body', operator: 'matches', value: ' ' })),
    /Enter a regular expression/,
  );
  assert.throws(
    () =>
      buildAssertion(
        rule({ kind: 'body-length', operator: 'between', value: '9', secondValue: '1' }),
      ),
    /Minimum must not exceed/,
  );
  assert.throws(
    () => buildAssertion(rule({ kind: 'json', operator: 'in', value: '' })),
    /at least one value/,
  );
  assert.throws(
    () => buildAssertion(rule({ kind: 'json-schema', value: '[1]' })),
    /JSON Schema as a JSON object/,
  );
});

test('the builder writes and reads the new checks and comparisons', () => {
  const written: [Parameters<typeof buildAssertion>[0], string][] = [
    [{ ...defaultRule('cookie'), operator: 'exists', target: 'session' }, 'cookie-exists session'],
    [
      { ...defaultRule('cookie'), operator: 'equals', target: 'theme', value: 'dark' },
      'cookie theme equals "dark"',
    ],
    [{ ...defaultRule('cookie'), operator: 'is-uuid', target: 'id' }, 'cookie id is-uuid'],
    [
      { ...defaultRule('header'), operator: 'is-date', target: 'last-modified' },
      'header last-modified is-date',
    ],
    [
      { ...defaultRule('header'), operator: 'not-starts-with', value: 'text/' },
      'header content-type not-starts-with "text/"',
    ],
    [defaultRule('timing'), 'timing ttfb < 500'],
    [
      {
        ...defaultRule('timing'),
        target: 'total',
        operator: 'between',
        value: '0',
        secondValue: '900',
      },
      'timing total between 0 900',
    ],
    [defaultRule('certificate-days-left'), 'certificate-days-left > 30'],
    [{ ...defaultRule('json'), target: '$.email', operator: 'is-email' }, 'json $.email is-email'],
    [
      { ...defaultRule('json'), target: '$.ids', operator: 'is-sorted-desc' },
      'json $.ids is-sorted-desc',
    ],
    [
      {
        ...defaultRule('json'),
        target: '$.roles',
        operator: 'contains-all',
        value: '"read", "write"',
      },
      'json $.roles contains-all ["read","write"]',
    ],
    [
      {
        ...defaultRule('json'),
        target: '$.roles',
        operator: 'contains-any',
        value: 'admin, owner',
      },
      'json $.roles contains-any ["admin","owner"]',
    ],
  ];
  for (const [rule, assertion] of written) {
    assert.equal(buildAssertion(rule), assertion);
    const read = ruleFromAssertion(assertion);
    assert.notEqual(read.kind, 'custom', assertion);
    assert.equal(buildAssertion(read), assertion, 'reads back to the same assertion');
  }
  assert.throws(
    () => buildAssertion({ ...defaultRule('timing'), target: 'lunch' }),
    /Choose a timing/,
  );
  assert.throws(
    () => buildAssertion({ ...defaultRule('cookie'), target: 'two words' }),
    /cookie name/,
  );
});
