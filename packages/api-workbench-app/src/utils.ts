/** Small helpers shared by the stores and components. */
import { showToast, type ToastOptions, type ToastTone } from './notifications';

/** An error's message, without the prefix Electron adds to errors thrown in the main process. */
export const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  );

export const uid = (): string => crypto.randomUUID();

/**
 * Shows a toast. Pass a tone (or options) so it reads at a glance: 'success' for completed
 * actions, 'error' for failures, 'warning' for things to fix first, and 'info' otherwise.
 */
export function toast(message: string, options: ToastOptions | ToastTone = {}): void {
  showToast(message, typeof options === 'string' ? { tone: options } : options);
}

/** How long ago a moment was, briefly: "Just now", "5 min ago", "2 h ago", or the date. */
export function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'Just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return date.toLocaleDateString();
}

/** Saves text as a file through a temporary object URL. */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const objectIds = new WeakMap<object, string>();
let objectCount = 0;
/** A stable id per object, for keying views on values that are replaced, not mutated. */
export function objectId(value: object | null | undefined): string {
  if (!value) return '';
  if (!objectIds.has(value)) objectIds.set(value, String(++objectCount));
  return objectIds.get(value)!;
}
