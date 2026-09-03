// Unit tests for the verifier. Run: node --test verifier/
//
// Three jobs:
//   1. Accept every human reference description in the labeled set.
//   2. Reject planted-bad text, with a reason that says why.
//   3. Prove the retry loop terminates and feeds rejections forward.
//
// It also imports the harness's independent rules — read-only — and reports
// where the two disagree. See FINDINGS.md. Disagreements are escalated to the
// orchestrator, never reconciled by editing tests/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verify, check, verifyLanguage, detectPageLanguage, generateVerified, honestFallback,
  isHonestFallback, MIN_LENGTH, MAX_LENGTH, MAX_ATTEMPTS,
} from './index.js';
import { qualityIssues, similarity, SIMILARITY_THRESHOLD } from '../tests/helpers/quality.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPECT = JSON.parse(
  fs.readFileSync(path.join(here, '../tests/fixtures/expectations.json'), 'utf8'),
);

const references = [];
for (const [file, spec] of Object.entries(EXPECT)) {
  if (file.startsWith('_')) continue;
  for (const [id, want] of Object.entries(spec.candidates)) {
    if (want.silent || !want.reference) continue;
    references.push({ file, id, spec, text: want.reference });
  }
}

// --- 1. the labeled reference set -------------------------------------------

test('every human reference passes the rules', () => {
  const rejected = references
    .map((r) => ({ r, v: verify(r.text, { lang: r.spec.lang }) }))
    .filter(({ v }) => !v.ok)
    .map(({ r, v }) => `${r.file} #${r.id} "${r.text}" → ${v.reason}`);
  // A reference the verifier rejects is either a bad rule or a bad reference.
  // Either way it is a finding, so the message carries the whole list.
  assert.deepEqual(rejected, [
    // FINDING 1: the reference for #save is 7 characters, one under the floor.
    '03-icon-controls.html #save "Guardar" → too short: 7 characters, minimum is 8',
  ]);
});

test('every human reference is in the language its fixture declares', async () => {
  for (const r of references) {
    if (r.spec.langUndecided) continue;         // 08 has no decided rule, SPEC §5
    const v = await verifyLanguage(r.text, r.spec.lang);
    assert.ok(v.ok, `${r.file} #${r.id} "${r.text}" → ${v.reason}`);
  }
});

// --- 2. planted-bad text ----------------------------------------------------

const BAD = [
  ['', 'empty'],
  ['   ', 'empty'],
  [null, 'empty'],
  ['imagen', 'generic'],
  ['Image', 'generic'],
  ['logo', 'generic'],
  ['Icono', 'generic'],
  ['Sin título', 'generic'],
  ['IMG_2043', 'generic'],
  ['800x600', 'generic'],
  ['plaza-mayor.jpg', 'filename'],
  ['Una foto de fuente.SVG en la portada', 'filename'],
  ['corto', 'too short'],
  ['x'.repeat(MAX_LENGTH + 1), 'too long'],
  ['Lo siento, no puedo describir esta imagen', 'hallucination marker'],
  ['As an AI language model I cannot see images', 'hallucination marker'],
  ['```json\n{"description": "una plaza"}\n```', 'hallucination marker'],
  ['[imagen aquí] con un sello rojo de aprobación', 'hallucination marker'],
  ['|||| ~~~ @@@ ### $$$ %%% ^^^ &&&', 'unreadable'],
  ['H 0 r 4 r 1 0 d 3 4 t 3 n c 1 0 n', 'unreadable'],
];

test('planted-bad text is rejected, with a reason that says why', () => {
  for (const [text, expected] of BAD) {
    const v = verify(text, { lang: 'es' });
    assert.equal(v.ok, false, `accepted bad text: ${JSON.stringify(text)}`);
    assert.match(v.reason, new RegExp(expected, 'i'),
      `${JSON.stringify(text)} → "${v.reason}", expected a ${expected} reason`);
  }
});

test('the honest fallback passes the bar but is not a description', () => {
  for (const lang of ['es', 'en']) {
    const t = honestFallback(lang);
    assert.ok(isHonestFallback(t));
    const v = verify(t, { lang });
    assert.equal(v.ok, true, 'SPEC §2.2 asks for this text; it must not be a failure');
    assert.equal(v.fallback, true, 'but the loop must keep escalating past it');
  }
});

