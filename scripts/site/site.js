// The documentation site's behaviour: search (⌘K), theme switching, copy buttons, code tabs, image
// zoom, "Copy page", page feedback, the announcement bar, the mobile navigation drawer,
// highlighting the current section in "On this page", copying section links, and reading progress.
(function () {
  'use strict';
  const script = document.currentScript;
  const root = (script && script.dataset.root) || '';

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        /* Remembered for this page only. */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (error) {
        /* Nothing was stored. */
      }
    },
  };

  // Theme: light or dark, starting from the system choice; the choice is remembered. The header
  // toggle flips between light and dark; the footer switch can also go back to the system choice.
  const toggle = document.querySelector('.theme-toggle');
  const choices = document.querySelectorAll('[data-theme-choice]');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const currentTheme = () =>
    document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
  function labelToggle() {
    if (toggle)
      toggle.setAttribute(
        'aria-label',
        `Switch to the ${currentTheme() === 'dark' ? 'light' : 'dark'} theme`,
      );
  }
  function syncTheme() {
    labelToggle();
    const chosen = document.documentElement.dataset.theme || 'system';
    choices.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen)),
    );
  }
  function setTheme(choice) {
    if (choice === 'system') {
      delete document.documentElement.dataset.theme;
      store.remove('aw-docs-theme');
    } else {
      document.documentElement.dataset.theme = choice;
      store.set('aw-docs-theme', choice);
    }
    syncTheme();
  }
  toggle?.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  choices.forEach((button) =>
    button.addEventListener('click', () => setTheme(button.dataset.themeChoice)),
  );
  systemDark.addEventListener?.('change', labelToggle);
  syncTheme();

  /** Copies text and shows the outcome on the button's label for a moment. */
  async function copyWithLabel(button, text, idle) {
    const label = button.querySelector('span');
    try {
      await navigator.clipboard.writeText(await text);
      if (label) label.textContent = 'Copied';
    } catch (error) {
      if (label) label.textContent = 'Copy failed';
    }
    setTimeout(() => label && (label.textContent = idle), 1600);
  }

  // Copy buttons on code blocks; in a tabbed block, the visible tab is copied.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.copy');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('pre:not([hidden]) code');
    if (code) copyWithLabel(button, code.textContent, 'Copy');
  });

  // "Copy page" copies the page's Markdown, for pasting into an issue or an AI assistant.
  document.querySelector('.copy-page')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    copyWithLabel(
      button,
      fetch(button.dataset.markdown).then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        return response.text();
      }),
      'Copy page',
    );
  });

  // Tabbed code blocks (macOS / Windows / Linux, and so on). The chosen tab is remembered and
  // applied to every block that has a tab with the same name.
  function selectCodeTab(tab, focus) {
    const list = tab.closest('[role=tablist]');
    for (const other of list.querySelectorAll('[role=tab]')) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
  }
  const codeTabs = [...document.querySelectorAll('.code-group [role=tab]')];
  const savedTab = store.get('aw-docs-code-tab');
  if (savedTab)
    for (const tab of codeTabs) if (tab.textContent === savedTab) selectCodeTab(tab, false);
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('.code-group [role=tab]');
    if (!tab) return;
    store.set('aw-docs-code-tab', tab.textContent);
    for (const other of codeTabs)
      if (other.textContent === tab.textContent) selectCodeTab(other, other === tab);
  });
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('.code-group [role=tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...tab.parentElement.children];
    const at = tabs.indexOf(tab);
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: tabs.length - 1 }[
      event.key
    ];
    selectCodeTab(tabs[(next + tabs.length) % tabs.length], true);
  });

  // A short confirmation at the bottom of the page, read out by screen readers.
  const toastBox = document.querySelector('.site-toast');
  let toastTimer;
  function toast(message) {
    if (!toastBox) return;
    toastBox.textContent = message;
    toastBox.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastBox.hidden = true), 1800);
  }

  // A heading's link copies the address of its section, and goes there.
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('.prose .anchor');
    if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    const hash = anchor.getAttribute('href');
    history.replaceState(null, '', hash);
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
    navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => toast('Link to this section copied'))
      .catch(() => toast('Link updated in the address bar'));
  });

  // Reading progress: how far down the page the reader is, as a line under the header.
  const progress = document.querySelector('.reading-progress span');
  if (progress) {
    let pending = false;
    const update = () => {
      pending = false;
      const range = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = `scaleX(${range > 0 ? Math.min(1, window.scrollY / range) : 0})`;
    };
    window.addEventListener(
      'scroll',
      () => {
        if (!pending) {
          pending = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }

  // Screenshots open full size in a lightbox.
  const lightbox = document.createElement('dialog');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('aria-label', 'Image');
  lightbox.innerHTML = '<img alt=""><p></p>';
  document.body.append(lightbox);
  lightbox.addEventListener('click', () => lightbox.close());
  for (const image of document.querySelectorAll('.prose figure img, .shots img')) {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', `Enlarge: ${image.alt}`);
    const open = () => {
      lightbox.querySelector('img').src = image.currentSrc || image.src;
      lightbox.querySelector('img').alt = image.alt;
      lightbox.querySelector('p').textContent = image.alt;
      lightbox.showModal();
    };
    image.addEventListener('click', open);
    image.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }

  // "Was this page helpful?" Answers stay in this browser; "No" points to an issue form.
  const feedback = document.querySelector('.feedback');
  if (feedback) {
    const key = `aw-docs-helpful:${location.pathname}`;
    const thanks = feedback.querySelector('.feedback-thanks');
    const show = (answer) => {
      for (const button of feedback.querySelectorAll('[data-helpful]'))
        button.setAttribute('aria-pressed', String(button.dataset.helpful === answer));
      thanks.hidden = false;
      thanks.querySelector('a').hidden = answer !== 'no';
    };
    if (store.get(key)) show(store.get(key));
    feedback.addEventListener('click', (event) => {
      const button = event.target.closest('[data-helpful]');
      if (!button) return;
      store.set(key, button.dataset.helpful);
      show(button.dataset.helpful);
    });
  }

  // The announcement bar, until it is dismissed.
  document.querySelector('.announcement button')?.addEventListener('click', () => {
    document.documentElement.classList.add('announcement-dismissed');
    store.set('aw-docs-announcement', document.documentElement.dataset.announcement);
  });

  // Mobile navigation drawer.
  const menu = document.querySelector('.menu-button');
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.querySelector('.sidebar-backdrop');
  function setDrawer(open) {
    if (!menu || !sidebar) return;
    sidebar.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    if (backdrop) backdrop.hidden = !open;
    if (open) sidebar.querySelector('[aria-current]')?.focus();
  }
  menu?.addEventListener('click', () => setDrawer(!sidebar.classList.contains('open')));
  backdrop?.addEventListener('click', () => setDrawer(false));
  // Bring the current page into view in the sidebar only; scrollIntoView would scroll the window too.
  const currentLink = sidebar?.querySelector('[aria-current]');
  if (currentLink && sidebar.scrollHeight > sidebar.clientHeight)
    sidebar.scrollTop = currentLink.offsetTop - sidebar.offsetTop - sidebar.clientHeight / 2;

  // "On this page": highlight the section being read.
  const tocLinks = [...document.querySelectorAll('.toc a')];
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const targets = tocLinks
      .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
      .filter(Boolean);
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id);
        const first = targets.find((target) => visible.has(target.id));
        if (!first) return;
        for (const link of tocLinks) link.classList.toggle('active', link.hash === `#${first.id}`);
      },
      { rootMargin: '-80px 0px -60% 0px' },
    );
    targets.forEach((target) => observer.observe(target));
  }

  // Search.
  const dialog = document.querySelector('.search-dialog');
  const input = dialog?.querySelector('input');
  const results = dialog?.querySelector('.search-results');
  let index;
  let active = 0;
  let returnFocus = null;
  async function loadIndex() {
    if (index) return index;
    const response = await fetch(`${root}assets/search.json`);
    index = await response.json();
    return index;
  }
  const escapeHtml = (text) =>
    text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /**
   * Marks every word in one pass over the plain text, escaping each piece: marking the words one
   * after another in HTML would find them inside earlier <mark> tags and in entities like &amp;.
   */
  function highlight(text, words) {
    const pattern = new RegExp(
      words
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'gi',
    );
    let html = '';
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      html += `${escapeHtml(text.slice(last, match.index))}<mark>${escapeHtml(match[0])}</mark>`;
      last = match.index + match[0].length;
    }
    return html + escapeHtml(text.slice(last));
  }
  /** Scores an entry: titles and headings outrank body text; every word must appear somewhere. */
  function score(entry, words) {
    const title = entry.title.toLowerCase();
    const heading = entry.heading.toLowerCase();
    const text = entry.text.toLowerCase();
    let total = 0;
    for (const word of words) {
      if (title.includes(word)) total += title.startsWith(word) ? 12 : 8;
      else if (heading.includes(word)) total += heading.startsWith(word) ? 7 : 5;
      else if (text.includes(word)) total += 1;
      else return 0;
    }
    return total + (entry.heading ? 0 : 2);
  }
  function snippet(text, words) {
    const lower = text.toLowerCase();
    const positions = words.map((word) => lower.indexOf(word)).filter((position) => position >= 0);
    const at = positions.length ? Math.max(0, Math.min(...positions) - 40) : 0;
    return (at > 0 ? '…' : '') + text.slice(at, at + 160) + (text.length > at + 160 ? '…' : '');
  }
  async function search() {
    const query = input.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    if (!words.length) {
      results.innerHTML = '<li class="search-empty">Type to search every page.</li>';
      return;
    }
    const entries = await loadIndex();
    const found = entries
      .map((entry) => ({ entry, score: score(entry, words) }))
      .filter((item) => item.score)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    active = 0;
    results.innerHTML = found.length
      ? found
          .map(
            ({ entry }, position) =>
              `<li role="option" id="search-result-${position}" aria-selected="${position === 0}"><a href="${root}${entry.url}"><small>${escapeHtml(entry.group)}</small><strong>${highlight(entry.heading ? `${entry.title} › ${entry.heading}` : entry.title, words)}</strong><span>${highlight(snippet(entry.text, words), words)}</span></a></li>`,
          )
          .join('')
      : `<li class="search-empty">No results for “${escapeHtml(input.value.trim())}”.</li>`;
    input.setAttribute('aria-activedescendant', found.length ? 'search-result-0' : '');
  }
  function move(step) {
    const items = [...results.querySelectorAll('[role=option]')];
    if (!items.length) return;
    active = (active + step + items.length) % items.length;
    items.forEach((item, position) =>
      item.setAttribute('aria-selected', String(position === active)),
    );
    items[active].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', items[active].id);
  }
  function openSearch() {
    if (!dialog) return;
    returnFocus = document.activeElement;
    dialog.hidden = false;
    document.body.classList.add('search-open');
    input.value = '';
    search();
    input.focus();
    loadIndex();
  }
  function closeSearch() {
    dialog.hidden = true;
    document.body.classList.remove('search-open');
    returnFocus?.focus?.();
  }
  document
    .querySelectorAll('.search-button, [data-open-search]')
    .forEach((button) => button.addEventListener('click', openSearch));
  input?.addEventListener('input', search);
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, textarea, [contenteditable]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dialog.hidden ? openSearch() : closeSearch();
    } else if (event.key === '/' && !typing && dialog?.hidden) {
      event.preventDefault();
      openSearch();
    } else if (dialog && !dialog.hidden) {
      if (event.key === 'Escape') closeSearch();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        const link = results.querySelector('[aria-selected=true] a');
        if (link) {
          event.preventDefault();
          window.location.href = link.href;
        }
      }
    } else if (event.key === 'Escape' && sidebar?.classList.contains('open')) setDrawer(false);
  });
})();
