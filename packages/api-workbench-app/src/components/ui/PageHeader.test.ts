import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import PageHeader from './PageHeader.vue';
import GuideButton from './GuideButton.vue';

describe('guide links', () => {
  afterEach(() => {
    delete (window as { workbench?: unknown }).workbench;
  });

  it('opens the screen’s guide on the documentation site, and only when one is named', async () => {
    const opened: string[] = [];
    (window as unknown as { workbench: unknown }).workbench = {
      openExternal: vi.fn(async (url: string) => void opened.push(url)),
    };
    const props = { eyebrow: 'WORKSPACE', title: 'Mock servers', description: 'Canned answers' };
    expect(mount(PageHeader, { props }).find('[data-testid="page-guide"]').exists()).toBe(false);
    const header = mount(PageHeader, { props: { ...props, guide: 'mocks' } });
    await header.get('[data-testid="page-guide"]').trigger('click');
    expect(opened).toEqual(['https://techieutils.github.io/api-workbench/docs/mock-servers.html']);

    const button = mount(GuideButton, { props: { guide: 'scripts', topic: 'scripts' } });
    expect(button.get('button').attributes('aria-label')).toBe(
      'Open the scripts guide in your browser',
    );
    await button.get('button').trigger('click');
    expect(opened.at(-1)).toBe('https://techieutils.github.io/api-workbench/docs/scripts.html');
  });
});
