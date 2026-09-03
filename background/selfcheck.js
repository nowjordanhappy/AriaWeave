// Lane B's own runnable check: `node background/selfcheck.js`.
//
// Not a substitute for the harness — it cannot see the DOM and it does not try.
// It covers the parts that are pure decisions and would fail silently: routing,
// language choice, the escalation loop with its cap, viewport-first ordering,
// and the one invariant that must never regress, "never cache a failure".

import assert from 'node:assert/strict';

// A service worker's globals, minimally. Enough to import the modules; the
// tiers themselves are absent here, which is exactly the branch worth exercising.
const storage = new Map();
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} } },
  tabs: { sendMessage: async () => {} },
  storage: {
    local: {
      async get(k) {
        if (k === null) return Object.fromEntries(storage);
        return storage.has(k) ? { [k]: storage.get(k) } : {};
      },
      async set(o) { for (const [k, v] of Object.entries(o)) storage.set(k, v); },
      async remove(keys) { [].concat(keys).forEach((k) => storage.delete(k)); },
    },
  },
};

const { route, isJunkName } = await import('./router.js');
const { pickLang, detectLang, honestFallback, T1, visionPrompt } = await import('./pipeline.js');
const cache = await import('./cache.js');
const sw = await import('./service-worker.js');

const img = (o = {}) => ({ selector: '#x', kind: 'img', src: 'a.svg', bbox: { width: 320, height: 200 }, context: {}, ...o });
let n = 0;
const ok = async (label, fn) => { await fn(); n++; process.stdout.write(`  ok  ${label}\n`); };

// --- router: rules give guarantees ------------------------------------------

await ok('a usable existing name is left alone', () => {
  assert.equal(route(img({ context: { alt: 'Una plaza urbana con un árbol' } })).action, 'skip');
});
await ok('junk alt is not a name', () => {
  for (const junk of ['IMG_2024_final.jpg', 'imagen', '220x200', '', 'logo', 'DSC01234'])
    assert.equal(isJunkName(junk), true, junk);
  assert.equal(isJunkName('Un documento con un sello rojo'), false);
});
await ok('spacers and hairlines are silenced, not described', () => {
  assert.equal(route(img({ bbox: { width: 1, height: 1 } })).action, 'silence');
  assert.equal(route(img({ bbox: { width: 600, height: 2 } })).action, 'silence');
  assert.equal(route(img({ src: 'spacer.svg', bbox: { width: 300, height: 300 } })).action, 'silence');
  assert.equal(route(img({ bbox: { width: 220, height: 200 } })).action, 'describe');
});
await ok('a 24px icon BUTTON is a control, not furniture', () => {
  assert.equal(route(img({ kind: 'button', src: undefined, bbox: { width: 24, height: 24 } })).action, 'describe');
});
await ok('a text-heavy raster routes through OCR before any model', () => {
  const plan = route(img({ src: 'assets/banner-horario.png', bbox: { width: 640, height: 240 } }));
  assert.deepEqual(plan.tiers, ['T1', 'T2', 'T3', 'T4']);
});
await ok('a vector image skips OCR — its words are already in the DOM', () => {
  assert.deepEqual(route(img({ src: 'plaza.svg' })).tiers, ['T1', 'T3', 'T4']);
});

// --- language: the DOM decides ----------------------------------------------

await ok('declared lang wins, even when the page is lying', () => {
  assert.equal(pickLang(img({ context: { lang: 'en', pageText: 'Se convoca a profesionales para el proceso' } })), 'en');
});
await ok('no declared lang falls back to detection', () => {
  assert.equal(pickLang(img({ context: { pageText: 'El servicio de recojo de basura se suspende el feriado' } })), 'es');
  assert.equal(detectLang('The waste collection service is suspended on the holiday'), 'en');
});

// --- T1: reuses what a human already wrote ----------------------------------

await ok('T1 reuses text a human already wrote, and the filename of a PDF link', async () => {
  assert.equal((await T1(img({ context: { figcaption: 'La nueva fuente de la plaza central' } }), 'es'))?.tier, 'T1');
  assert.equal(
    (await T1(img({ kind: 'link', src: undefined, context: { href: '/informe.pdf' } }), 'es'))?.description,
    'Descargar el informe en PDF');
  assert.equal(
    (await T1(img({ kind: 'input', src: undefined, context: { preceding: 'Número de documento' } }), 'es'))?.description,
    'Número de documento');
});
await ok('an icon button gets NO rule — reading "save" off a floppy outline is the banned confident guess', async () => {
  assert.equal(await T1(img({ kind: 'button', src: undefined, context: {} }), 'es'), null);
});

