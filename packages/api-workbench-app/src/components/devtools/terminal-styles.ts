/**
 * xterm.js writes its layout and theme CSS into <style> elements, which the app's
 * `style-src 'self'` policy blocks. While a terminal opens, those elements are kept out of the
 * document and their CSS applies as constructed stylesheets instead, following later updates.
 * Returns a function that removes the stylesheets again.
 */
export function openWithAdoptedStyles(open: () => void): () => void {
  const sheets: CSSStyleSheet[] = [];
  const observers: MutationObserver[] = [];
  const adopt = (style: HTMLStyleElement) => {
    const sheet = new CSSStyleSheet();
    const sync = () => sheet.replaceSync(style.textContent ?? '');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(style, { childList: true, characterData: true, subtree: true });
    sheets.push(sheet);
    observers.push(observer);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  };
  const append = Node.prototype.appendChild;
  const insert = Node.prototype.insertBefore;
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    if (node instanceof HTMLStyleElement) {
      adopt(node);
      return node;
    }
    return append.call(this, node) as T;
  };
  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (node instanceof HTMLStyleElement) {
      adopt(node);
      return node;
    }
    return insert.call(this, node, child) as T;
  };
  try {
    open();
  } finally {
    Node.prototype.appendChild = append;
    Node.prototype.insertBefore = insert;
  }
  return () => {
    observers.forEach((observer) => observer.disconnect());
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => !sheets.includes(sheet),
    );
  };
}
