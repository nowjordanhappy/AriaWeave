// The router is deterministic code, not an agent (SPEC 3.1). Its only job is to
// decide *whether a model is needed at all*, and if so which ladder to climb.
// Anything decidable by a rule is decided here, before a single byte is fetched.

const RASTER = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;

// Names that have meant "this pixel is furniture" since 1998.
const DECORATIVE_SRC =
  /(^|[\/_-])(spacer|shim|blank|transparent|clear|dot|px|pixel|1x1|tracking|beacon|spacer\.gif)([._-]|$)/i;

// Filenames that announce a banner/poster, where the meaning is baked-in text.
const TEXT_HEAVY_SRC =
  /(banner|cartel|afiche|aviso|horario|comunicado|infografia|infographic|flyer|poster|tarifa|convocatoria)/i;

// An existing name that satisfies axe and tells a screen reader user nothing.
// Written from SPEC 2.1/6 rather than imported from the harness — if the router
// used the harness's own list, the junk-alt fixture would be circular.
const JUNK_NAME = [
  /^\s*$/,
  /^(image|imagen|photo|foto|picture|imagen|figura|figure|graphic|gr[áa]fico|logo|icon|icono|banner|thumbnail|miniatura)\.?$/i,
  /^(untitled|sin t[íi]tulo|unnamed|null|undefined|none|todo)\.?$/i,
  /\.(jpe?g|png|gif|webp|svg|avif|bmp)\b/i,            // a filename is not a description
  /^(img|dsc|image|foto|photo|screenshot|captura)[-_ ]?\d+/i,
  /^\d+\s*[x×]\s*\d+$/i,                               // "220x200"
  /^[\d\s._-]+$/,                                      // digits and separators only
];

export function isJunkName(name) {
  if (name == null) return true;
  const t = String(name).trim();
  if (t.length < 3) return true;
  return JUNK_NAME.some((re) => re.test(t));
}

// Everything the router needs from a candidate, normalised once. Lane A owns the
// exact shape of `context`; the contract (SPEC 4) names the field but not its
// keys, so read defensively and never assume a key exists.
export function readContext(candidate) {
  const c = candidate?.context;
  const ctx = (c && typeof c === 'object') ? c : {};
  const text = typeof c === 'string' ? c : '';
  const pick = (...keys) => {
    for (const k of keys) {
      const v = ctx[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  return {
    lang: pick('lang', 'documentLang', 'pageLang'),
    name: pick('name', 'accessibleName', 'alt', 'ariaLabel', 'aria-label'),
    title: pick('title'),
    figcaption: pick('figcaption', 'caption'),
    labelledBy: pick('labelledBy', 'ariaLabelledBy', 'labelledByText'),
    nearby: pick('nearby', 'nearbyText', 'surroundingText', 'context') || text,
    preceding: pick('preceding', 'precedingText', 'labelText', 'previousText'),
    heading: pick('heading', 'sectionHeading', 'nearestHeading'),
    placeholder: pick('placeholder'),
    attrName: pick('attrName', 'inputName', 'fieldName'),
    inputType: pick('inputType', 'type'),
    href: pick('href', 'url'),
    role: pick('role'),
    svg: pick('svg', 'svgMarkup', 'outerHTML', 'html'),
    dataUrl: pick('dataUrl', 'dataURL', 'imageData'),
    pageText: pick('pageText', 'documentText', 'bodyText'),
    hidden: ctx.ariaHidden === true || ctx.hidden === true || pick('ariaHidden') === 'true',
    presentation: /^(presentation|none)$/i.test(pick('role')),
  };
}

const box = (candidate) => {
  const b = candidate?.bbox || {};
  const w = Number(b.width ?? b.w ?? 0);
  const h = Number(b.height ?? b.h ?? 0);
  return { w: Number.isFinite(w) ? w : 0, h: Number.isFinite(h) ? h : 0,
           x: Number(b.x ?? b.left ?? 0) || 0, y: Number(b.y ?? b.top ?? 0) || 0 };
};

// Decorative only ever applies to images. A 24px icon *button* is not furniture
// — it is a control whose name is the whole point.
function isDecorative(candidate, ctx) {
  if (candidate.kind !== 'img') return false;
  if (ctx.presentation || ctx.hidden) return true;
  const { w, h } = box(candidate);
  if (w && h) {
    if (w <= 2 || h <= 2) return true;            // spacer gifs and hairline rules
    if (w < 32 && h < 32) return true;            // tracking pixels and bullets
  }
  return !!candidate.src && DECORATIVE_SRC.test(candidate.src);
}

// Text-heavy means "the words are pixels, not DOM" — so only rasters qualify.
// An SVG with <text> puts its words back in the DOM, where the content script
// already has them, and OCR on it would be work for an answer we already hold.
//
// ponytail: shape+filename heuristic, not a pixel scan. Misrouting costs one
// wasted OCR pass that the verifier rejects (SPEC 3.2 names that failure mode
// explicitly); upgrade to an ink-density scan only if the corpus shows it.
function isTextHeavy(candidate) {
  const src = candidate.src || '';
  const isRaster = RASTER.test(src) || /^data:image\/(png|jpe?g|webp|gif|bmp)/i.test(src);
  if (!isRaster) return false;
  if (TEXT_HEAVY_SRC.test(src)) return true;
  const { w, h } = box(candidate);
  return w >= 320 && h > 0 && w / h >= 2;          // banner proportions
}

/**
 * @returns {{ action: 'skip'|'silence'|'describe', reason: string, tiers?: string[] }}
 *   skip     — already named well enough; the pipeline must not touch it
 *   silence  — write alt="", never prose
 *   describe — climb `tiers` in order, verifying between each
 */
export function route(candidate) {
  const ctx = readContext(candidate);

  if (!isJunkName(ctx.name)) {
    return { action: 'skip', reason: 'already has a usable accessible name' };
  }
  if (isDecorative(candidate, ctx)) {
    return { action: 'silence', reason: 'decorative: too small, hidden, or a known spacer' };
  }
  if (isTextHeavy(candidate)) {
    // T1 still runs first: a figcaption beats OCR and costs nothing.
    return { action: 'describe', reason: 'text-heavy raster', tiers: ['T1', 'T2', 'T3', 'T4'] };
  }
  return { action: 'describe', reason: 'needs a description', tiers: ['T1', 'T3', 'T4'] };
}
