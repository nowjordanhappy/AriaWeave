import { test, expect } from '@playwright/test';
import {
  launchWithExtension, fixtureUrl, readExpectations, namesById, settle,
} from './helpers/extension.js';

const EXPECT = readExpectations();

// Definition of done, criterion 4. The extension watches the DOM and also
// writes to it, so the obvious implementation feeds itself: inject an alt,
// the observer fires, the candidate is rescanned, inject again. The page keeps
// working while a core is pinned and every description is paid for twice.
test.describe('the observer does not feed itself', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithExtension(); });
  test.afterAll(async () => { await ctx?.close(); });

  test('mutations stop once the page is settled', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('01-missing-alt.html'));
    await settle(page);

    // Count what the extension does AFTER it should have finished.
    const churn = await page.evaluate(async () => {
      let count = 0;
      const obs = new MutationObserver((records) => { count += records.length; });
      obs.observe(document.documentElement, {
        subtree: true, attributes: true, childList: true,
        attributeFilter: ['alt', 'aria-label', 'title', 'data-ariaweave-tier'],
      });
      await new Promise((r) => setTimeout(r, 3000));
      obs.disconnect();
      return count;
    });

    expect(churn, 'the extension is still mutating a settled page — self-trigger loop')
      .toBe(0);
    await page.close();
  });

  test('a second pass changes nothing', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('01-missing-alt.html'));
    await settle(page);
    const first = await namesById(page);

    // Poke the DOM in a way that must not cause re-description of already-named nodes.
    await page.evaluate(() => {
      document.body.appendChild(document.createElement('div'));
    });
    await settle(page, 1500);
    const second = await namesById(page);

    for (const id of Object.keys(first)) {
      expect(second[id]?.name, `#${id} was re-described on a second pass`)
        .toBe(first[id].name);
    }
    await page.close();
  });

  test('dynamic content is caught without re-processing static content', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('06-dynamic.html'));
    await settle(page, EXPECT['06-dynamic.html'].settleMs);
    const got = await namesById(page);

    for (const id of Object.keys(EXPECT['06-dynamic.html'].candidates)) {
      expect(got[id]?.name, `#${id} arrived late and was never named`).toBeTruthy();
    }
    await page.close();
  });
});
