// AriaWeave verifier — SPEC §3.4.
//
// Rules first, cheapest to check: non-empty, not generic, length bounds,
// requested language, no hallucination markers. A rejection carries a *reason*,
// because the reason is the feedback the next tier receives. That loop is the
// autonomous behaviour the project is graded on (SPEC §6.3).
//
// Written independently of tests/helpers/quality.js on purpose. The constants
// happen to agree; the code does not import it, so a broken verifier cannot
// pass its own tests. Where the two disagree, see FINDINGS.md — a disagreement
// is escalated, not patched away.

export const MIN_LENGTH = 8;

// A control label is legitimately short — "Buscar", "Cerrar", "Guardar" — while
// an image description that short has said nothing. A single floor of 8 silently
// rejected T1's correct answers for controls and pushed them to the honest
// generic, which reads as "the tier had nothing" rather than "the arbiter said
// no". This same floor existed in four other places for the same reason: it was
// written from §2.2's example, which is about images.
export const MIN_LENGTH_BY_KIND = { img: 8, button: 3, link: 3, input: 3 };
const floorFor = (kind) => MIN_LENGTH_BY_KIND[kind] ?? MIN_LENGTH;
export const MAX_LENGTH = 250;
export const MAX_ATTEMPTS = 4;          // hard cap, SPEC §3.4. No exceptions.

// Emitted deliberately when nothing clears the bar. Honest, and worth more than
// a confident guess (SPEC §2.2). Not a description, so it never satisfies a tier.
const FALLBACK = {
  es: 'Imagen no descrita con confianza',
  en: 'Image not described with confidence',
};
const FALLBACK_RE = /no descrit[ao] con confianza|not described with confidence/i;

export function honestFallback(lang) {
  return FALLBACK[base(lang)] ?? FALLBACK.en;
}

const base = (lang) => String(lang ?? '').slice(0, 2).toLowerCase();

// --- rules ------------------------------------------------------------------

const GENERIC = [
  /^(image|imagen|photo|foto|picture|imagen|figura|figure|graphic|gr[aá]fico|dibujo)\.?$/i,
  /^(logo|icon|icono|banner|thumbnail|miniatura|bot[oó]n|button|enlace|link)\.?$/i,
  /^(untitled|sin t[ií]tulo|unnamed|sin nombre)\.?$/i,
  /^(img|dsc|image|foto|screenshot|captura)[-_ ]?\d+/i,
  /^\d+\s*[x×]\s*\d+$/,                       // "800x600" — a dimension, not a name
];
// A filename anywhere in the string, not just alone: T1's junk-alt failure mode
// is "plaza-mayor.jpg", not "jpg".
const FILENAME = /[\w%-]+\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff?)\b/i;

