import { test, expect } from '@playwright/test';
import { launchWithExtension, fixtureUrl, settle } from './helpers/extension.js';

// Definition of done, criterion 4 (the other half).
//
// The budget is time-to-first-VISIBLE-description, not time-to-page-complete.
// The hour-zero probe measured Gemini Nano at 1968ms for a single image, so a
// page drained in DOM order would take roughly forty seconds for twenty images
// and the wrong quantity would still look "fast" on a three-image fixture.
// Asserting the page total here would have quietly permitted the wrong design.
const FIRST_VISIBLE_BUDGET_MS = 3000;

test.describe('latency', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithExtension(); });
  test.afterAll(async () => { await ctx?.close(); });

  // The observer must exist before the document does. An earlier version of
  // this test awaited page.evaluate() and only then called page.goto(), so the
  // observer was installed on about:blank, the evaluate blocked for its own
  // timeout, and the navigation happened afterwards. It reported Infinity on
  // every run no matter how fast the extension was — a test that cannot pass
  // measures nothing, and this one was reading as a latency failure.
  test('first visible description lands inside the budget', async () => {
    const page = await ctx.newPage();

    await page.addInitScript(() => {
      const t0 = performance.now();
      window.__ariaweaveFirstDescription = new Promise((resolve) => {
        const named = () => document.querySelector('img[alt]:not([alt=""])');
        const obs = new MutationObserver(() => {
          if (named()) { obs.disconnect(); resolve(performance.now() - t0); }
        });
        obs.observe(document, { subtree: true, attributes: true, attributeFilter: ['alt'] });
      });
    });

    await page.goto(fixtureUrl('01-missing-alt.html'));
    const elapsed = await page.evaluate((budget) => Promise.race([
      window.__ariaweaveFirstDescription,
      new Promise((r) => setTimeout(() => r(Infinity), budget * 3)),
    ]), FIRST_VISIBLE_BUDGET_MS);

    expect(elapsed, 'no description ever appeared').toBeLessThan(Infinity);
    expect(elapsed).toBeLessThan(FIRST_VISIBLE_BUDGET_MS);
    await page.close();
  });

  test('a cached second visit is near-instant', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('01-missing-alt.html'));
    await settle(page);

    const t0 = Date.now();
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('img[alt]:not([alt=""])').length >= 3,
      null, { timeout: 5000 },
    );
    const warm = Date.now() - t0;

    expect(warm, `cache hit took ${warm}ms — repeat visits should not re-infer`)
      .toBeLessThan(1200);
    await page.close();
  });
});
