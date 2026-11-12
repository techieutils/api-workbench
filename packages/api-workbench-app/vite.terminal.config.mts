import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';

// The terminal window's script (public/terminal.html), built as the app's Vue shell is (vite.config.mts).
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
      entry: 'src/terminal/main.ts',
      name: 'WorkbenchTerminal',
      formats: ['iife'],
      fileName: () => 'terminal-shell.js',
    },
  },
}));
