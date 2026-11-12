import { StyleModule as BaseStyleModule } from 'style-mod';

/**
 * CodeMirror's style-mod, mounting its rules as a constructed stylesheet in documents too.
 *
 * For a document, style-mod writes a `<style>` element, which the page's `style-src 'self'`
 * policy blocks, leaving CodeMirror's layout unstyled. For a root without a `<head>` (a shadow
 * root) it adopts a constructed stylesheet instead, which the policy allows. The editor runtime
 * is bundled with `style-mod` resolved to this module (scripts/copy-assets.ts), and documents are
 * mounted through a stand-in without a `<head>`, so style-mod takes that path for them as well.
 */
const standIns = new WeakMap<Document, ShadowRoot>();
function standIn(document: Document): ShadowRoot {
  let root = standIns.get(document);
  if (!root) {
    // Only what style-mod reads: its document, and the stylesheets it adopts.
    root = {
      ownerDocument: document,
      get adoptedStyleSheets() {
        return document.adoptedStyleSheets;
      },
      set adoptedStyleSheets(sheets: CSSStyleSheet[]) {
        document.adoptedStyleSheets = sheets;
      },
    } as unknown as ShadowRoot;
    standIns.set(document, root);
  }
  return root;
}
export class StyleModule extends BaseStyleModule {
  static override mount(
    root: Document | ShadowRoot | DocumentOrShadowRoot,
    modules: BaseStyleModule | ReadonlyArray<BaseStyleModule>,
    options?: { nonce?: string },
  ): void {
    BaseStyleModule.mount(root instanceof Document ? standIn(root) : root, modules, options);
  }
}
