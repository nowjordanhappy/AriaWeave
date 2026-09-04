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

// A control label is legitimately short — "Buscar", "Guardar", "Cerrar" — while
// an image description that short has said nothing. One floor for both rejected
// the harness's own reference ("Guardar", 7) and rejected a correct product
// answer ("Buscar", 6, read from a nested <title> in the icon's SVG).
const MIN_LENGTH = { img: 8, button: 3, link: 3, input: 3 };
const MAX_LENGTH = 250;

export function isHonestFallback(text) {
  return typeof text === 'string' && HONEST_FALLBACK.test(text);
}

export function qualityIssues(text, { lang, kind = 'img' } = {}) {
  const issues = [];
  if (text == null) return ['missing: no name was produced at all'];
  const t = String(text).trim();

  if (isHonestFallback(t)) return issues;              // allowed by spec 2.2

  const floor = MIN_LENGTH[kind] ?? MIN_LENGTH.img;
  if (t.length < floor) issues.push(`too short for a ${kind}: ${t.length} < ${floor}`);
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

  // Too short to judge. "Ir a Facebook" carries no Spanish stopword from any
  // reasonable list while "a" sits in the English one, so a marker count calls
  // correct Spanish English and rejects it. Control labels are routinely three
  // words, which is exactly where this heuristic stops being evidence.
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;

  const other = base === 'es' ? MARKERS.en : MARKERS.es;
  if (want.test(text)) return true;
  return !other.test(text);      // no markers either way: too short to judge
}

// Dice coefficient over word bigrams. Order-insensitive enough to tolerate
// rephrasing, strict enough that an unrelated description scores near zero.
export function similarity(a, b) {
  const words = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

  const wa = words(a), wb = words(b);
  // The choice belongs to the PAIR, not to each string. Picking per string let
  // one side produce word grams and the other character grams, which never
  // intersect: "Guardar cambios" vs "Guardar" scored 0 while being obviously
  // close.
  const useChars = wa.length < 2 || wb.length < 2;

  const grams = (w) => {
    if (!useChars) return new Set(w.slice(0, -1).map((x, i) => `${x} ${w[i + 1]}`));
    const chars = w.join('');
    if (chars.length < 2) return new Set(chars ? [chars] : []);
    return new Set([...chars].slice(0, -1).map((c, i) => c + chars[i + 1]));
  };

  const A = grams(wa), B = grams(wb);
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const g of A) if (B.has(g)) hits++;
  return (2 * hits) / (A.size + B.size);
}

export const SIMILARITY_THRESHOLD = 0.25;
