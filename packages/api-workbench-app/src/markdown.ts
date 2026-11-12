import { Marked } from 'marked';
import { isExternalLink } from '@techieutils/api-workbench-common/external-links';

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escape = (text: string) => text.replace(/[&<>"']/g, (character) => entities[character]);

// A response body is untrusted, and the rendered Markdown goes into the app's own page (an iframe
// would inherit the `style-src 'self'` policy and render unstyled). So embedded HTML shows as text,
// links keep only the web and mail targets the app opens (after asking), and images, which the
// policy would block, show their text.
const markdown = new Marked({ gfm: true });
markdown.use({
  renderer: {
    html({ text, block }) {
      return block ? `<p>${escape(text.trim())}</p>\n` : escape(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!isExternalLink(href)) return label;
      return `<a href="${escape(href)}" title="${escape(title || href)}">${label}</a>`;
    },
    image({ text }) {
      return `<span class="markdown-image">${escape(text || 'Image')}</span>`;
    },
  },
});

/** Markdown as HTML that is safe to place in the app's page. */
export function renderMarkdown(source: string): string {
  return markdown.parse(source, { async: false });
}
