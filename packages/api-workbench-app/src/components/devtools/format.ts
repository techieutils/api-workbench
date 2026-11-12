import type { NetworkPhase } from '@techieutils/api-workbench-common/types';

/** A byte count as B, KB, or MB. */
export function formatBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** A duration in milliseconds, or seconds from ten seconds up. */
export function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** The colour class for a status: success, redirect, client or server error, or failure. */
export function statusTone(entry: Pick<NetworkEntry, 'status' | 'error'>): string {
  if (entry.error !== undefined || entry.status === undefined) return 'tone-failed';
  if (entry.status >= 500) return 'tone-server';
  if (entry.status >= 400) return 'tone-client';
  if (entry.status >= 300) return 'tone-redirect';
  return 'tone-ok';
}

/** The phases of a request's final hop, the one that produced its response. */
export function finalPhases(entry: NetworkEntry): NetworkPhase[] {
  return entry.timings?.requests.at(-1)?.phases.filter((phase) => phase.durationMs > 0) ?? [];
}

/** The value at a percentile (0–100) of ascending values. */
export function percentile(sorted: number[], rank: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)];
}
