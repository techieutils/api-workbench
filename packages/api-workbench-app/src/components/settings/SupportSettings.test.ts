import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SupportSettings from './SupportSettings.vue';
import { workspaceWith } from '../../test/workspace';

describe('Settings → Help', () => {
  afterEach(() => {
    delete (window as { workbench?: unknown }).workbench;
  });

  it('opens GitHub’s forms and the documentation, with the version filled in', async () => {
    workspaceWith([]);
    const opened: string[] = [];
    (window as unknown as { workbench: unknown }).workbench = {
      openExternal: vi.fn(async (url: string) => void opened.push(url)),
      updates: {
        info: async () => ({
          currentVersion: '1.4.2',
          preferences: { mode: 'notify' },
          status: { state: 'idle' },
        }),
        onChange: () => () => undefined,
      },
    };
    const wrapper = mount(SupportSettings, { attachTo: document.body });
    await flushPromises();
    const click = async (label: string) => {
      const button = wrapper.findAll('button').find((item) => item.text() === label);
      expect(button, label).toBeTruthy();
      await button!.trigger('click');
    };
    await click('Report a problem');
    const report = new URL(opened.at(-1)!);
    expect(report.pathname).toBe('/techieutils/api-workbench/issues/new');
    expect(report.searchParams.get('template')).toBe('bug_report.yml');
    expect(report.searchParams.get('extra')).toContain('API Workbench');
    await click('Request a feature');
    expect(opened.at(-1)).toContain('template=feature_request.yml');
    await click('Report privately');
    expect(opened.at(-1)).toBe(
      'https://github.com/techieutils/api-workbench/security/advisories/new',
    );
    await click('Open documentation');
    expect(opened.at(-1)).toBe('https://techieutils.github.io/api-workbench/docs/index.html');
    // Only the app's own addresses, nothing from a workspace.
    for (const url of opened)
      expect(url).toMatch(/^https:\/\/(github\.com|techieutils\.github\.io)\//);
    wrapper.unmount();
  });
});
