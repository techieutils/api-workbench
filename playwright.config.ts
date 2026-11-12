import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the desktop app, driven by Playwright's Electron support: each test starts
 * the compiled app (npm run compile) with a fresh data folder and uses it as a person would, by
 * clicking and typing. No browser is downloaded; Playwright drives the app's own Electron.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // One app at a time: each test starts its own Electron, and the window takes focus.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
