import type { ProtocolEvent } from './types';
export interface ProtocolTimelinePhase {
  id: string;
  label: string;
  startMs: number;
  durationMs: number;
}
export function protocolEventBytes(event: ProtocolEvent): number {
  if (event.binary) {
    try {
      return atob(event.data).length;
    } catch {
      /* Keep malformed diagnostic events inspectable. */
    }
  }
  return new TextEncoder().encode(event.data).length;
}
/** Durations come only from recorded application events, never inferred network phases. */
export function buildProtocolTimeline(source: readonly ProtocolEvent[]) {
  const events = source.map((event) => ({ ...event }));
  const opening = events.find((event) => event.type === 'connecting');
  const startedAt = opening?.at ?? events[0]?.at ?? null;
  const start = startedAt ?? 0;
  const offset = (event: ProtocolEvent) => Math.max(0, event.at - start);
  const durationMs = Math.max(0, ...events.map(offset));
  const ready =
    events.find((event) => event.type === 'open') ??
    events.find((event) => event.type === 'metadata');
  const received = events.filter((event) => event.type === 'message');
  const sent = events.filter((event) => event.type === 'sent');
  const first = received[0];
  const last = received.at(-1);
  const phases: ProtocolTimelinePhase[] = [];
  const add = (id: string, label: string, from: number, to: number) =>
    phases.push({ id, label, startMs: from, durationMs: Math.max(0, to - from) });
  if (opening)
    add(
      'stalled',
      ready ? 'Opening session' : 'Opening session (incomplete)',
      0,
      ready ? offset(ready) : durationMs,
    );
  if (ready)
    add(
      'waiting',
      first ? 'Waiting for first message' : 'Waiting for messages',
      offset(ready),
      first ? Math.max(offset(ready), offset(first)) : durationMs,
    );
  if (first && last) {
    add(
      'download',
      received.length === 1 ? 'First message' : 'Receiving messages',
      offset(first),
      offset(last),
    );
    if (durationMs > offset(last)) add('queueing', 'After last message', offset(last), durationMs);
  }
  return {
    startedAt,
    durationMs,
    partial: events.length > 0 && !opening,
    connectionMs: opening && ready ? offset(ready) : null,
    firstMessageMs: opening && first ? offset(first) : null,
    sentMessages: sent.length,
    receivedMessages: received.length,
    sentBytes: sent.reduce((sum, event) => sum + protocolEventBytes(event), 0),
    receivedBytes: received.reduce((sum, event) => sum + protocolEventBytes(event), 0),
    errors: events.filter((event) => event.type === 'error').length,
    closed: events.some((event) => event.type === 'closed'),
    phases,
    events: events.map((event) => ({ ...event, offsetMs: offset(event) })),
  };
}
