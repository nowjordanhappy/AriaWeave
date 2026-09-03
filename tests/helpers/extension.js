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
    headless: false,
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

// The "before" measurement: the same page with nothing installed.
export async function launchClean() {
  return chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
}

export const fixtureUrl = (name) => 'file://' + path.join(FIXTURES, name);

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
      if (tag === 'img') name = el.getAttribute('alt');
      else name = el.getAttribute('aria-label')
               ?? el.getAttribute('title')
               ?? ((el.textContent || '').trim() || null);
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
