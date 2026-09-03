// The harness's own quality rules.
//
// Deliberately NOT an import of the verifier that lane C builds. If the harness
// checked descriptions with the same code that produced them, a broken verifier
// would pass its own tests and the whole criterion would be circular. These
// rules are written from the spec, independently, and are allowed to disagree.

const GENERIC = [
  /^\s*$/,
  /^(image|imagen|photo|foto|picture|figura|figure|graphic|gr[áa]fico)\.?$/i,
  /^(logo|icon|icono|banner|thumbnail|miniatura)\.?$/i,
  /^(untitled|sin t[íi]tulo|unnamed)\.?$/i,
  /\.(jpe?g|png|gif|webp|svg)\b/i,          // a filename is not a description
  /^(img|dsc|image)[-_ ]?\d+/i,
];

// Emitted deliberately when confidence is low. Honest, and must not be scored
// as a quality failure — but it is also not a description, so it is counted.
const HONEST_FALLBACK = /no descrit[ao] con confianza|not described with confidence/i;

const MIN_LENGTH = 8;
const MAX_LENGTH = 250;

export function isHonestFallback(text) {
  return typeof text === 'string' && HONEST_FALLBACK.test(text);
}

export function qualityIssues(text, { lang } = {}) {
  const issues = [];
  if (text == null) return ['missing: no name was produced at all'];
  const t = String(text).trim();

  if (isHonestFallback(t)) return issues;              // allowed by spec 2.2

  if (t.length < MIN_LENGTH) issues.push(`too short: ${t.length} < ${MIN_LENGTH}`);
  if (t.length > MAX_LENGTH) issues.push(`too long: ${t.length} > ${MAX_LENGTH}`);
  for (const re of GENERIC) {
    if (re.test(t)) { issues.push(`generic or filename-derived: "${t}"`); break; }
  }
  if (lang && !looksLikeLanguage(t, lang)) {
    issues.push(`wrong language: expected ${lang}, got "${t}"`);
  }
  return issues;
}

// Crude on purpose. A real language check belongs in the verifier via the
// built-in Language Detector API; the harness only needs to catch a wholesale
// mismatch, which is the failure that actually happens.
const MARKERS = {
  es: /\b(el|la|los|las|un|una|de|del|con|sobre|en|y|que|para|se|su)\b/i,
  en: /\b(the|a|an|of|with|on|in|and|that|for|is|are|its)\b/i,
};
export function looksLikeLanguage(text, lang) {
  const base = String(lang).slice(0, 2).toLowerCase();
  const want = MARKERS[base];
  if (!want) return true;
  const other = base === 'es' ? MARKERS.en : MARKERS.es;
  if (want.test(text)) return true;
  return !other.test(text);      // no markers either way: too short to judge
}

// Dice coefficient over word bigrams. Order-insensitive enough to tolerate
// rephrasing, strict enough that an unrelated description scores near zero.
export function similarity(a, b) {
  const grams = (s) => {
    const w = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    if (w.length < 2) return new Set(w);
    return new Set(w.slice(0, -1).map((x, i) => `${x} ${w[i + 1]}`));
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const g of A) if (B.has(g)) hits++;
  return (2 * hits) / (A.size + B.size);
}

export const SIMILARITY_THRESHOLD = 0.25;
