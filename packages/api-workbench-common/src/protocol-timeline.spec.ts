import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolTimeline } from './protocol-timeline';
import type { ProtocolEvent } from './types';
const event = (
  type: ProtocolEvent['type'],
  at: number,
  data = '',
  extra: Partial<ProtocolEvent> = {},
): ProtocolEvent => ({ sessionId: 'timeline', type, at, data, ...extra });
test('session phases and message activity use captured offsets and durations', () => {
  const events = [
    event('connecting', 1000),
    event('open', 1010),
    event('sent', 1020, 'hi'),
    event('message', 1030, 'one'),
    event('message', 1050, 'two'),
    event('closed', 1060),
  ];
  const before = JSON.stringify(events);
  const report = buildProtocolTimeline(events);
  assert.equal(report.durationMs, 60);
  assert.equal(report.connectionMs, 10);
  assert.equal(report.firstMessageMs, 30);
  assert.deepEqual(
    report.phases.map((phase) => [phase.label, phase.startMs, phase.durationMs]),
    [
      ['Opening session', 0, 10],
      ['Waiting for first message', 10, 20],
      ['Receiving messages', 30, 20],
      ['After last message', 50, 10],
    ],
  );
  assert.equal(report.sentMessages, 1);
  assert.equal(report.receivedMessages, 2);
  assert.equal(report.sentBytes, 2);
  assert.equal(report.receivedBytes, 6);
  assert.equal(report.closed, true);
  assert.equal(
    JSON.stringify(events),
    before,
    'building a timeline never changes the captured events',
  );
  assert.deepEqual(
    report.events.map((item) => item.offsetMs),
    [0, 10, 20, 30, 50, 60],
  );
});
test('Unicode and binary data counts use decoded bytes', () => {
  const report = buildProtocolTimeline([
    event('connecting', 1),
    event('sent', 2, 'café'),
    event('message', 3, 'AAH/', { binary: true }),
  ]);
  assert.equal(report.sentBytes, 5);
  assert.equal(report.receivedBytes, 3);
});
test('failed opening attempts do not invent connection or first-message timings', () => {
  const report = buildProtocolTimeline([
    event('connecting', 50),
    event('error', 80, 'Failed'),
    event('closed', 80),
  ]);
  assert.equal(report.connectionMs, null);
  assert.equal(report.firstMessageMs, null);
  assert.equal(report.errors, 1);
  assert.equal(report.phases[0].durationMs, 30);
  assert.match(report.phases[0].label, /incomplete/);
});
test('retained partial histories do not report unknown setup timings', () => {
  const report = buildProtocolTimeline([
    event('message', 200, 'first retained'),
    event('message', 250, 'last retained'),
  ]);
  assert.equal(report.partial, true);
  assert.equal(report.durationMs, 50);
  assert.equal(report.connectionMs, null);
  assert.equal(report.firstMessageMs, null);
  assert.equal(
    report.phases.some((phase) => phase.label === 'Opening session'),
    false,
  );
});
test('live waiting sessions and empty or simultaneous events stay finite', () => {
  const empty = buildProtocolTimeline([]);
  assert.equal(empty.startedAt, null);
  assert.equal(empty.durationMs, 0);
  assert.deepEqual(empty.phases, []);
  const waiting = buildProtocolTimeline([
    event('connecting', 5),
    event('open', 10),
    event('status', 20),
  ]);
  assert.equal(waiting.firstMessageMs, null);
  assert.equal(waiting.phases[1].durationMs, 10);
  const immediate = buildProtocolTimeline([
    event('connecting', 5),
    event('open', 5),
    event('message', 5),
    event('closed', 5),
  ]);
  assert.equal(immediate.durationMs, 0);
  assert.ok(
    immediate.phases.every((phase) => Number.isFinite(phase.durationMs) && phase.durationMs >= 0),
  );
});
