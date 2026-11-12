// What the fuzzer feeds: every parser that reads text from someone else — imports, .http files,
// cURL commands, specifications, assertions, response bodies, and mock rules. Each target takes
// a string; a thrown Error is a refusal, anything else (a TypeError, a hang, running out of
// memory, a changed prototype) is a bug. Run after `npm run compile`, which builds these.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages');
const common = (module) =>
  require(path.join(packages, 'api-workbench-common/dist', `${module}.js`));
const transfer = common('collection-transfer');
const text = common('collection-formats/text-formats');
const assertions = common('assertions');
const specs = common('api-specs');
const mocks = common('mocks');
const captures = common('capture-suggestions');
const schema = common('json-schema');
// The VS Code extension's own .http reader is built with its specs (`npm test`).
const vscodeHttpFile = path.join(packages, 'api-workbench-vscode/dist-spec/core/http-file.js');
const httpVs = existsSync(vscodeHttpFile) ? require(vscodeHttpFile) : undefined;

const encoder = new TextEncoder();
const file = (name) => (source) => transfer.importFiles([{ name, data: encoder.encode(source) }]);
/** A response like an API's, for assertions and mock rules to run against. */
const response = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' },
  body: JSON.stringify({ data: [{ id: 1, name: `${'a'.repeat(34)}!` }], token: 'x' }),
  time: 10,
  size: 100,
};

export const targets = {
  importJSON: file('collection.json'),
  importYAML: file('collection.yaml'),
  importBru: file('request.bru'),
  importWSDL: file('service.wsdl'),
  importHAR: file('traffic.har'),
  importHTTP: file('requests.http'),
  parseText: (source) => transfer.parseText(source),
  curl: (source) => text.curl(source, []),
  httpFile: (source) => text.httpFile(source),
  httpFileReferences: (source) => text.httpFileReferences(source),
  ...(httpVs
    ? {
        vscodeHttpFile: (source) => {
          for (const request of httpVs.parseHttpFile(source).requests) httpVs.bodyFiles(request);
        },
      }
    : {}),
  analyzeSpec: (source) => specs.analyzeSpec(source),
  assertions: (source) => assertions.run(source, response),
  jsonPathAt: (source) => captures.jsonPathAt(source, Math.floor(source.length / 2)),
  // A pattern is refused or compiled, then run against text that makes risky ones backtrack.
  ruleRegExp: (source) => mocks.ruleRegExp(source).test(`${'a'.repeat(30)}!`),
  schemaPattern: (source) =>
    schema.validateJsonSchema(`${'a'.repeat(30)}!`, { type: 'string', pattern: source }),
};
