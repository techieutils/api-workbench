import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';

// The Vue shell builds as a classic script, so it loads in order with the renderer's deferred scripts
// and stays within the `script-src 'self'` policy: templates compile here, never in the browser.
export default defineConfig(({ mode }) => ({
  // Images are copied beside index.html by copy-assets and referenced at runtime, not imported.
  plugins: [vue({ template: { transformAssetUrls: false } })],
  publicDir: false,
  // Bundle @techieutils/api-workbench-common from its TypeScript source, not its compiled CommonJS.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    minify: mode === 'production',
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      name: 'WorkbenchShell',
      formats: ['iife'],
      fileName: () => 'vue-shell.js',
    },
  },
}));
