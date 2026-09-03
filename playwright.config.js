import { defineConfig } from '@playwright/test';

// Extensions require a persistent context, which the tests build themselves via
// tests/helpers/extension.js — so there is no `projects` browser here.
//
// channel: 'chrome' is set at launch, not Chromium. Gemini Nano is a Chrome
// browser component; Playwright's bundled Chromium does not have it, so T3
// would be permanently untestable on the default setup.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