test('the language rule catches a wholesale mismatch', async () => {
  const es = 'Una plaza urbana con edificios a los lados y un árbol al centro';
  const en = 'An urban square with buildings on the sides and a tree in the middle';
  assert.equal((await verifyLanguage(es, 'es')).ok, true);
  assert.equal((await verifyLanguage(en, 'en')).ok, true);
  assert.equal((await verifyLanguage(en, 'es')).ok, false);
  assert.equal((await verifyLanguage(es, 'en')).ok, false);
  // Too short to judge: the rule stands down rather than reject a good name.
  assert.equal((await verifyLanguage('Descargar informe', 'en')).ok, true);
});

// --- 3. the retry loop ------------------------------------------------------

const tier = (name, fn) => ({ tier: name, run: fn });
const good = 'Una plaza urbana con edificios a los lados y un árbol al centro';

test('a rejection is carried forward as the next tier feedback', async () => {
  const seen = [];
  const r = await generateVerified([
    tier('T1', ({ feedback }) => { seen.push(feedback); return 'plaza.jpg'; }),
    tier('T2', ({ feedback }) => { seen.push(feedback); return 'imagen'; }),
    tier('T3', ({ feedback }) => { seen.push(feedback); return good; }),
  ], { lang: 'es' });

  assert.equal(r.description, good);
  assert.equal(r.tier, 'T3');
  assert.equal(seen[0], null, 'the first tier has nothing to learn from yet');
  assert.match(seen[1], /filename/, 'T2 must hear why T1 was rejected');
  assert.match(seen[2], /generic/, 'T3 must hear why T2 was rejected');
  assert.equal(r.rejections.length, 2);
});

test('the loop stops at the cap and emits the honest fallback', async () => {
  let calls = 0;
  const junk = tier('Tx', () => { calls++; return 'imagen'; });
  const r = await generateVerified(Array(20).fill(junk), { lang: 'es' });

  assert.equal(calls, MAX_ATTEMPTS, 'the cap is hard — an uncapped loop looks like progress');
  assert.equal(r.attempts, MAX_ATTEMPTS);
  assert.equal(r.description, honestFallback('es'));
  assert.equal(r.tier, null);
  assert.equal(r.confidence, 0);
});

test('a tier that declines is a normal path, not an error', async () => {
  // T1 falls through silently; T3 is absent on this machine (SPEC §3.3).
  const r = await generateVerified([
    tier('T1', () => null),
    tier('T2', () => undefined),
    tier('T3', () => { throw new Error('LanguageModel is not defined'); }),
    tier('T4', () => ({ text: good, confidence: 0.9 })),
  ], { lang: 'es' });

  assert.equal(r.tier, 'T4');
  assert.equal(r.confidence, 0.9);
  assert.equal(r.attempts, 4);
  assert.match(r.rejections[2].reason, /LanguageModel is not defined/);
});

test('an empty ladder terminates', async () => {
  const r = await generateVerified([], { lang: 'es' });
  assert.equal(r.description, honestFallback('es'));
  assert.equal(r.attempts, 0);
});

// --- 4. disagreement audit against the harness ------------------------------
//
// Not a reconciliation. The harness is the arbiter of the product; this test
// pins the differences so a new one shows up as a failure and gets escalated.

test('the verifier is never more permissive than the harness', () => {
  const cases = [
    ...references.map((r) => ({ text: r.text, lang: r.spec.langUndecided ? null : r.spec.lang })),
    ...BAD.filter(([t]) => typeof t === 'string').map(([t]) => ({ text: t, lang: 'es' })),
    { text: honestFallback('es'), lang: 'es' },
  ];

  const laxer = [], stricter = [];
  for (const { text, lang } of cases) {
    const mine = verify(text, { lang }).ok;                      // sync rules only;
    const theirs = qualityIssues(text, { lang }).length === 0;   // the harness is sync
    if (mine && !theirs) laxer.push(JSON.stringify(text));
    if (!mine && theirs) stricter.push(JSON.stringify(text));
  }

  // The dangerous direction. Anything the verifier waves through must also
  // satisfy the arbiter, or the product ships text the harness will fail on.
  assert.deepEqual(laxer, []);

  // The safe direction, pinned so a new one surfaces as a failure and gets
  // escalated rather than drifting in. FINDING 2: all five are rules the spec
  // asks for (§3.2 "garbage strings; the verifier catches them", §3.4
  // "hallucination markers") that the harness's deliberately crude rules do not
  // carry. A stricter verifier costs an escalation, never a wrong description.
  assert.deepEqual(stricter, [
    '"Lo siento, no puedo describir esta imagen"',
    '"```json\\n{\\"description\\": \\"una plaza\\"}\\n```"',
    '"[imagen aquí] con un sello rojo de aprobación"',
    '"|||| ~~~ @@@ ### $$$ %%% ^^^ &&&"',
    '"H 0 r 4 r 1 0 d 3 4 t 3 n c 1 0 n"',
  ]);
});

