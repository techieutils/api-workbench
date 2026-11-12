import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import UiButton from './UiButton.vue';

describe('UiButton', () => {
  it('is a secondary button by default, with its label', () => {
    const button = mount(UiButton, { props: { label: 'Save' } });
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('type')).toBe('button');
    expect(button.classes()).toEqual(['ui-button', 'ui-button-secondary']);
    expect(button.text()).toBe('Save');
    expect(button.find('svg').exists()).toBe(false);
  });

  it('shows its icon, variant, and shortcut, and can submit a form', () => {
    const button = mount(UiButton, {
      props: {
        label: 'Send',
        icon: 'arrow-top-right',
        variant: 'primary',
        type: 'submit',
        shortcut: '⌘↵',
      },
    });
    expect(button.attributes('type')).toBe('submit');
    expect(button.classes()).toContain('ui-button-primary');
    expect(button.find('svg').attributes('data-mdi')).toBe('arrow-top-right');
    expect(button.find('kbd').text()).toBe('⌘↵');
  });

  it('passes clicks on, and none while disabled', async () => {
    const enabled = mount(UiButton, { props: { label: 'Go' } });
    await enabled.trigger('click');
    expect(enabled.emitted('click')).toHaveLength(1);
    const disabled = mount(UiButton, { props: { label: 'Go', disabled: true } });
    expect(disabled.attributes('disabled')).toBeDefined();
  });
});
