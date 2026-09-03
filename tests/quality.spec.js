import { test, expect } from '@playwright/test';
import {
  launchWithExtension, fixtureUrl, readExpectations, namesById, settle,
} from './helpers/extension.js';
import { qualityIssues, similarity, SIMILARITY_THRESHOLD } from './helpers/quality.js';

const EXPECT = readExpectations();
const FIXTURES = Object.keys(EXPECT).filter((k) => !k.startsWith('_'));

// Definition of done, criterion 2 — the half that criterion 1 cannot see.
// alt="image" drives axe to zero while telling a screen reader user nothing.
test.describe('descriptions are worth having', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithExtension(); });
  test.afterAll(async () => { await ctx?.close(); });

  for (const name of FIXTURES) {
    const spec = EXPECT[name];

    test(`${name} — every planted candidate is named usefully`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 2500);
      const got = await namesById(page);

      for (const [id, want] of Object.entries(spec.candidates)) {
        const actual = got[id];
        expect(actual, `#${id} vanished from the page`).toBeTruthy();

        if (want.silent) {
          // Decorative: silenced, not described. Inventing prose for a tracking
          // pixel is worse than skipping it.
          expect(actual.hasAltAttr, `#${id} decorative but has no alt attribute`).toBe(true);
          expect(actual.name, `#${id} decorative but was described: "${actual.name}"`).toBe('');
          continue;
        }

        const issues = qualityIssues(actual.name, {
          lang: spec.langUndecided ? null : spec.lang,
        });
        expect(issues, `#${id} → "${actual.name}"`).toEqual([]);
      }
      await page.close();
    });

    test(`${name} — descriptions resemble the human references`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 2500);
      const got = await namesById(page);

      for (const [id, want] of Object.entries(spec.candidates)) {
        if (want.silent || !want.reference) continue;
        const score = similarity(got[id]?.name ?? '', want.reference);
        expect(score, `#${id}\n  got:  "${got[id]?.name}"\n  want: "${want.reference}"`)
          .toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
      }
      await page.close();
    });
  }

  test('09-text-heavy.html — the OCR tier handles it, not the paid one', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('09-text-heavy.html'));
    await settle(page);
    const got = await namesById(page);
    expect(got.horario?.tier, 'text-heavy image should route to T2, not escalate')
      .toBe('T2');
    await page.close();
  });
});
