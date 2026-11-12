import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Confirmations, type Question } from './confirmations';

const question: Question = { title: 't', message: 'm', detail: 'd', confirm: 'Go' };

test('a confirmation is asked once per run, or every time, and a no is never remembered', async () => {
  const answers = [false, true, true, false];
  let asked = 0;
  const confirm = new Confirmations(async () => {
    asked++;
    return answers.shift()!;
  });
  assert.equal(await confirm.allow('decrypt-https', question), false, 'declined');
  assert.equal(await confirm.allow('decrypt-https', question), true, 'asked again, and allowed');
  assert.equal(await confirm.allow('decrypt-https', question), true, 'remembered');
  assert.equal(asked, 2);
  assert.equal(await confirm.allow('trust', question, true), true);
  assert.equal(await confirm.allow('trust', question, true), false, 'asked every time');
  assert.equal(asked, 4);
});
