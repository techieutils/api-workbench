import { betweenCaptureFor } from '@techieutils/api-workbench-common/capture-suggestions';

/** A capture offered from a response preview: what the menu shows, and what is saved. */
export interface PreviewCapture {
  label: string;
  source: string;
  /** The variable name it is saved under, before numbering. */
  name: string;
}

/** Up to `limit` characters of text, on one line, for a menu label. */
const short = (text: string, limit = 32) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};
const variableBase = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
/** An attribute value for a CSS selector, quoted. */
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Whether `selector` finds `element` and nothing else in its document. */
function uniquely(selector: string, element: Element): boolean {
  try {
    const found = element.ownerDocument.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

/**
 * A CSS selector that finds just this element: its id, its tag and name, or else the shortest
 * chain of `tag:nth-of-type(n)` steps from it up the document that is unique.
 */
export function uniqueSelector(element: Element): string {
  const tag = element.localName;
  const id = element.getAttribute('id');
  if (id && uniquely(`#${CSS.escape(id)}`, element)) return `#${CSS.escape(id)}`;
  const name = element.getAttribute('name');
  if (name && uniquely(`${tag}[name=${quoted(name)}]`, element))
    return `${tag}[name=${quoted(name)}]`;
  const steps: string[] = [];
  for (
    let node: Element | null = element;
    node && node.localName !== 'html';
    node = node.parentElement
  ) {
    const same = node.parentElement
      ? [...node.parentElement.children].filter((child) => child.localName === node!.localName)
      : [node];
    steps.unshift(
      same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName,
    );
    const selector = steps.join(' > ');
    if (uniquely(selector, element)) return selector;
  }
  return steps.join(' > ');
}

/** Attributes worth capturing: values and links, not presentation or event handlers. */
const SKIPPED_ATTRIBUTES = /^(?:class|style|on[a-z]+)$/i;

/**
 * Captures for an element in an HTML preview: its text, and its attributes (a hidden input's
 * value, a link's href), each read with `html <selector> [@attribute]`.
 */
export function elementCaptures(element: Element): PreviewCapture[] {
  const selector = uniqueSelector(element);
  const base =
    variableBase(element.getAttribute('name') || element.getAttribute('id') || '') ||
    element.localName;
  const captures: PreviewCapture[] = [];
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= 500)
    captures.push({ label: `Text · "${short(text)}"`, source: `html ${selector}`, name: base });
  for (const attribute of [...element.attributes]) {
    if (SKIPPED_ATTRIBUTES.test(attribute.name) || !attribute.value.trim()) continue;
    captures.push({
      label: `${attribute.name} · "${short(attribute.value)}"`,
      source: `html ${selector} @${attribute.name}`,
      name: attribute.name === 'value' ? base : `${base}_${variableBase(attribute.name)}`,
    });
    if (captures.length >= 7) break;
  }
  return captures;
}

/** Captures for what a page carries but does not show: its title, and named meta content. */
export function pageCaptures(document: Document): PreviewCapture[] {
  const captures: PreviewCapture[] = [];
  const title = document.querySelector('title')?.textContent?.trim();
  if (title)
    captures.push({ label: `Title · "${short(title)}"`, source: 'html title', name: 'title' });
  for (const meta of document.querySelectorAll('meta[name][content], meta[property][content]')) {
    const key = meta.getAttribute('name') ? 'name' : 'property';
    const name = meta.getAttribute(key)!;
    captures.push({
      label: `${name} · "${short(meta.getAttribute('content')!)}"`,
      source: `html meta[${key}=${quoted(name)}] @content`,
      name: variableBase(name) || 'meta',
    });
    if (captures.length >= 6) break;
  }
  return captures;
}

/**
 * A capture of selected preview text, by the markers around it in the raw body, or why it
 * cannot be made: the text must appear once in the body (rendering may have changed it).
 */
export function selectionCapture(
  selected: string,
  body: string,
): PreviewCapture | { reason: string } {
  const text = selected.trim();
  if (!text) return { reason: 'select the text to capture' };
  const start = body.indexOf(text);
  if (start < 0 || body.indexOf(text, start + 1) >= 0)
    return { reason: 'select text that appears once in the raw body' };
  const source = betweenCaptureFor(body, start, start + text.length);
  if (!source) return { reason: 'no nearby text marks this selection' };
  return { label: `Selection · "${short(text)}"`, source, name: 'value' };
}
