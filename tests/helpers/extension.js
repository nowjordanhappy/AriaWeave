import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../..');
export const FIXTURES = path.join(REPO, 'tests/fixtures');

// The extension is expected at the repo root (manifest.json + content/ +
// background/). It does not exist yet — that is why this harness is red.
export const EXTENSION_PATH = process.env.ARIAWEAVE_EXT || REPO;

// Headed only when you want to watch. Chrome needed a window while the harness
// used --load-extension; the CDP Extensions.loadUnpacked path does not, so the
// default is headless and the suite stops stealing focus mid-run.
export const HEADLESS = process.env.ARIAWEAVE_HEADED !== '1';

export function extensionExists() {
  return fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'));
}

export function requireExtension() {
  if (!extensionExists()) {
    throw new Error(
      `No manifest.json at ${EXTENSION_PATH}.\n` +
      `The harness is red because the extension does not exist yet. That is the ` +
      `expected state until lanes A and B land. Set ARIAWEAVE_EXT to point elsewhere.`
    );
  }
}

// Real Chrome, headed. Chrome only loads unpacked extensions reliably in a
// persistent context, and Nano lives in Chrome rather than Chromium.
//
// `--load-extension` is NOT used, because Chrome ignores it. The flag was
// removed from official Chrome-branded builds in Chrome 137 — it was the usual
// silent-sideload vector for malware — and Chrome accepts it on the command
// line and does nothing, with no error and no warning. Measured on Chrome 152:
// the flag appears in chrome://version, and chrome://extensions-internals lists
// only the component PDF viewer. Every extension-dependent test in this harness
// was therefore failing because no extension was ever installed.
//
// The supported replacement is the CDP method, which writes to Secure
// Preferences exactly as "Load unpacked" in chrome://extensions does. Two
// things it needs that are easy to miss:
//
//   - `ignoreDefaultArgs: ['--disable-extensions']`. Playwright passes
//     `--disable-extensions` by default; leave it in and loadUnpacked still
//     returns an extension id while the extension stays inert. That silence is
//     the whole reason this took a bisect to find.
//   - A *browser*-scoped CDP session. The Extensions domain is not on a page
//     session (`Method not available`), and it is pipe-only — Playwright
//     launches over a pipe already, so this works without extra flags.
//
// `--enable-unsafe-extension-debugging` is documented as gating the method but
// was not required on Chrome 152. Passed anyway: cheap, and a version that does
// enforce the gate would otherwise fail exactly as silently as the flag did.
export async function launchWithExtension() {
  requireExtension();
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: HEADLESS,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
  return ctx;
}

// The opt-in launcher for the model project.
//
// A throwaway profile has no on-device model components at all —
// LanguageModel.availability() returns 'unavailable', not 'downloadable', so no
// user gesture fixes it (verifier/FINDINGS.md finding 3). T3 therefore cannot
// run in the default suite, by construction and not by accident.
//
// Point ARIAWEAVE_MODEL_PROFILE at a DEDICATED Chrome User Data directory that
// has the model. Never the daily profile: Chrome holds a SingletonLock while it
// runs, and Secure Preferences MACs are path-sensitive.
export const MODEL_PROFILE = process.env.ARIAWEAVE_MODEL_PROFILE || null;

export async function launchWithModelProfile() {
  requireExtension();
  if (!MODEL_PROFILE) {
    throw new Error('ARIAWEAVE_MODEL_PROFILE is not set — this project needs a profile with the on-device model.');
  }
  const ctx = await chromium.launchPersistentContext(MODEL_PROFILE, {
    channel: 'chrome',
    headless: HEADLESS,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'],
  });
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
  return ctx;
}

// The exact string the pipeline emits when nothing cleared the bar. Duplicated
// from background/pipeline.js on purpose — the harness must not import what it
// judges, and if the product changes this text the harness should fail loudly
// rather than silently agree.
export const HONEST_FALLBACK = [
  'Imagen no descrita con confianza', 'Botón sin nombre accesible',
  'Enlace sin nombre accesible', 'Campo sin etiqueta',
  'Image not described with confidence', 'Button without accessible name',
  'Link without accessible name', 'Field without label',
];

// The "before" measurement: the same page with nothing installed.
export async function launchClean() {
  return chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: HEADLESS,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

// http, never file://. Under file:// each file is a unique opaque origin and
// the worker's fetch() of an image src is blocked, so no image reaches any
// tier and every element falls to the honest fallback with tier "none".
export const PORT = Number(process.env.ARIAWEAVE_PORT || 5187);
export const fixtureUrl = (name) => `http://localhost:${PORT}/${name}`;

export function readExpectations() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
}

// What the page ended up exposing, keyed by the ids the fixtures plant.
export async function namesById(page) {
  return page.evaluate(() => {
    const acc = {};
    for (const el of document.querySelectorAll('[id]')) {
      const tag = el.tagName.toLowerCase();
      let name = null;
      if (tag === 'img') {
        name = el.getAttribute('alt');
      } else {
        // Text inside an aria-hidden subtree is NOT an accessible name. An
        // icon-only button whose <svg aria-hidden="true"> contains a <title>
        // reads as named here while assistive tech sees nothing — the harness
        // reported "Buscar" for a button carrying no aria-label at all.
        const visible = el.cloneNode(true);
        for (const h of visible.querySelectorAll('[aria-hidden="true"]')) h.remove();
        name = el.getAttribute('aria-label')
            ?? el.getAttribute('title')
            ?? ((visible.textContent || '').trim() || null);
      }
      acc[el.id] = {
        tag,
        name,
        hasAltAttr: tag === 'img' ? el.hasAttribute('alt') : null,
        tier: el.getAttribute('data-ariaweave-tier'),
        lang: el.getAttribute('lang'),
      };
    }
    return acc;
  });
}

// Settle time for the extension to finish a page. Fixtures that inject content
// late declare their own settleMs.
export async function settle(page, ms = 2500) {
  await page.waitForTimeout(ms);
}

// Wait for the WORK, not for the clock.
//
// A fixed sleep lies in both directions: too short and a correct run reports
// null, too long and every test pays for the slowest page. 07-lang-missing
// failed and passed on consecutive runs with no code change between them, which
// is the worst kind of red — it teaches people to re-run instead of read.
//
// Returns either way after the deadline, so a genuine failure still reports the
// real state of the page rather than a timeout.
export async function settleFor(page, ids, ms = 6000) {
  await page
    .waitForFunction(
      // Wait for OUR mark, not for a name. An earlier version waited for an alt
      // attribute, which fixture 02's images already carry — with junk in them.
      // The condition was true before the extension had done anything, so the
      // test read the junk alt and reported a regression in 136ms. The tier
      // attribute is written only by us, so its presence is unambiguous
      // evidence that this element was processed.
      (list) => list.every((id) => document
        .getElementById(id)?.hasAttribute('data-ariaweave-tier')),
      ids, { timeout: ms },
    )
    .catch(() => {});
}
