import { reactive } from 'vue';

/**
 * Toast notifications: short, non-blocking messages about what just happened. `toast()` in
 * utils.ts adds one; ToastHost shows them in the bottom-right corner.
 */
export type ToastTone = 'success' | 'error' | 'warning' | 'info';
export interface ToastOptions {
  tone?: ToastTone;
  title?: string;
  /** One follow-up action, such as "Open"; choosing it dismisses the toast. */
  action?: { label: string; run(): unknown };
  /** How long it stays, in milliseconds; by default longer for errors and long messages. */
  duration?: number;
}
export interface ToastItem extends Required<Pick<ToastOptions, 'tone' | 'duration'>> {
  id: number;
  message: string;
  title?: string;
  action?: ToastOptions['action'];
  /** Bumped when the same message is shown again, which restarts its timer. */
  version: number;
}

const VISIBLE_LIMIT = 4;
const BASE_DURATION: Record<ToastTone, number> = {
  success: 3500,
  info: 3500,
  warning: 6000,
  error: 8000,
};
let nextId = 1;
export const toasts = reactive<ToastItem[]>([]);

export function showToast(message: string, options: ToastOptions = {}): number {
  const tone = options.tone ?? 'info';
  // Reading time: about 15 characters a second beyond the first few words, up to 6 seconds more.
  const duration =
    options.duration ?? BASE_DURATION[tone] + Math.min(6000, Math.max(0, message.length - 40) * 60);
  const repeat = toasts.find((item) => item.message === message && item.tone === tone);
  if (repeat) {
    repeat.version++;
    repeat.duration = duration;
    return repeat.id;
  }
  const item: ToastItem = {
    id: nextId++,
    message,
    tone,
    title: options.title,
    action: options.action,
    duration,
    version: 0,
  };
  toasts.push(item);
  if (toasts.length > VISIBLE_LIMIT) toasts.splice(0, toasts.length - VISIBLE_LIMIT);
  return item.id;
}
export function dismissToast(id: number): void {
  const index = toasts.findIndex((item) => item.id === id);
  if (index >= 0) toasts.splice(index, 1);
}
export function clearToasts(): void {
  toasts.splice(0);
}
