import { test, expect } from '@playwright/test';
import {
  launchWithExtension, launchWithModelProfile, fixtureUrl, readExpectations,
  namesById, settle, HONEST_FALLBACK,
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

    // Runs everywhere, including a clean profile with no on-device model.
    //
    // A free tier that ran must resemble the reference. Where NO tier could run,
    // the spec's floor is mandatory and exact: the honest string, never a
    // confident guess. That second branch was untested until now, and it is the
    // one that catches a modelless machine inventing prose — arguably more
    // load-bearing than similarity, since it guards SPEC 2.2 directly.
    test(`${name} — free tiers resemble the references, and the honest floor holds`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 2500);
      const got = await namesById(page);

      for (const [id, want] of Object.entries(spec.candidates)) {
        if (want.silent || !want.reference) continue;
        const actual = got[id];
        const tier = actual?.tier;

        if (!tier || tier === 'none') {
          // Language is deliberately not asserted here: fixture 08 declares a
          // lang that contradicts its content and SPEC 5 defers that rule.
          expect(HONEST_FALLBACK,
            `#${id} had no tier, so it must emit the honest fallback verbatim, got "${actual?.name}"`)
            .toContain(actual?.name);
          continue;
        }

        const score = similarity(actual.name ?? '', want.reference);
        expect(score, `#${id} (tier ${tier})\n  got:  "${actual.name}"\n  want: "${want.reference}"`)
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

// ---------------------------------------------------------------------------
// Criterion 2's vision slice. Opt-in, because a throwaway profile has no
// on-device model at all (verifier/FINDINGS.md finding 3) — availability()
// returns 'unavailable', not 'downloadable', so no gesture fixes it.
//
//   ARIAWEAVE_MODEL_PROFILE=~/.ariaweave-harness-profile npx playwright test \
//     --project=needs-model
//
// Verified by hand on 2026-09-02 in a real profile: T3 produced
// "Un terreno plano con dos edificios de color arena y un árbol en medio,
// rodeado de pequeños círculos oscuros." — so this is a reproducibility gap,
// not an unimplemented feature.
test.describe('descriptions resemble the human references @needs-model', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithModelProfile(); });
  test.afterAll(async () => { await ctx?.close(); });

  for (const name of FIXTURES) {
    const spec = EXPECT[name];
    test(`${name} — vision descriptions match the references`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 4000);
      const got = await namesById(page);

      for (const [id, want] of Object.entries(spec.candidates)) {
        if (want.silent || !want.reference) continue;
        const score = similarity(got[id]?.name ?? '', want.reference);
        expect(score, `#${id} (tier ${got[id]?.tier})\n  got:  "${got[id]?.name}"\n  want: "${want.reference}"`)
          .toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
      }
      await page.close();
    });
  }
});
