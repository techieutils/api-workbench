import { reactive } from 'vue';

/**
 * In-app confirmation, in place of `window.confirm`: `await confirmAction({...})` resolves to
 * true when the person confirms. Requests made while one is open wait their turn.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The confirming button's label, such as "Delete request". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirming button as destructive and focuses Cancel first. */
  tone?: 'danger' | 'default';
}
interface Pending extends ConfirmOptions {
  resolve(confirmed: boolean): void;
}
export const confirmation = reactive<{ current?: Pending; queue: Pending[] }>({ queue: [] });

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const request = { ...options, resolve };
    if (confirmation.current) confirmation.queue.push(request);
    else confirmation.current = request;
  });
}
/** Answers the open confirmation and shows the next one, if any. */
export function settleConfirmation(confirmed: boolean): void {
  const current = confirmation.current;
  confirmation.current = confirmation.queue.shift();
  current?.resolve(confirmed);
}
