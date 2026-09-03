import { defineConfig } from '@playwright/test';

// Extensions require a persistent context, which the tests build themselves via
// tests/helpers/extension.js — so there is no `projects` browser here.
//
// channel: 'chrome' is set at launch, not Chromium. Gemini Nano is a Chrome
// browser component; Playwright's bundled Chromium does not have it, so T3
// would be permanently untestable on the default setup.
// Two projects, because a clean profile cannot run the on-device model.
//
// 'reproducible' is the default and runs anywhere: npm i, npm test, no key, no
// profile, no network. 'needs-model' carries the assertions that require T3 and
// only appears when ARIAWEAVE_MODEL_PROFILE points at a profile that has it.
//
// This is not a workaround. SPEC 3.3.1 already says T3 is opportunistic and the
// zero-config promise rests on T1 + T2, so a clean profile is the machine the
// spec describes — the harness was asserting a floor its own spec excludes.
const MODEL_PROFILE = process.env.ARIAWEAVE_MODEL_PROFILE;

export default defineConfig({
  testDir: './tests',
  projects: [
    { name: 'reproducible', grepInvert: /@needs-model/ },
    ...(MODEL_PROFILE ? [{ name: 'needs-model', grep: /@needs-model/ }] : []),
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node tests/helpers/serve.js',
    url: 'http://localhost:5187/01-missing-alt.html',
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
