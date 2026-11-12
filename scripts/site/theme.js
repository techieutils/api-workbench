// Applies the saved theme before the page paints, so it never flashes the other one, and hides an
// announcement that was already dismissed, so the page doesn't jump.
(function () {
  try {
    var saved = localStorage.getItem('aw-docs-theme');
    var root = document.documentElement;
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
    if (localStorage.getItem('aw-docs-announcement') === root.dataset.announcement)
      root.classList.add('announcement-dismissed');
  } catch (error) {
    /* Storage unavailable: follow the system theme. */
  }
})();