// Model artefacts, not style. Kept narrow on purpose: rejecting merely wordy
// prose would escalate good descriptions into the fallback for nothing.
const HALLUCINATION = [
  /\b(as an ai|i'?m an ai|language model|no puedo|i can'?t|i cannot|unable to)\b/i,
  /\b(lo siento|i'?m sorry|disculpa)\b/i,
  /```|^\s*[{[]"|"(description|descripcion|alt)"\s*:/i,   // fenced or JSON leakage
  /\b(lorem ipsum|todo|tbd|placeholder|xxx+)\b/i,
  /\[(image|imagen|insert|inserta)[^\]]*\]/i,
];

// T2's failure mode is garbage strings (SPEC §3.2). Two cheap shapes catch it:
// punctuation soup, and a scatter of one-character tokens.
function looksLikeGarbage(t) {
  const wordish = (t.match(/[\p{L}\p{N}\s]/gu) ?? []).length;
  if (wordish / t.length < 0.6) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  const singles = tokens.filter((w) => w.length === 1).length;
  return tokens.length >= 4 && singles / tokens.length > 0.5;
}

export function isHonestFallback(text) {
  return typeof text === 'string' && FALLBACK_RE.test(text);
}

const ok = () => ({ ok: true });
const no = (reason) => ({ ok: false, reason });

// Two call shapes, because the background worker landed one before this module
// existed: `check({ description, lang, kind, candidate })`. An MV3 service
// worker forbids dynamic import(), so that call site is fixed at load time and
// cannot adapt to us — we adapt to it. `verify(text, { lang })` stays the shape
// the unit tests use. Extra fields (kind, candidate) are accepted and ignored;
// no rule reads them today.
function args(a, b) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    return { text: a.description ?? a.text ?? null, ...b, lang: b?.lang ?? a.lang,
             kind: b?.kind ?? a.kind, langUndecided: b?.langUndecided ?? a.langUndecided };
  }
  return { text: a, ...b };
}

/**
 * The synchronous rules. Language is checked separately because the built-in
 * detector is async; `check()` runs both.
 *
 * @returns {{ok: boolean, reason?: string, fallback?: boolean}}
 *   `fallback: true` means the text is the honest-generic string. It passes the
 *   quality bar (SPEC §2.2 asks for it) but it is not a description, so the
 *   retry loop keeps escalating instead of settling for it.
 */
export function verify(input, opts) {
  const { text, lang, kind } = args(input, opts);
  if (text == null) return no('empty: the tier produced no text');
  const t = String(text).trim();

  if (!t) return no('empty: the tier produced no text');
  if (isHonestFallback(t)) return { ok: true, fallback: true };

  for (const re of GENERIC) {
    if (re.test(t)) return no(`generic: "${t}" names the medium, not the content`);
  }
  if (FILENAME.test(t)) return no(`filename: "${t}" is a file name, not a description`);

  const floor = floorFor(kind);
  if (t.length < floor) return no(`too short for a ${kind || 'description'}: ${t.length} characters, minimum is ${floor}`);
  if (t.length > MAX_LENGTH) return no(`too long: ${t.length} characters, maximum is ${MAX_LENGTH}`);

  for (const re of HALLUCINATION) {
    if (re.test(t)) return no(`hallucination marker: "${t}" reads as model output, not as a description`);
  }
  if (looksLikeGarbage(t)) return no(`unreadable: "${t}" is not running text`);

  return ok();
}

// --- language ---------------------------------------------------------------

// Chrome's built-in Language Detector: on-device, free, keyless, and a separate
// API from the Prompt API (SPEC §3.3). It is not always there — a service worker
// on an older Chrome has none — so the heuristic below is the floor, never the
// preference.
let detectorPromise = null;

function detectorApi() {
  return typeof LanguageDetector !== 'undefined' ? LanguageDetector : null;
}

async function getDetector() {
  const api = detectorApi();
  if (!api) return null;
  // Never cache a failed result: one absent detector must not become permanent.
  if (!detectorPromise) {
    detectorPromise = (async () => {
      // Do not call create() while merely `downloadable` — that needs a user
      // gesture (SPEC §3.3.2) and throws NotAllowedError from a worker.
      const state = await api.availability?.();
      if (state && state !== 'available') throw new Error(`detector ${state}`);
      return api.create();
    })().catch((e) => { detectorPromise = null; throw e; });
  }
  try { return await detectorPromise; } catch { return null; }
}

// Enough of a signal to trust the detector's answer. Below this the text is too
// short to judge and the rule stands down rather than rejecting a good name.
const DETECT_CONFIDENCE = 0.5;
const MIN_WORDS_TO_JUDGE_LANGUAGE = 4;

const MARKERS = {
  es: /\b(el|la|los|las|un|una|unos|unas|de|del|con|sobre|en|y|que|para|se|su|por|al)\b/gi,
  en: /\b(the|a|an|of|with|on|in|and|that|for|is|are|its|to|at)\b/gi,
};

// Fallback only, for when the built-in detector is absent. Counts markers on
// both sides rather than testing one: a Spanish sentence containing "a los
// lados" trips \ba\b and would otherwise read as English.
// Returns null for "cannot tell" — too short, or a tie.
export function guessLanguage(text, want) {
  if (!MARKERS[base(want)]) return null;

  // Abstain below four words. A marker count on a short label is not evidence:
  // "Ir a Facebook" carries no Spanish stopword from any reasonable list while
  // "a" sits in the English one, so counting called correct Spanish English and
  // rejected it. Control labels are routinely two or three words, which is
  // exactly where this heuristic stops meaning anything — and unlike the async
  // detector, which has DETECT_CONFIDENCE to hold it back, this fallback had no
  // such floor.
  if (String(text).trim().split(/\s+/).filter(Boolean).length < MIN_WORDS_TO_JUDGE_LANGUAGE) return null;
  const hits = (lang) => (String(text).match(MARKERS[lang]) ?? []).length;
  const es = hits('es'), en = hits('en');
  if (es === en) return null;
  return es > en ? 'es' : 'en';
}

/** @returns {Promise<{ok: boolean, reason?: string}>} */
export async function verifyLanguage(text, lang) {
  const want = base(lang);
  if (!want) return ok();                       // no requested language, no rule
  const t = String(text ?? '').trim();
  if (!t) return ok();                          // verify() already rejected it

  // A label of one or two words carries no language worth acting on, whichever
  // detector answers. "Anterior" is a correct Spanish button label and also an
  // ordinary English word, and Chrome's on-device detector confidently called
  // it English — so a correct name was rejected while "Cerrar" and "Siguiente",
  // which exist only in Spanish, passed. Confidence is not the guard here: the
  // detector was confident and wrong, because the word genuinely belongs to
  // both languages.
  //
  // guessLanguage() already abstains below this threshold; the async path needs
  // the same floor, or the better detector produces the worse outcome.
  if (t.split(/\s+/).filter(Boolean).length < MIN_WORDS_TO_JUDGE_LANGUAGE) return ok();

  const detector = await getDetector();
  if (detector) {
    const [top] = (await detector.detect(t)) ?? [];
    if (!top || top.confidence < DETECT_CONFIDENCE) return ok();   // too short to judge
    const got = base(top.detectedLanguage);
    return got === want
      ? ok()
      : no(`wrong language: the page asks for ${want}, this reads as ${got}`);
  }

  const got = guessLanguage(t, want);
  if (!got || got === want) return ok();
  return no(`wrong language: the page asks for ${want}, this reads as ${got}`);
}

/**
 * What language the page actually asks for, and whether it is lying about it.
 *
 * SPEC §5: the screen reader takes its voice from `documentElement.lang`, so
 * the DOM decides. Real pages get this wrong — `08-lang-wrong.html` declares
 * `lang="en"` over Spanish content — and **SPEC §5 defers that rule on
 * purpose**. So this reports the conflict and does not resolve it: `conflict`
 * true means the verifier declines to enforce a rule nobody has decided.
 *
 * Standing down is not a decision. Whichever way the orchestrator rules, the
 * change is one branch in `check()` — see FINDINGS.md finding 4.
 */
export async function detectPageLanguage(declared, sampleText) {
  const want = base(declared);
  const t = String(sampleText ?? '').trim();
  if (!want || !t) return { declared: want || null, detected: null, conflict: false };

  const detector = await getDetector();
  let detected = null;
  if (detector) {
    const [top] = (await detector.detect(t)) ?? [];
    if (top && top.confidence >= DETECT_CONFIDENCE) detected = base(top.detectedLanguage);
  } else {
    detected = guessLanguage(t, want);
  }
  return { declared: want, detected, conflict: !!detected && detected !== want };
}

/**
 * verify() plus the language rule. This is what the retry loop calls.
 *
 * `langUndecided` suppresses the language rule only — every other rule stands.
 * Pass it from `detectPageLanguage().conflict`.
 */
export async function check(input, opts) {
  // `kind` was destructured out and never forwarded, so verify() fell back to
  // the image floor of 8 for every kind and rejected "Buscar" — a correct
  // answer for a button — as too short. The rules and the caller disagreed
  // about what was being verified.
  const { text, lang, kind, langUndecided = false } = args(input, opts);
  const rules = verify(text, { lang, kind });
  if (!rules.ok || rules.fallback) return rules;
  if (langUndecided) return { ok: true, langUndecided: true };
  return verifyLanguage(text, lang);
}

// --- the retry loop ---------------------------------------------------------

/**
 * Run the tier ladder until something passes the verifier, feeding each
 * rejection reason forward as the next tier's feedback (SPEC §3.2).
 *
 * @param tiers  [{ tier: 'T1', run: async ({lang, feedback, attempt}) => string
 *                                    | {text, confidence} | null }]
 *               `null` means the tier declined — T1 falling through silently, or
 *               T3 being absent, which is a normal path (SPEC §3.3).
 * @returns {Promise<{description, tier, confidence, attempts, rejections}>}
 *          On exhaustion: the honest fallback, `tier: null`, `confidence: 0`.
 */
export async function generateVerified(tiers, { lang, langUndecided = false, maxAttempts = MAX_ATTEMPTS } = {}) {
  const rejections = [];
  let feedback = null;
  let attempts = 0;

  for (const { tier, run } of tiers) {
    if (attempts >= maxAttempts) break;         // hard cap, checked before the work
    attempts++;

    let out = null;
    try {
      out = await run({ lang, feedback, attempt: attempts });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;    // a cancelled page is not a rejection
      out = null;
      rejections.push({ tier, reason: `tier failed: ${e?.message ?? e}` });
      feedback = rejections.at(-1).reason;
      continue;
    }

    const text = typeof out === 'string' ? out : out?.text ?? null;
    const confidence = typeof out === 'object' && out ? out.confidence : undefined;

    const v = await check(text, { lang, langUndecided });
    if (v.ok && !v.fallback) {
      return {
        description: String(text).trim(),
        tier,
        confidence: confidence ?? 1,
        attempts,
        rejections,
      };
    }

    const reason = v.reason ?? 'declined: the tier produced nothing';
    rejections.push({ tier, reason });
    feedback = reason;
  }

  return {
    description: honestFallback(lang),
    tier: null,
    confidence: 0,
    attempts,
    rejections,
  };
}
