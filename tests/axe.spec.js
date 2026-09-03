import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  launchWithExtension, launchClean, fixtureUrl, readExpectations, settle,
} from './helpers/extension.js';

const EXPECT = readExpectations();
const FIXTURES = Object.keys(EXPECT).filter((k) => !k.startsWith('_'));

async function violationsOn(page, rules) {
  const res = await new AxeBuilder({ page }).withRules(rules).analyze();
  return res.violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, target: n.target })));
}

// The corpus self-check. This is the one part of the harness that is green at
// handoff, and it must be: it proves the fixtures actually contain the failures
// they claim, so a later green run means the extension worked rather than the
// fixtures being empty.
test.describe('fixtures contain the failures they claim', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchClean(); });
  test.afterAll(async () => { await ctx?.close(); });

  for (const name of FIXTURES) {
    const spec = EXPECT[name];
    test(`${name} — ${spec.violationsBefore} violations without the extension`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 600);
      const found = await violationsOn(page, spec.axeRules);
      expect(found.length, `expected ${spec.violationsBefore}, got ${JSON.stringify(found, null, 2)}`)
        .toBe(spec.violationsBefore);
      await page.close();
    });
  }
});

// Definition of done, criterion 1.
test.describe('the extension drives violations to zero', () => {
  let ctx;
  test.beforeAll(async () => { ctx = await launchWithExtension(); });
  test.afterAll(async () => { await ctx?.close(); });

  for (const name of FIXTURES) {
    const spec = EXPECT[name];
    test(`${name} — zero violations with the extension`, async () => {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(name));
      await settle(page, spec.settleMs ?? 2500);
      const found = await violationsOn(page, spec.axeRules);
      expect(found, `still failing: ${JSON.stringify(found, null, 2)}`).toEqual([]);
      await page.close();
    });
  }
});
