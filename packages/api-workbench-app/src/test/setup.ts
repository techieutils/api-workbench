import { afterEach, vi } from 'vitest';

/**
 * Stores call render() from the shell after changing the workspace; in the app it mounts the whole
 * interface. Tests read the stores and components directly, so it does nothing here.
 */
vi.mock('../shell', () => ({ render: vi.fn(), mount: vi.fn() }));

/**
 * What the app's page loads before Vue, for component tests: the icon paths (index.html loads
 * mdi-paths.js). Any icon name gets a path, so a test sees which icon a component chose through
 * the `data-mdi` attribute instead.
 */
(globalThis as { mdiPaths?: unknown }).mdiPaths = new Proxy({}, { get: () => 'M0 0h24v24H0z' });

/**
 * The Popover API, which happy-dom does not have yet: the select list and menus open in the top
 * layer with showPopover(), and check `:popover-open`. Open elements are tracked here.
 */
const openPopovers = new WeakSet<Element>();
const proto = HTMLElement.prototype as HTMLElement & Record<string, unknown>;
if (!('showPopover' in proto)) {
  const toggle = (element: HTMLElement, open: boolean) => {
    if (open === openPopovers.has(element)) return;
    if (open) openPopovers.add(element);
    else openPopovers.delete(element);
    const event = new Event('toggle') as Event & { newState: string; oldState: string };
    Object.assign(event, {
      newState: open ? 'open' : 'closed',
      oldState: open ? 'closed' : 'open',
    });
    element.dispatchEvent(event);
  };
  Object.assign(proto, {
    showPopover(this: HTMLElement) {
      toggle(this, true);
    },
    hidePopover(this: HTMLElement) {
      toggle(this, false);
    },
    togglePopover(this: HTMLElement, force?: boolean) {
      toggle(this, force ?? !openPopovers.has(this));
      return openPopovers.has(this);
    },
  });
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ':popover-open' ? openPopovers.has(this) : matches.call(this, selector);
  } as typeof Element.prototype.matches;
}

afterEach(() => {
  document.body.innerHTML = '';
});
