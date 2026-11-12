import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownValue, setOwnValue } from './own';
import { mockRulePasses } from './mocks';
import { renderMockTemplate } from './mock-templates';
import { validatePathParams } from './mock-validation';
import { parseRunData } from './run-data';

test('own values ignore what objects inherit, and keep "__proto__" as a key', () => {
  const record: Record<string, string> = { host: 'api' };
  assert.equal(ownValue(record, 'host'), 'api');
  for (const name of ['constructor', 'toString', '__proto__'])
    assert.equal(ownValue(record, name), undefined);
  setOwnValue(record, '__proto__', 'kept');
  assert.equal(ownValue(record, '__proto__'), 'kept');
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
});

test('mock rules, templates, and validation see only the request’s own headers and parameters', () => {
  // Node's request headers inherit from Object, as a plain object does.
  const request = {
    query: new URLSearchParams(),
    headers: { accept: 'application/json' } as Record<string, string>,
    params: { id: '7' } as Record<string, string>,
    body: '',
  };
  for (const target of ['header', 'param'] as const)
    assert.equal(
      mockRulePasses(
        { enabled: true, target, name: 'constructor', operator: 'exists', value: '' },
        request,
        request.params,
      ),
      false,
      target,
    );
  assert.equal(
    renderMockTemplate('[{{headers.constructor}}][{{params.toString}}]', request),
    '[][]',
  );
  assert.deepEqual(
    validatePathParams([{ name: 'constructor', type: 'integer' }], request.params),
    [],
  );
});

test('data file columns may be named like Object’s members', () => {
  const data = parseRunData(
    'rows.json',
    // As text: in an object literal, __proto__ would set the prototype instead of a key.
    '[{"constructor": "a", "__proto__": "b"}, {"id": "2"}]',
  );
  assert.deepEqual(data.columns, ['constructor', '__proto__', 'id']);
  assert.equal(ownValue(data.rows[0], '__proto__'), 'b');
  assert.equal(ownValue(data.rows[1], 'constructor'), '');
  assert.equal(Object.getPrototypeOf(data.rows[0]), Object.prototype);
});