// --- the ladder with every model tier absent --------------------------------

await ok('all model tiers absent yields the honest fallback, never a guess', async () => {
  const out = await sw.describe(img(), 'es', { tiers: ['T3', 'T4'] }, false);
  assert.equal(out.description, honestFallback('es'));
  assert.equal(out.fallback, true);
  assert.ok(out.confidence < 0.5);
});

await ok('the verifier fallback rejects exactly what the spec names', () => {
  const v = sw.fallbackVerify;
  assert.equal(v({ description: '' }).ok, false);
  assert.equal(v({ description: 'imagen' }).ok, false);
  assert.equal(v({ description: 'IMG_2024_final.jpg' }).ok, false);
  assert.equal(v({ description: 'I cannot see the image clearly enough' }).ok, false);
  assert.equal(v({ description: 'x'.repeat(300) }).ok, false);
  assert.equal(v({ description: 'The square is blue', lang: 'es' }).ok, false);
  assert.equal(v({ description: 'Una plaza urbana con un árbol al centro', lang: 'es' }).ok, true);
});

await ok('a rejection is carried into the retry as feedback', () => {
  const p = visionPrompt(img(), 'es', 'generic placeholder, not a description');
  assert.match(p, /rechazado por: generic placeholder/);
});

await ok('an absent tier is a skipped rung — not an exception, not a loop', async () => {
  // T3 and T4 are both absent under Node, which is the branch SPEC 3.3 calls
  // normal. The run must terminate with the fallback and no throw.
  const out = await sw.describe(img(), 'es', { tiers: ['T3', 'T4', 'T3'] }, false);
  assert.equal(out.fallback, true);
});

// --- scheduling: visible work first, not DOM order --------------------------

await ok('visible candidates jump the queue regardless of DOM order', () => {
  const below = img({ selector: '#below', bbox: { width: 300, height: 300, y: 4000 } });
  const above = img({ selector: '#above', bbox: { width: 100, height: 100, y: 10 } });
  const big   = img({ selector: '#big',   bbox: { width: 900, height: 600, y: 20 } });
  const order = sw.schedule([below, above, big]).map((c) => c.selector);
  assert.deepEqual(order, ['#big', '#above', '#below']);
});
await ok('lane A saying inViewport beats the fold guess', () => {
  const a = img({ selector: '#a', bbox: { width: 10, height: 10, y: 9000 }, context: { inViewport: true } });
  const b = img({ selector: '#b', bbox: { width: 10, height: 10, y: 0 }, context: { inViewport: false } });
  assert.deepEqual(sw.schedule([b, a]).map((c) => c.selector), ['#a', '#b']);
});

// --- the invariant ----------------------------------------------------------

await ok('NEVER CACHE A FAILURE', async () => {
  const key = await cache.keyFor({ src: 'x.png', kind: 'img', lang: 'es', context: '{}' });
  await cache.put(key, { description: '', confidence: 1, tier: 'T3' });
  assert.equal(await cache.get(key), null, 'empty description was cached');

  await cache.put(key, { description: honestFallback('es'), confidence: 0.2, tier: 'T3', fallback: true });
  assert.equal(await cache.get(key), null, 'the honest fallback was cached — retries become decoration');

  await cache.put(key, { description: 'Una plaza urbana con un árbol', confidence: 0.3, tier: 'T3' });
  assert.equal(await cache.get(key), null, 'a low-confidence result was cached');

  await cache.put(key, { description: 'Una plaza urbana con un árbol', confidence: 0.9, tier: 'T3' });
  assert.equal((await cache.get(key))?.tier, 'T3', 'a good result was NOT cached');
});
await ok('the same picture at two URLs is one cache entry', async () => {
  const bytes = new TextEncoder().encode('pretend-png');
  const a = await cache.keyFor({ bytes, src: 'https://a/one.png', kind: 'img', lang: 'es', context: '{}' });
  const b = await cache.keyFor({ bytes, src: 'https://b/two.png', kind: 'img', lang: 'es', context: '{}' });
  assert.equal(a, b);
});

console.log(`\n${n} checks passed`);
