import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UiEmptyState from './UiEmptyState.vue';
import UiExpansionPanel from './UiExpansionPanel.vue';
import UiField from './UiField.vue';

describe('UiExpansionPanel', () => {
  it('is a details disclosure with its title, description, icon, and badge', () => {
    const wrapper = mount(UiExpansionPanel, {
      props: { title: 'Proxy', description: 'Optional', icon: 'lan', badge: '2' },
      slots: { default: '<p>Inside</p>' },
    });
    expect(wrapper.element.tagName).toBe('DETAILS');
    expect(wrapper.find('summary strong').text()).toBe('Proxy');
    expect(wrapper.find('summary small').text()).toBe('Optional');
    expect(wrapper.find('.ui-expansion-icon').attributes('data-mdi')).toBe('lan');
    expect(wrapper.find('.ui-expansion-badge').text()).toBe('2');
    expect(wrapper.find('.ui-expansion-body').text()).toBe('Inside');
    expect((wrapper.element as HTMLDetailsElement).open).toBe(false);
  });

  it('reports the person’s toggles, and follows the open prop when it changes', async () => {
    const wrapper = mount(UiExpansionPanel, { props: { title: 'More', open: false } });
    const details = wrapper.element as HTMLDetailsElement;
    details.open = true;
    await wrapper.trigger('toggle');
    expect(wrapper.emitted('update:open')).toEqual([[true]]);
    // A new value of the prop wins over the person's choice; the same value again changes nothing.
    await wrapper.setProps({ open: false });
    expect(details.open).toBe(true);
    await wrapper.setProps({ open: true });
    await wrapper.setProps({ open: false });
    expect(details.open).toBe(false);
  });

  it('opens when a field inside fails validation, so it can be shown', async () => {
    const wrapper = mount(UiExpansionPanel, {
      props: { title: 'Required' },
      slots: { default: '<input required />' },
    });
    await wrapper.find('input').trigger('invalid');
    expect((wrapper.element as HTMLDetailsElement).open).toBe(true);
  });
});

describe('UiField', () => {
  it('is a labelled input that passes other attributes on', () => {
    const wrapper = mount(UiField, {
      props: { label: 'Name', name: 'name', value: 'Ada', required: true, help: 'Shown in lists' },
      attrs: { maxlength: '40', autocomplete: 'off' },
    });
    const input = wrapper.find('input');
    expect(wrapper.element.tagName).toBe('LABEL');
    expect(wrapper.text()).toContain('Name*');
    expect(input.attributes()).toMatchObject({
      name: 'name',
      type: 'text',
      maxlength: '40',
      autocomplete: 'off',
    });
    expect((input.element as HTMLInputElement).value).toBe('Ada');
    expect((input.element as HTMLInputElement).required).toBe(true);
    expect(wrapper.find('.field-help').text()).toBe('Shown in lists');
  });
});

describe('UiEmptyState', () => {
  it('shows an icon, a title, a description, and actions', () => {
    const wrapper = mount(UiEmptyState, {
      props: { icon: 'history', title: 'No history', description: 'Send a request.' },
      slots: { default: '<button>Send</button>' },
    });
    expect(wrapper.find('svg').attributes('data-mdi')).toBe('history');
    expect(wrapper.find('h3').text()).toBe('No history');
    expect(wrapper.find('p').text()).toBe('Send a request.');
    expect(wrapper.find('button').text()).toBe('Send');
  });
});
