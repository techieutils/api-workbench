// Runs before first paint so the initialization screen uses the saved theme, not always dark.
// The settings store caches the theme choice here whenever preferences are applied.
(function () {
  var theme = 'dark';
  try {
    theme = localStorage.getItem('api-workbench-theme') || 'dark';
  } catch {
    /* Storage can be unavailable; the dark default applies. */
  }
  if (theme === 'system')
    theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
})();
