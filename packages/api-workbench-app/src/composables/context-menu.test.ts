import { describe, expect, it } from 'vitest';
import { useContextMenu } from './context-menu';

describe('useContextMenu', () => {
  it('keeps an object target as the row’s own object', () => {
    // Actions find the row by identity, e.g. removing a cookie from the jar with `!==`.
    const { target, open } = useContextMenu<{ cookie: { name: string } }>();
    const cookie = { name: 'session' };
    const row = document.createElement('tr');
    const event = new MouseEvent('contextmenu', { clientX: 1, clientY: 2 });
    Object.defineProperty(event, 'currentTarget', { value: row });
    open(event, { cookie });
    expect(target.value?.cookie).toBe(cookie);
    expect([cookie].indexOf(target.value!.cookie)).toBe(0);
  });
});
