// Lane B — the pipeline. Candidates in, descriptions out.
//
// Contract (SPEC 4, frozen):
//   Candidate = { selector, kind, src?, bbox, context }     content -> background
//   Result    = { selector, description, confidence, tier } background -> content
//
// Three things here are requirements rather than polish:
//   1. Viewport-first scheduling. Nano measured 1968ms per image (SPEC 3.3.2),
//      so a queue drained in DOM order takes forty seconds on twenty images and
//      the budget is time-to-first-VISIBLE-description, not page-complete.
//   2. The escalation loop. A tier's output goes to the verifier; only on
//      rejection does the next, costlier tier run, carrying the reason.
//   3. Never cache a failure. Enforced in cache.js, at the single writer.

import { route } from './router.js';
import * as cache from './cache.js';
import {
  T1, T2, T3, T4, loadImage, pickLang, honestFallback, visionPrompt,
  nanoAvailability, ocrAvailable, cloudAvailable,
} from './pipeline.js';

const CONCURRENCY = 2;          // two Nano sessions is the memory a laptop spares
const MAX_ATTEMPTS = 4;         // hard cap: the retry loop cannot spin (SPEC 3.4)
import { verify as laneCVerify } from '../verifier/index.js';

const CONFIDENCE_FLOOR = 0.5;   // below this we say so honestly, never guess

const TIER_FN = { T1, T2, T3, T4 };

// ---------------------------------------------------------------------------
// verifier — lane C owns verifier/.
//
// ESCALATED TO THE ORCHESTRATOR, and the reason is a platform limit rather than
// a preference: an MV3 service worker forbids dynamic import() outright
// ("import() is disallowed on ServiceWorkerGlobalScope", w3c/ServiceWorker#1356),
// so the import list is fixed when the worker loads. Lane B cannot reach lane C
// unless `verifier/index.js` exists at load time, and a static import of a file
// that is not there kills the whole worker rather than one tier.
//
// An earlier version of this file did `await import('../verifier/index.js')`
// inside a try/catch. That was worse than not trying: it threw every time and
// swallowed it, so lane C's verifier would have been silently ignored forever
// while the harness stayed green on the fallback's own judgement.
//
// Until a placeholder `verifier/index.js` lands the way content/ and background/
// got theirs, the rules below stand in. Landing it is then a one-line change:
//     import { verify as laneC } from '../verifier/index.js';
// ---------------------------------------------------------------------------

// WIRED 2026-09-03. The placeholder lane B was waiting for now exists, so the
// one-line change it described is done: lane C's verifier is the arbiter and
// fallbackVerify below is dead weight kept only for background/selfcheck.js,
// which must be runnable without lane C present.
//
// This sat unwired through a merge. Nothing failed loudly — lane B's own rules
// stood in and the harness stayed green on them, which is exactly the shape of
// bug an integration seam produces: both sides correct, the wire absent.
const verify = laneCVerify;
const verifier = () => verify;

