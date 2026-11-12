import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UiTabs from './UiTabs.vue';

const items: UITab[] = [
  { name: 'Params', icon: 'tune-variant', count: 2 },
  { name: 'Headers', count: 0 },
  { name: 'Body' },
];
const tabs = (props: Record<string, unknown> = {}) =>
  mount(UiTabs, {
    attachTo: document.body,
    props: {
      group: 'request',
      label: 'Request',
      items,
      active: 'Headers',
      attribute: 'data-request-tab',
      ...props,
    },
  });

describe('UiTabs', () => {
  it('is an ARIA tab list with only the active tab in the tab order', () => {
    const wrapper = tabs();
    // The list is the scrolling row inside ScrollRow, which also holds the scroll arrows.
    const list = wrapper.find('[role=tablist]');
    expect(list.attributes('aria-label')).toBe('Request');
    const buttons = wrapper.findAll('[role=tab]');
    expect(buttons.map((tab) => tab.attributes('data-request-tab'))).toEqual([
      'Params',
      'Headers',
      'Body',
    ]);
    expect(buttons.map((tab) => tab.attributes('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(buttons.map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(buttons[1].attributes('aria-controls')).toBe('request-panel');
    expect(buttons[0].attributes('id')).toBe('request-tab-params');
  });

  it('shows counts other than zero, and icons', () => {
    const wrapper = tabs();
    const [params, headers] = wrapper.findAll('[role=tab]');
    expect(params.find('.count').text()).toBe('2');
    expect(params.find('svg').attributes('data-mdi')).toBe('tune-variant');
    expect(headers.find('.count').exists()).toBe(false);
  });

  it('selects a tab on click', async () => {
    const wrapper = tabs();
    await wrapper.findAll('[role=tab]')[2].trigger('click');
    expect(wrapper.emitted('select')).toEqual([['Body']]);
  });

  it('moves with the arrow keys, wrapping, and with Home and End', async () => {
    const wrapper = tabs();
    const headers = wrapper.find<HTMLButtonElement>('[data-request-tab=Headers]');
    headers.element.focus();
    // Each key is pressed on the tab that has focus, as a person would.
    for (const key of ['ArrowRight', 'ArrowRight', 'Home', 'End', 'ArrowLeft'])
      await wrapper.find('[role=tablist]').trigger('keydown', { key });
    expect(wrapper.emitted('select')).toEqual([
      ['Body'],
      ['Params'],
      ['Params'],
      ['Body'],
      ['Headers'],
    ]);
    // Focus follows the selection, as ARIA tabs expect.
    expect(document.activeElement?.getAttribute('data-request-tab')).toBe('Headers');
    wrapper.unmount();
  });

  it('ignores keys and clicks while disabled', async () => {
    const wrapper = tabs({ disabled: true });
    await wrapper.find('[role=tablist]').trigger('keydown', { key: 'ArrowRight' });
    expect(
      wrapper.findAll('[role=tab]').every((tab) => tab.attributes('disabled') !== undefined),
    ).toBe(true);
    expect(wrapper.emitted('select')).toBeUndefined();
    wrapper.unmount();
  });
});
