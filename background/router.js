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
  const str = (k) => (typeof ctx[k] === 'string' && ctx[k].trim()) ? ctx[k].trim() : '';

  // SPEC §4.1 lists these keys. The synonym lists that used to live here read
  // `name` as the accessible name while lane A sent it as the input's `name`
  // attribute, so every named input was skipped before T1 ran. A defensive
  // reader is how that drift stayed invisible for a whole build — an unknown
  // key is now a contract violation to report, not a shape to guess at.
  return {
    lang: str('lang'),
    tag: str('tag'),
    heading: str('heading'),
    nearby: str('nearby') || (typeof c === 'string' ? c.trim() : ''),
    preceding: str('preceding'),
    labelledBy: str('labelledBy'),
    title: str('title'),
    role: str('role'),
    junkAlt: str('junkAlt'),
    filename: str('filename'),
    figcaption: str('caption'),
    href: str('href'),
    inputType: str('inputType'),
    attrName: str('inputName'),
    placeholder: str('placeholder'),
    svg: str('svg'),
    dataUrl: str('dataUrl'),
    pageText: str('pageText'),
    hidden: ctx.ariaHidden === true,
    presentation: /^(presentation|none)$/i.test(str('role')),
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

  // Only an image can arrive already named-but-badly: lane A sends it with the
  // useless alt in `junkAlt`. Controls arrive precisely because the scanner
  // found no accessible name, so re-deciding that here is second-guessing the
  // one side that can actually see the DOM — and reading the wrong key while
  // doing it is what skipped every named input before T1 ran (SPEC §4.1).
  if (candidate.kind === 'img' && ctx.junkAlt && !isJunkName(ctx.junkAlt)) {
    return { action: 'skip', reason: 'existing alt is already usable' };
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