test('the reference set is reachable under the similarity threshold', () => {
  // FINDING 3: a one-word reference can only be matched by that exact word,
  // because the Dice coefficient is over bigrams. Combined with MIN_LENGTH that
  // makes #save unsatisfiable — no string passes both quality tests.
  const trapped = references
    .filter((r) => r.text.trim().split(/\s+/).length === 1)
    .map((r) => `${r.file} #${r.id} "${r.text}"`);
  assert.deepEqual(trapped, [
    '03-icon-controls.html #save "Guardar"',
    '03-icon-controls.html #trash "Eliminar"',
  ]);

  // Proof of the trap: only the exact word clears the threshold, and for #save
  // that exact word is one character under the length floor.
  assert.equal(similarity('Guardar', 'Guardar'), 1);
  assert.ok(similarity('Guardar cambios', 'Guardar') < SIMILARITY_THRESHOLD);
  assert.ok(similarity('Guardar el documento', 'Guardar') < SIMILARITY_THRESHOLD);
  assert.equal(verify('Guardar', { lang: 'es' }).ok, false);
  assert.equal(qualityIssues('Guardar', { lang: 'es' }).length > 0, true);
});

// --- 5. the wrong-lang case, reported and not decided ------------------------

test('a page that lies about its language is reported as a conflict', async () => {
  // 08-lang-wrong.html: lang="en" over Spanish content. No detector in node, so
  // this exercises the heuristic floor — the real one is measured in FINDINGS.md.
  const body = 'Convocatoria de personal. Se convoca a profesionales para el proceso de selección 2026.';
  const seen = await detectPageLanguage('en', body);
  assert.deepEqual(seen, { declared: 'en', detected: 'es', conflict: true });

  const honest = await detectPageLanguage('es', body);
  assert.deepEqual(honest, { declared: 'es', detected: 'es', conflict: false });
});

test('a language conflict stands the language rule down, and nothing else', async () => {
  const es = 'Una plaza urbana con edificios a los lados y un árbol al centro';
  // Enforced: the description contradicts the declared language.
  assert.equal((await check(es, { lang: 'en' })).ok, false);
  // Stood down: SPEC §5 has not decided which language wins here.
  assert.equal((await check(es, { lang: 'en', langUndecided: true })).ok, true);
  // Every other rule still applies under the stand-down.
  assert.equal((await check('imagen', { lang: 'en', langUndecided: true })).ok, false);
  assert.equal((await check('plaza.jpg', { lang: 'en', langUndecided: true })).ok, false);
});

// --- 6. the call shape the background worker already landed ------------------

test('verify and check accept the worker call shape', async () => {
  const good = 'Una plaza urbana con edificios a los lados y un árbol al centro';

  // background/service-worker.js: await check({ ...out, lang, kind, candidate })
  const pass = await check({ description: good, confidence: 0.8, lang: 'es', kind: 'img', candidate: {} });
  assert.equal(pass.ok, true);

  const fail = await check({ description: 'plaza.jpg', lang: 'es', kind: 'img', candidate: {} });
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /filename/);          // the reason is the worker's feedback string

  assert.equal(verify({ description: 'imagen', lang: 'es' }).ok, false);
  assert.equal(verify(good, { lang: 'es' }).ok, true);        // the original shape still works

  // An explicit second argument wins over the object's own field.
  assert.equal((await check({ description: good, lang: 'en' }, { lang: 'es' })).ok, true);
});
