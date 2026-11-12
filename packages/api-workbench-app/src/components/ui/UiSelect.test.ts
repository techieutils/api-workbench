import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import UiSelect from './UiSelect.vue';

const options = [
  { value: 'get', label: 'GET', group: 'Read' },
  { value: 'head', label: 'HEAD', group: 'Read', description: 'Headers only' },
  { value: 'post', label: 'POST', group: 'Write' },
  { value: 'delete', label: 'DELETE', group: 'Write', disabled: true },
];
const select = (props: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) =>
  mount(UiSelect, { attachTo: document.body, props: { options, value: 'get', ...props }, attrs });

describe('UiSelect', () => {
  it('shows the chosen label on a combobox, backed by a native select', () => {
    const wrapper = select({}, { id: 'method', 'aria-label': 'Method', 'data-field': 'method' });
    const trigger = wrapper.find('[role=combobox]');
    expect(trigger.text()).toContain('GET');
    expect(trigger.attributes('aria-label')).toBe('Method');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    // Identity and data attributes go to the native select, for forms and scripts.
    const native = wrapper.find('select');
    expect(native.attributes('id')).toBe('method');
    expect(native.attributes('data-field')).toBe('method');
    expect(native.findAll('optgroup').map((group) => group.attributes('label'))).toEqual([
      'Read',
      'Write',
    ]);
    expect((native.element as HTMLSelectElement).value).toBe('get');
    wrapper.unmount();
  });

  it('accepts plain strings and [value, label] pairs', () => {
    const wrapper = mount(UiSelect, { props: { options: ['a', ['b', 'Bee']], value: 'b' } });
    expect(wrapper.find('[role=combobox]').text()).toContain('Bee');
    expect(wrapper.findAll('select option').map((option) => option.text())).toEqual(['a', 'Bee']);
  });

  it('shows a placeholder until something is chosen', () => {
    const wrapper = mount(UiSelect, { props: { options, placeholder: 'Choose a method' } });
    expect(wrapper.find('.ui-select-value').classes()).toContain('placeholder');
    expect(wrapper.find('.ui-select-value').text()).toBe('Choose a method');
  });

  it('opens a listbox with group headings, and a choice fires change on the native select', async () => {
    const changed = vi.fn();
    const wrapper = select({}, { onChange: changed, 'onUpdate:modelValue': vi.fn() });
    await wrapper.find('[role=combobox]').trigger('click');
    expect(wrapper.find('[role=combobox]').attributes('aria-expanded')).toBe('true');
    const listed = wrapper.findAll('[role=option]');
    expect(listed.map((option) => option.text())).toEqual([
      'GET',
      expect.stringContaining('HEAD'),
      'POST',
      'DELETE',
    ]);
    expect(wrapper.text()).toContain('Headers only');
    await listed[2].trigger('click');
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0].target as HTMLSelectElement).value).toBe('post');
    expect(wrapper.emitted('update:modelValue')).toEqual([['post']]);
    expect(wrapper.find('[role=combobox]').text()).toContain('POST');
    wrapper.unmount();
  });

  it('skips disabled options and moves with the keyboard', async () => {
    const wrapper = select();
    const trigger = wrapper.find('[role=combobox]');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(trigger.attributes('aria-expanded')).toBe('true');
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown'])
      await trigger.trigger('keydown', { key });
    await trigger.trigger('keydown', { key: 'Enter' });
    // DELETE is disabled, so the last option reachable is POST.
    expect(wrapper.emitted('update:modelValue')).toEqual([['post']]);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('closes on Escape without choosing', async () => {
    const wrapper = select();
    const trigger = wrapper.find('[role=combobox]');
    await trigger.trigger('keydown', { key: 'Enter' });
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });

  it('chooses by typing the start of a label while closed', async () => {
    const wrapper = select();
    await wrapper.find('[role=combobox]').trigger('keydown', { key: 'p' });
    expect(wrapper.emitted('update:modelValue')).toEqual([['post']]);
    wrapper.unmount();
  });

  it('filters long lists by what is typed in its search field', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      value: `v${index}`,
      label: `Option ${index}`,
    }));
    const wrapper = mount(UiSelect, {
      attachTo: document.body,
      props: { options: many, value: 'v0' },
    });
    await wrapper.find('[role=combobox]').trigger('click');
    const search = wrapper.find('input');
    expect(search.exists()).toBe(true);
    await search.setValue('11');
    expect(wrapper.findAll('[role=option]').map((option) => option.text())).toEqual(['Option 11']);
    wrapper.unmount();
  });

  it('does not open while disabled', async () => {
    const wrapper = select({}, { disabled: true });
    await wrapper.find('[role=combobox]').trigger('click');
    expect(wrapper.find('[role=combobox]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.classes()).toContain('disabled');
    wrapper.unmount();
  });
});
