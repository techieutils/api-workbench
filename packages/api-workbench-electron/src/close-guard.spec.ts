import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloseGuard, SAVE_BEFORE_CLOSE_MS } from './close-guard';

/** Closing the window with unsaved changes: saved first, or asked about when auto save is off. */

function guard(answer = 0) {
  const calls: string[] = [];
  const closeGuard = new CloseGuard({
    ask: () => {
      calls.push('ask');
      return answer;
    },
    requestSave: () => calls.push('save'),
    close: () => calls.push('close'),
    quit: () => calls.push('quit'),
  });
  return { calls, closeGuard };
}

test('nothing unsaved closes at once; changes waiting are saved first, then the window closes', () => {
  const { calls, closeGuard } = guard();
  assert.equal(closeGuard.onClose(), false);
  closeGuard.report(true, false);
  assert.equal(closeGuard.onClose(), true, 'the close waits for the save');
  assert.deepEqual(calls, ['save'], 'without asking, since auto save is on');
  assert.equal(closeGuard.onClose(), false, 'a second close while saving is not held again');
  closeGuard.ready(true);
  assert.deepEqual(calls, ['save', 'close']);
});

test('with auto save off it asks: Save saves, Don’t save closes, Cancel stays', () => {
  const save = guard(0);
  save.closeGuard.report(true, true);
  assert.equal(save.closeGuard.onClose(), true);
  assert.deepEqual(save.calls, ['ask', 'save']);

  const discard = guard(1);
  discard.closeGuard.report(true, true);
  assert.equal(discard.closeGuard.onClose(), false, 'this close goes ahead');
  assert.deepEqual(discard.calls, ['ask']);

  const stay = guard(2);
  stay.closeGuard.report(true, true);
  stay.closeGuard.quitRequested();
  assert.equal(stay.closeGuard.onClose(), true);
  assert.deepEqual(stay.calls, ['ask'], 'nothing is saved or closed');
  stay.closeGuard.report(false, true);
  assert.equal(stay.closeGuard.onClose(), false);
  assert.ok(!stay.calls.includes('quit'), 'cancelling also cancels the quit');
});

test('a failed save keeps the window open; a quit held up by a save carries on', () => {
  const failed = guard();
  failed.closeGuard.report(true, false);
  failed.closeGuard.onClose();
  failed.closeGuard.ready(false);
  assert.deepEqual(failed.calls, ['save'], 'not closed, so nothing is lost');
  assert.equal(failed.closeGuard.onClose(), true, 'closing again tries the save again');

  const quitting = guard();
  quitting.closeGuard.report(true, false);
  quitting.closeGuard.quitRequested();
  quitting.closeGuard.onClose();
  quitting.closeGuard.ready(true);
  assert.deepEqual(quitting.calls, ['save', 'close', 'quit']);
});

test('a window that never answers still closes after the wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, closeGuard } = guard();
  closeGuard.report(true, false);
  closeGuard.onClose();
  t.mock.timers.tick(SAVE_BEFORE_CLOSE_MS);
  assert.deepEqual(calls, ['save', 'close']);
  closeGuard.ready(true);
  assert.deepEqual(calls, ['save', 'close'], 'a late answer does nothing');
});
