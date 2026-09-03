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

  test('first visible description lands inside the budget', async () => {
    const page = await ctx.newPage();

    const elapsed = await page.evaluate(async (budget) => {
      const t0 = performance.now();
      return new Promise((resolve) => {
        const done = (v) => { obs.disconnect(); clearTimeout(timer); resolve(v); };
        const obs = new MutationObserver(() => {
          const named = document.querySelector('img[alt]:not([alt=""])');
          if (named) done(performance.now() - t0);
        });
        obs.observe(document.documentElement, {
          subtree: true, attributes: true, attributeFilter: ['alt'],
        });
        const timer = setTimeout(() => done(Infinity), budget * 3);
      });
    }, FIRST_VISIBLE_BUDGET_MS);

    await page.goto(fixtureUrl('01-missing-alt.html'));
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
