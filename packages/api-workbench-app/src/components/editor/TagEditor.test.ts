import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TagEditor from './TagEditor.vue';
import { request, workspaceWith } from '../../test/workspace';

const editor = (props: Record<string, unknown> = {}) => {
  workspaceWith([request('A', 'Users', { tags: ['smoke', 'billing'] })], {
    collectionTags: { Users: ['users'] },
  });
  return mount(TagEditor, {
    attachTo: document.body,
    props: { tags: ['smoke'], owner: 'Request', ...props },
  });
};
const lastChange = (wrapper: ReturnType<typeof editor>) =>
  wrapper.emitted<[string[]]>('change')!.at(-1)![0];

describe('TagEditor', () => {
  it('shows inherited tags first, then its own, each removable', async () => {
    const wrapper = editor({ inherited: [{ tag: 'users', from: 'Users' }] });
    expect(wrapper.find('[data-inherited-tag=users]').attributes('title')).toContain(
      "collection's tags",
    );
    expect(wrapper.find('[data-inherited-tag=users] button').exists()).toBe(false);
    await wrapper.find('[data-tag=smoke] button').trigger('click');
    expect(lastChange(wrapper)).toEqual([]);
    wrapper.unmount();
  });

  it('adds several tags at once, with or without #', async () => {
    const wrapper = editor();
    await wrapper.find('[data-action=add-tag]').trigger('click');
    const field = wrapper.find('[data-tag-input]');
    expect(document.activeElement).toBe(field.element);
    await field.setValue('#auth, slow');
    await field.trigger('keydown', { key: 'Enter' });
    expect(lastChange(wrapper)).toEqual(['smoke', 'auth', 'slow']);
    wrapper.unmount();
  });

  it('suggests the workspace’s other tags', async () => {
    const wrapper = editor();
    await wrapper.find('[data-action=add-tag]').trigger('click');
    const suggested = wrapper
      .findAll('datalist option')
      .map((option) => option.attributes('value'));
    expect(suggested).toEqual(expect.arrayContaining(['billing', 'users']));
    expect(suggested).not.toContain('smoke');
    wrapper.unmount();
  });

  it('explains a tag it cannot add, and keeps the field open', async () => {
    const wrapper = editor({ inherited: [{ tag: 'users', from: 'Users' }] });
    await wrapper.find('[data-action=add-tag]').trigger('click');
    const field = wrapper.find('[data-tag-input]');
    for (const [typed, problem] of [
      ['Smoke', 'It is already tagged smoke.'],
      ['users', 'It already has users from Users.'],
      ['two-words!', 'Start with a letter or digit'],
    ]) {
      await field.setValue(typed);
      await field.trigger('keydown', { key: 'Enter' });
      expect(wrapper.find('[role=alert]').text()).toContain(problem);
    }
    expect(wrapper.emitted('change')).toBeUndefined();
    // An empty field closes, clearing the message.
    await field.setValue('');
    await field.trigger('blur');
    expect(wrapper.find('[role=alert]').exists()).toBe(false);
    expect(wrapper.find('[data-tag-input]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('removes the last tag with Backspace in an empty field, and closes on Escape', async () => {
    const wrapper = editor({ tags: ['smoke', 'auth'] });
    await wrapper.find('[data-action=add-tag]').trigger('click');
    const field = wrapper.find('[data-tag-input]');
    await field.trigger('keydown', { key: 'Backspace' });
    expect(lastChange(wrapper)).toEqual(['smoke']);
    await field.setValue('half');
    await field.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-tag-input]').exists()).toBe(false);
    expect(wrapper.emitted('change')).toHaveLength(1);
    wrapper.unmount();
  });
});
