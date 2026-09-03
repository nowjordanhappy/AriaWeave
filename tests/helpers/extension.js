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
export async function launchWithExtension() {
  requireExtension();
  return chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
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
