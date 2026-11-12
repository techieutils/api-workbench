import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseRunData, runDataFormat, withRowValues } from './run-data';

test('CSV handles quotes, line breaks in quotes, CRLF, a BOM, blank lines, and other separators', () => {
  const data = parseRunData(
    'users.csv',
    '\uFEFFid,name,note\r\n1,"Ada, Countess","said ""hi""\nthen left"\r\n\r\n2,Sam,\r\n',
  );
  assert.equal(data.format, 'csv');
  assert.deepEqual(data.columns, ['id', 'name', 'note']);
  assert.deepEqual(data.rows, [
    { id: '1', name: 'Ada, Countess', note: 'said "hi"\nthen left' },
    { id: '2', name: 'Sam', note: '' },
  ]);
  assert.deepEqual(parseCSV('a;b\n1;2').rows, [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCSV('a\tb\n1\t2').rows, [{ a: '1', b: '2' }]);
  assert.deepEqual(
    parseCSV('"a,b";c\n1;2').columns,
    ['a,b', 'c'],
    'quoted header separators are skipped',
  );
  assert.deepEqual(parseCSV('a,b\n1').rows, [{ a: '1', b: '' }], 'short rows are filled in');
});

test('CSV problems are explained with where they are', () => {
  assert.throws(() => parseCSV('a,b\n1,2,3'), /line 2 has 3 values but the header has 2/);
  assert.throws(() => parseCSV('a,a\n1,2'), /“a” more than once/);
  assert.throws(() => parseCSV('a,\n1,2'), /empty column name/);
  assert.throws(() => parseCSV('a,{b}\n1,2'), /cannot contain \{ or \}/);
  assert.throws(() => parseCSV('a\n"open'), /never closed/);
  assert.throws(() => parseRunData('x.csv', 'a,b\n'), /no rows/);
  assert.throws(() => parseRunData('x.csv', ''), /empty/);
});

test('JSON and YAML take a list of objects, or one object holding a list', () => {
  const json = parseRunData(
    'data.json',
    '[{"id":1,"active":true,"tags":["a"],"missing":null},{"id":2,"extra":"x"}]',
  );
  assert.deepEqual(json.columns, ['id', 'active', 'tags', 'missing', 'extra']);
  assert.deepEqual(json.rows[0], {
    id: '1',
    active: 'true',
    tags: '["a"]',
    missing: '',
    extra: '',
  });
  assert.deepEqual(json.rows[1], { id: '2', active: '', tags: '', missing: '', extra: 'x' });
  assert.equal(parseRunData('wrapped.json', '{"rows":[{"a":1}]}').rows.length, 1);
  const yaml = parseRunData('cases.yml', '- id: 1\n  name: Ada\n- id: 2\n  name: Sam\n');
  assert.equal(yaml.format, 'yaml');
  assert.deepEqual(yaml.rows[1], { id: '2', name: 'Sam' });
  assert.throws(() => parseRunData('x.json', '{"a":1}'), /list of rows/);
  assert.throws(() => parseRunData('x.json', '[1,2]'), /row 1 is not an object/);
  assert.throws(() => parseRunData('x.json', '[{'), /could not be read/);
  assert.throws(
    () => parseRunData('x.yaml', 'a: &a [*a, *a]\nb: *a'),
    /could not be read|list of rows/,
  );
});

test('XML rows are the root’s repeated children, with attributes and elements as columns', () => {
  const data = parseRunData(
    'users.xml',
    '<?xml version="1.0"?><users><user id="1"><name>Ada &amp; co</name></user><user id="2"><name>Sam</name><role>admin</role></user></users>',
  );
  assert.equal(data.format, 'xml');
  assert.deepEqual(data.rows, [
    { id: '1', name: 'Ada & co', role: '' },
    { id: '2', name: 'Sam', role: 'admin' },
  ]);
  assert.deepEqual(parseRunData('one.xml', '<rows><row><a>1</a></row></rows>').rows, [{ a: '1' }]);
  assert.throws(
    () => parseRunData('x.xml', '<!DOCTYPE x [<!ENTITY e "boom">]><rows><row>&e;</row></rows>'),
    /DOCTYPE/,
  );
  assert.throws(() => parseRunData('x.xml', '<rows><a/><b/></rows>'), /same element name/);
  assert.throws(() => parseRunData('x.xml', '<rows><row>'), /could not be read/);
});

test('formats come from the extension, or from the text when the extension says nothing', () => {
  assert.equal(runDataFormat('data.txt', ' [ {"a":1} ]'), 'json');
  assert.equal(runDataFormat('data', '<rows/>'), 'xml');
  assert.equal(runDataFormat('data', '- a: 1'), 'yaml');
  assert.equal(runDataFormat('data.tsv', 'a\tb'), 'csv');
  assert.throws(() => parseRunData('big.csv', 'a\n' + 'x'.repeat(5 * 1024 * 1024)), /5 MB/);
  assert.throws(
    () => parseRunData('many.csv', 'a\n' + '1\n'.repeat(10_001)),
    /limited to 10,000 rows/,
  );
});

test('tests take the row’s values for its columns only', () => {
  assert.equal(
    withRowValues('status {{expected}}\nbody-contains {{ name }}\nheader x {{other}}', {
      expected: '201',
      name: 'Ada',
    }),
    'status 201\nbody-contains Ada\nheader x {{other}}',
  );
});
