import vue from '@vitejs/plugin-vue';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Vue component and store tests: single-file components compile as in the app build, and
// @techieutils/api-workbench-common resolves to its TypeScript source. They run in happy-dom, a
// browser-like document, and live beside what they test as *.test.ts (the *.spec.ts files are the
// Node test runner's).
export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls: false } })],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
