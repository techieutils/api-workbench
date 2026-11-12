import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'packages/*/dist/**',
      'packages/*/dist-spec/**',
      'release/**',
      'artifacts/**',
      'test-results/**',
      'playwright-report/**',
      'node_modules/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Ambient declarations for the renderer: types and the runtimes index.html loads before Vue.
  {
    files: ['packages/api-workbench-app/src/globals.d.ts'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['packages/api-workbench-app/src/**/*.vue'],
    extends: [pluginVue.configs['flat/essential']],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // vue-tsc resolves the globals declared in packages/api-workbench-app/src/globals.d.ts.
    rules: { 'no-undef': 'off' },
  },
  // The main process registers IPC through handle() in main.ts, which answers only the app window.
  {
    files: ['packages/api-workbench-electron/src/**/*.ts'],
    ignores: ['packages/api-workbench-electron/src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='ipcMain'][callee.property.name=/^(handle|handleOnce|on|once)$/]",
          message:
            'Register IPC with handle() in main.ts, which accepts calls only from the app window.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  // The documentation site's scripts run in the reader's browser.
  {
    files: ['scripts/site/**/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
);
