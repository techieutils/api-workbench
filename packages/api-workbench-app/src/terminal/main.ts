import { createApp } from 'vue';
import TerminalApp from './TerminalApp.vue';

// The theme comes from the main process, which knows the app's; this window keeps no settings.
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
createApp(TerminalApp).mount('#terminal');
