import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ResponsePreview from './ResponsePreview.vue';
import { workspaceWith } from '../../test/workspace';

describe('HTML preview', () => {
  it('leaves out scripts, whatever their end tag looks like, and never lets the page run code', () => {
    workspaceWith([]);
    const body = [
      '<p>kept</p>',
      '<script>one()</script>',
      '<script>two()</script\t\n foo>',
      '<SCRIPT src="x.js"/>',
    ].join('');
    const wrapper = mount(ResponsePreview, {
      props: {
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
          body,
          time: 1,
          size: body.length,
        } as never,
      },
    });
    const frame = wrapper.get('iframe');
    const html = frame.attributes('srcdoc') ?? '';
    expect(html).toContain('<p>kept</p>');
    expect(html).not.toMatch(/one\(\)|two\(\)|<script/i);
    expect(frame.attributes('sandbox') ?? '').not.toContain('allow-scripts');
    wrapper.unmount();
  });
});
