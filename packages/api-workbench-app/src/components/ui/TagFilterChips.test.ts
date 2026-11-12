import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { emptyTagFilter, type TagFilter } from '@techieutils/api-workbench-common/tags';
import TagFilterChips from './TagFilterChips.vue';

const counts = [
  { tag: 'smoke', count: 3 },
  { tag: 'auth', count: 1 },
  { tag: 'slow', count: 2 },
  { tag: 'beta', count: 1 },
];
const chips = (filter: TagFilter = emptyTagFilter(), props: Record<string, unknown> = {}) =>
  mount(TagFilterChips, { props: { counts, filter, verb: 'run', ...props } });
const lastChange = (wrapper: ReturnType<typeof chips>) =>
  wrapper.emitted<[TagFilter]>('change')!.at(-1)![0];

describe('TagFilterChips', () => {
  it('lists each tag with its count, all off, with help', () => {
    const wrapper = chips();
    const tags = wrapper.findAll('[data-runner-tag]');
    expect(
      tags.map((tag) => [tag.attributes('data-runner-tag'), tag.attributes('data-state')]),
    ).toEqual([
      ['smoke', 'off'],
      ['auth', 'off'],
      ['slow', 'off'],
      ['beta', 'off'],
    ]);
    expect(tags[0].find('.runner-tag-count').text()).toBe('3');
    expect(tags[1].attributes('aria-label')).toBe(
      'auth, 1 request. Click to run only requests with it.',
    );
    expect(wrapper.find('[data-action=clear-tag-filter]').exists()).toBe(false);
    expect(wrapper.find('.runner-tags-help').text()).toContain('Click a tag to run only requests');
  });

  it('cycles a tag from off to required to left out and back', async () => {
    const wrapper = chips();
    await wrapper.find('[data-runner-tag=smoke]').trigger('click');
    expect(lastChange(wrapper)).toEqual({ include: ['smoke'], mode: 'any', exclude: [] });
    await wrapper.setProps({ filter: lastChange(wrapper) });
    expect(wrapper.find('[data-runner-tag=smoke]').attributes('data-state')).toBe('include');
    expect(wrapper.find('[data-runner-tag=smoke] svg').attributes('data-mdi')).toBe(
      'check-circle-outline',
    );
    await wrapper.find('[data-runner-tag=smoke]').trigger('click');
    expect(lastChange(wrapper)).toEqual({ include: [], mode: 'any', exclude: ['smoke'] });
    await wrapper.setProps({ filter: lastChange(wrapper) });
    expect(wrapper.find('[data-runner-tag=smoke] svg').attributes('data-mdi')).toBe(
      'minus-circle-outline',
    );
    await wrapper.find('[data-runner-tag=smoke]').trigger('click');
    expect(lastChange(wrapper)).toEqual(emptyTagFilter());
  });

  it('offers Any or All only with two tags required, and Clear while filtering', async () => {
    const wrapper = chips({ include: ['smoke', 'auth'], mode: 'any', exclude: [] });
    expect(wrapper.find('[data-runner-tag-mode=any]').attributes('aria-pressed')).toBe('true');
    await wrapper.find('[data-runner-tag-mode=all]').trigger('click');
    expect(lastChange(wrapper).mode).toBe('all');
    await wrapper.find('[data-action=clear-tag-filter]').trigger('click');
    expect(lastChange(wrapper)).toEqual(emptyTagFilter());
    expect(wrapper.find('.runner-tags-help').text()).toBe('Running requests tagged smoke or auth.');
    const one = chips({ include: ['smoke'], mode: 'any', exclude: [] });
    expect(one.find('[data-runner-tag-mode]').exists()).toBe(false);
  });

  it('shows a few tags, keeping chosen ones in view, until More is clicked', async () => {
    const wrapper = chips({ include: ['beta'], mode: 'any', exclude: [] }, { limit: 2 });
    expect(
      wrapper.findAll('[data-runner-tag]').map((tag) => tag.attributes('data-runner-tag')),
    ).toEqual(['beta', 'smoke']);
    const more = wrapper.find('[data-tag-filter-more]');
    expect(more.text()).toBe('2 more');
    await more.trigger('click');
    expect(wrapper.findAll('[data-runner-tag]')).toHaveLength(4);
    expect(wrapper.find('[data-tag-filter-more]').text()).toBe('Fewer');
  });

  it('counts with its own noun and verb, and can be disabled', () => {
    const wrapper = chips(emptyTagFilter(), {
      verb: 'show',
      noun: ['entry', 'entries'],
      disabled: true,
    });
    expect(wrapper.find('[data-runner-tag=smoke]').attributes('aria-label')).toBe(
      'smoke, 3 entries. Click to show only requests with it.',
    );
    expect(
      wrapper.findAll('[data-runner-tag]').every((tag) => tag.attributes('disabled') !== undefined),
    ).toBe(true);
  });
});
