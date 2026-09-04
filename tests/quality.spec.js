import { test, expect } from '@playwright/test';
import {
  launchWithExtension, launchWithModelProfile, fixtureUrl, readExpectations,
  namesById, namesByIndex, settle, settleFor, settleForCount, HONEST_FALLBACK,
} from './helpers/extension.js';
import { qualityIssues, similarity, looksLikeLanguage, SIMILARITY_THRESHOLD } from './helpers/quality.js';

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
      const n = Object.keys(spec.candidates).length;
      if (spec.byIndex) await settleForCount(page, n, 8000);
      else await settleFor(page, Object.keys(spec.candidates), spec.settleMs ? spec.settleMs + 6000 : 6000);
      const got = spec.byIndex ? await namesByIndex(page) : await namesById(page);

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
          kind: want.kind,
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
      const n = Object.keys(spec.candidates).length;
      if (spec.byIndex) await settleForCount(page, n, 8000);
      else await settleFor(page, Object.keys(spec.candidates), spec.settleMs ? spec.settleMs + 6000 : 6000);
      const got = spec.byIndex ? await namesByIndex(page) : await namesById(page);

      for (const [id, want] of Object.entries(spec.candidates)) {
        if (want.silent || !want.reference) continue;
        const actual = got[id];
        const tier = actual?.tier;
        if (want.noTextSignal && (!tier || tier === 'none')) continue;

        if (!tier || tier === 'none') {
          // The honest floor is a floor for IMAGES ONLY, and only because a
          // clean profile has no on-device model. A control is different: no
          // vision tier applies to a link, a button or an input, so their names
          // must come from context alone — free, no model, no network. Falling
          // to the generic there is a routing or heuristic failure, not an
          // honest limit, and accepting it is how this harness certified the
          // `context.name` collision as a pass (docs/FINDINGS.md finding 2).
          // ...unless the control genuinely carries no text signal at all. A bare
          // icon — no <title>, no class token, no href, no adjacent text — has
          // only its path geometry, and guessing "Guardar" from a floppy-disk
          // outline is the confident-wrong answer §2.2 bans. There the honest
          // generic is the correct output, not a routing failure. Those
          // candidates are flagged `noTextSignal` in expectations.json, and
          // giving them a real name needs the deferred icon-rasterisation
          // decision (docs/FINDINGS.md).
          if (!want.noTextSignal) {
            expect(want.kind,
              `#${id} produced no tier and fell to "${actual?.name}". A ${want.kind} `
              + `carries a text signal, so it must be named from context by T1.`)
              .toBe('img');
          }

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
      await settleFor(page, Object.keys(spec.candidates), 12000);
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

// Text burned into an image is only recoverable by a tier that can see it. T2
// (OCR) was dropped after measurement showed T3 already returns the words —
// see SPEC §7.1 — so the assertion is now about the OUTCOME rather than which
// rung produced it: the description must contain what the banner says, not
// merely describe that a banner exists.
test.describe('text in images is transcribed, not just described @needs-model', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithModelProfile(); });
  test.afterAll(async () => { await ctx?.close(); });

  test('09-text-heavy.html — the banner\'s words survive into the alt', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('09-text-heavy.html'));
    await settleFor(page, ['horario'], 12000);
    const got = await namesById(page);
    const alt = (got.horario?.name || '').toLowerCase();

    // The facts a reader needs off that banner. Not the exact phrasing — a
    // model rewords, and demanding the wording would test the model rather
    // than whether the information arrived.
    for (const fact of ['16', 'ventanilla', 'mesa de partes']) {
      expect(alt, `#horario (tier ${got.horario?.tier}) lost "${fact}": "${got.horario?.name}"`)
        .toContain(fact);
    }
    await page.close();
  });
});

// SPEC §6 criterion 3 — the autonomous loop, provoked by a real condition.
//
// A Spanish page carrying an image whose text is English. A vision tier that
// transcribes what it sees answers in English; the page declares lang="es", so
// the language rule rejects it and the reason returns as feedback for the
// retry. Nothing here stubs a tier or forces a failure — the loop either
// happens for a genuine reason or it does not, and either is a result.
test.describe('the honest provocation @needs-model', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithModelProfile(); });
  test.afterAll(async () => { await ctx?.close(); });

  test('12-language-provocation.html — English image, Spanish answer', async () => {
    const page = await ctx.newPage();
    await page.goto(fixtureUrl('12-language-provocation.html'));
    await settleFor(page, ['aviso-en'], 15000);
    const got = await namesById(page);
    const alt = got['aviso-en']?.name || '';

    // Whether it took one attempt or two is the loop's business and is recorded
    // in the service worker log. What this asserts is the outcome the rule
    // exists for: the page's language wins, because a screen reader takes its
    // voice from the DOM and Spanish prose read by an English voice is worse
    // than no label at all.
    expect(alt, 'no description was produced at all').not.toBe('');
    expect(looksLikeLanguage(alt, 'es'),
      `answered in the image's language rather than the page's: "${alt}"`).toBe(true);
    await page.close();
  });
});