const GENERIC = /^(image|imagen|photo|foto|picture|figura|figure|logo|icon|icono|banner|graphic|gr[áa]fico|thumbnail|miniatura|untitled|sin t[íi]tulo)\.?$/i;
const HALLUCINATION = /\b(as an ai|no puedo|i cannot|i'm sorry|lo siento|unable to|no_lo_se)\b/i;
const FILENAME = /\.(jpe?g|png|gif|webp|svg|avif)\b/i;

// ponytail: the spec's own list, nothing more. Lane C's verifier replaces this
// wholesale — this exists so lane B is testable alone, not to compete with it.
function fallbackVerify({ description, lang }) {
  const t = String(description || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 8) return { ok: false, reason: 'too short to be a description' };
  if (t.length > 240) return { ok: false, reason: 'longer than 240 characters' };
  if (GENERIC.test(t)) return { ok: false, reason: 'generic placeholder, not a description' };
  if (FILENAME.test(t)) return { ok: false, reason: 'a filename is not a description' };
  if (HALLUCINATION.test(t)) return { ok: false, reason: 'refusal or hallucination marker' };
  if (lang && !matchesLang(t, lang)) return { ok: false, reason: `wrong language, expected ${lang}` };
  return { ok: true };
}

const LANG_MARKERS = {
  es: /\b(el|la|los|las|un|una|de|del|con|sobre|en|y|que|para|se|su)\b/i,
  en: /\b(the|a|an|of|with|on|in|and|that|for|is|are|its)\b/i,
};
function matchesLang(text, lang) {
  const want = LANG_MARKERS[String(lang).slice(0, 2).toLowerCase()];
  if (!want) return true;
  if (want.test(text)) return true;
  const other = want === LANG_MARKERS.es ? LANG_MARKERS.en : LANG_MARKERS.es;
  return !other.test(text);          // markerless and short: not ours to judge
}

// ---------------------------------------------------------------------------
// one candidate, all the way down the ladder
// ---------------------------------------------------------------------------

async function describe(candidate, lang, plan, image = null) {
  const check = verifier();
  let attempts = 0;
  let feedback = '';
  let best = null;
  let ran = null;        // the last tier that actually executed, not merely planned

  for (const tier of plan.tiers) {
    if (attempts >= MAX_ATTEMPTS) break;

    // Only fetch pixels once, and only when a tier that needs them is reached.
    if (tier !== 'T1' && image === null) image = await loadImage(candidate) ?? false;
    if (tier !== 'T1' && !image) continue;

    // Every tier below T1 may be absent — no OCR bundle, no Nano model, no key.
    // Absence is an ordinary branch: the ladder simply skips that rung.
    attempts++;
    const out = await TIER_FN[tier](candidate, lang, image || undefined, feedback);
    if (!out) continue;
    ran = tier;

    const verdict = await check({ ...out, lang, kind: candidate.kind, candidate });
    if (verdict?.ok) return out;

    feedback = verdict?.reason || 'rejected by the verifier';
    if (!best || out.confidence > best.confidence) best = out;

    // One same-tier retry at the top of the ladder, so the reject -> regenerate
    // -> pass loop still runs when there is no costlier tier left to escalate to.
    const last = tier === plan.tiers[plan.tiers.length - 1];
    if (last && attempts < MAX_ATTEMPTS) {
      const retry = await TIER_FN[tier](candidate, lang, image || undefined, feedback);
      attempts++;
      if (retry) {
        ran = tier;
        const again = await check({ ...retry, lang, kind: candidate.kind, candidate });
        if (again?.ok) return retry;
        feedback = again?.reason || feedback;
      }
    }
  }

  // Nothing cleared the bar. Say so, in the page's language, rather than
  // shipping the least-bad guess: a wrong description is worse than none.
  // `tier` is surfaced in inspection mode, so it names the tier that actually
  // ran — never the most expensive one we merely planned for. Reporting "T4"
  // for a page the cloud never touched would misread as money spent, and the
  // one thing a demo cannot afford is a confident wrong label about cost.
  return {
    description: honestFallback(lang),
    confidence: best ? Math.min(best.confidence, CONFIDENCE_FLOOR - 0.01) : 0,
    tier: best?.tier || ran || 'none',
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// scheduling — visible work first, off-screen work deferred
// ---------------------------------------------------------------------------

const area = (c) => (Number(c?.bbox?.width) || 0) * (Number(c?.bbox?.height) || 0);

// Lane A knows what is on screen; if it does not say, fall back to the vertical
// offset. ponytail: 900px stands in for a fold when `inViewport` is absent —
// wrong only in the direction of doing visible work slightly too eagerly.
function visible(c) {
  const flag = c?.context?.inViewport ?? c?.context?.visible;
  if (typeof flag === 'boolean') return flag;
  return (Number(c?.bbox?.y ?? c?.bbox?.top) || 0) < 900;
}

function schedule(jobs) {
  const c = (j) => j.candidate ?? j;
  return [...jobs].sort((ja, jb) => {
    const a = c(ja), b = c(jb);
    const va = visible(a), vb = visible(b);
    if (va !== vb) return va ? -1 : 1;              // on screen first, always
    if (va) return area(b) - area(a);               // then the biggest thing there
    return (a.bbox?.y || 0) - (b.bbox?.y || 0);     // off screen: reading order
  });
}

async function drain(jobs, worker) {
  const running = new Set();
  for (const job of jobs) {
    const p = worker(job).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= CONCURRENCY) await Promise.race(running);
  }
  await Promise.all(running);
}

// ---------------------------------------------------------------------------
// the page run
// ---------------------------------------------------------------------------

const stats = { fixed: 0, byTier: {}, cacheHits: 0 };

async function run(candidates, emit) {
  const results = [];
  const deferred = [];

  // Pass one: everything free and instant. This is what the latency budget
  // rides on — a page whose candidates are all rule-answerable never waits.
  for (const candidate of candidates) {
    const plan = route(candidate);
    if (plan.action === 'skip') continue;

    if (plan.action === 'silence') {
      results.push(record(emit, { selector: candidate.selector, description: '', confidence: 1, tier: 'T1' }));
      continue;
    }

    const lang = pickLang(candidate);
    const t1 = await T1(candidate, lang);
    if (t1) {
      const check = verifier();
      const verdict = await check({ ...t1, lang, kind: candidate.kind, candidate });
      if (verdict?.ok) {
        results.push(record(emit, { selector: candidate.selector, ...t1 }));
        continue;
      }
    }
    deferred.push({ candidate, lang, plan: { ...plan, tiers: plan.tiers.filter((t) => t !== 'T1') } });
  }

  // Pass two: the tiers that cost time or money, visible work first.
  await drain(schedule(deferred), async ({ candidate, lang, plan }) => {
    const image = await loadImage(candidate);
    const key = await cache.keyFor({
      bytes: image?.bytes, src: candidate.src || '', kind: candidate.kind, lang,
      context: JSON.stringify(candidate.context || '').slice(0, 512),
    });

    const hit = await cache.get(key);
    if (hit) {
      stats.cacheHits++;
      results.push(record(emit, { selector: candidate.selector, description: hit.description, confidence: hit.confidence, tier: hit.tier }));
      return;
    }

    const out = await describe(candidate, lang, plan, image ?? false);
    await cache.put(key, out);        // a no-op for the honest fallback, by design
    results.push(record(emit, {
      selector: candidate.selector, description: out.description,
      confidence: out.confidence, tier: out.tier,
    }));
  });

  return results;
}

function record(emit, result) {
  stats.fixed++;
  stats.byTier[result.tier] = (stats.byTier[result.tier] || 0) + 1;
  emit?.(result);
  return result;
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

let enabled = true;
chrome.storage?.local.get('aw:enabled').then((v) => {
  if (v?.['aw:enabled'] === false) enabled = false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Lane A owns the message envelope; recognise it by payload, not by a name
  // neither lane has agreed on yet.
  if (Array.isArray(msg?.candidates)) {
    if (!enabled) { sendResponse({ results: [], enabled: false }); return true; }
    const tabId = sender.tab?.id;
    // Stream each result the moment it lands, so a slow twentieth image never
    // holds up the first one. The full set also comes back on the response, so
    // an await-the-reply content script works too.
    const emit = tabId != null
      ? (r) => chrome.tabs.sendMessage(tabId, { type: 'ariaweave:result', result: r }).catch(() => {})
      : null;
    run(msg.candidates, emit).then(
      (results) => sendResponse({ results }),
      (error) => sendResponse({ results: [], error: String(error?.message || error) }),
    );
    return true;
  }

  if (msg?.type === 'ariaweave:status') {
    Promise.all([nanoAvailability(), ocrAvailable(), cloudAvailable()]).then(([nano, ocr, cloud]) => {
      sendResponse({ enabled, stats, tiers: { T1: true, T2: ocr, T3: nano, T4: cloud } });
    });
    return true;
  }

  if (msg?.type === 'ariaweave:enabled') {
    enabled = !!msg.value;
    chrome.storage?.local.set({ 'aw:enabled': enabled });
    sendResponse({ enabled });
    return true;
  }

  if (msg?.type === 'ariaweave:clear-cache') {
    cache.clear().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// Exported for the harness and for the popup's opt-in button.
export { run, describe, schedule, fallbackVerify, visionPrompt };
