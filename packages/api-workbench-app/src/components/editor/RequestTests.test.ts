import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RequestTests from './RequestTests.vue';
import { request, workspaceWith } from '../../test/workspace';

const choose = async (wrapper: ReturnType<typeof mount>, field: string, value: string) => {
  const select = wrapper.find<HTMLSelectElement>(`select[data-case-field=${field}]`);
  select.element.value = value;
  await select.trigger('change');
};
const preview = (wrapper: ReturnType<typeof mount>) => wrapper.find('#test-case-preview').text();

describe('the test case builder', () => {
  function builder() {
    const workspace = workspaceWith([request('A', 'Users', { tests: '' })]);
    return { workspace, wrapper: mount(RequestTests, { attachTo: document.body }) };
  }

  it('previews the assertion as each field changes, not only the kind of check', async () => {
    const { wrapper } = builder();
    expect(preview(wrapper)).toBe('status 200');
    await choose(wrapper, 'kind', 'cookie');
    expect(preview(wrapper)).toBe('cookie-exists session');
    // This once kept showing the previous assertion until the kind changed.
    await choose(wrapper, 'operator', 'is-uuid');
    expect(preview(wrapper)).toBe('cookie session is-uuid');
    expect(wrapper.find('input[data-case-field=value]').exists()).toBe(false);
    const name = wrapper.find('input[data-case-field=target]');
    await name.setValue('request_id');
    expect(preview(wrapper)).toBe('cookie request_id is-uuid');
    wrapper.unmount();
  });

  it('offers network timings as a list, and numbers for them', async () => {
    const { wrapper } = builder();
    await choose(wrapper, 'kind', 'timing');
    expect(
      wrapper
        .findAll('select[data-case-field=target] option')
        .map((option) => option.attributes('value')),
    ).toContain('ttfb');
    await choose(wrapper, 'target', 'dns');
    const value = wrapper.find('input[data-case-field=value]');
    expect(value.attributes('type')).toBe('number');
    await value.setValue('40');
    expect(preview(wrapper)).toBe('timing dns < 40');
    wrapper.unmount();
  });

  it('saves a case into the request’s tests, named', async () => {
    const { wrapper, workspace } = builder();
    await choose(wrapper, 'kind', 'json');
    await wrapper.find('input[data-case-field=target]').setValue('$.roles');
    await choose(wrapper, 'operator', 'contains-all');
    await wrapper.find('input[data-case-field=value]').setValue('"read", "write"');
    await wrapper.find('input[data-case-field=name]').setValue('Has roles');
    await wrapper.find('#test-case-form').trigger('submit');
    await flushPromises();
    expect(workspace.current().tests).toBe(
      '// @case "Has roles"\njson $.roles contains-all ["read","write"]',
    );
    wrapper.unmount();
  });

  it('explains what is wrong instead of saving', async () => {
    const { wrapper, workspace } = builder();
    await choose(wrapper, 'kind', 'cookie');
    await wrapper.find('input[data-case-field=target]').setValue('two words');
    await wrapper.find('#test-case-form').trigger('submit');
    expect(wrapper.find('#test-case-error').text()).toContain('cookie name');
    expect(workspace.current().tests).toBe('');
    wrapper.unmount();
  });
});
