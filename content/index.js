// AriaWeave content script — Lane A: scanner, observer, injector.
//
// Owns the DOM side only. It finds naming gaps, asks the background for
// descriptions over the frozen contract in SPEC.md §4, and writes the real
// attribute onto the element. It never decides *how* a description is made.
//
//   Candidate = { selector, kind, src?, bbox, context }
//   Result    = { selector, description, confidence, tier }

const TIER_ATTR = 'data-ariaweave-tier';
const UI_ATTR = 'data-ariaweave-ui';

// Below this the honest-generic path applies (SPEC §2.2). No number is given in
// the spec; this is the content-side default and the only place it lives.
const CONFIDENCE_MIN = 0.6;

// Long enough to coalesce an SPA render, short enough that fixture 06's 400 ms
// injection is described well inside its 1200 ms settle budget.
const DEBOUNCE_MS = 200;

// Smaller than this in either axis and it is a spacer, a rule or a tracking
// pixel, not content. Inventing prose for one is worse than skipping it.
const DECORATIVE_MAX_PX = 32;

const OBSERVE = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['src'], // never an attribute we write, so we cannot feed ourselves
};

// ---------------------------------------------------------------- language

// The screen reader takes its voice from the DOM, so the DOM decides (SPEC §5).
const pageLang = () =>
  document.documentElement.getAttribute('lang')?.trim() || navigator.language || 'en';

const GENERIC = {
  es: {
    img: 'Imagen no descrita con confianza',
    button: 'Botón sin nombre accesible',
    link: 'Enlace sin nombre accesible',
    input: 'Campo sin etiqueta',
  },
  en: {
    img: 'Image not described with confidence',
    button: 'Button without accessible name',
    link: 'Link without accessible name',
    input: 'Field without label',
  },
};

// Honest generic text, in the page's language. Never a confident guess.
const generic = (kind, lang) =>
  (GENERIC[lang.slice(0, 2).toLowerCase()] || GENERIC.en)[kind];

// ---------------------------------------------------------------- detection

const JUNK_ALT_WORD = /^(imagen|image|img|imagem|foto|photo|picture|pic|graphic|gr[aá]fico|untitled|sin t[ií]tulo|spacer|placeholder|banner|thumbnail)$/i;
const JUNK_ALT_FILENAME = /\.(jpe?g|png|gif|svg|webp|avif|bmp|ico)$/i;
const JUNK_ALT_DIMENSIONS = /^\d+\s*[x×*]\s*\d+$/;
const JUNK_ALT_CAMERA = /^(dsc|img|pxl|image|photo|screen ?shot|captura)[-_ ]?\d+/i;
const DECORATIVE_SRC = /(spacer|pixel|blank|transparent|clear|shim|dot|1x1)[-_.]/i;

function isJunkAlt(alt) {
  const t = alt.trim();
  // ponytail: alt="" is read as an author decision to silence, not as junk.
  // SPEC §2.1 also names "empty-but-meaningful", but deciding that needs the
  // judgement of a tier, not a rule — and guessing it wrong un-silences a pixel.
  if (!t) return false;
  return JUNK_ALT_WORD.test(t)
    || JUNK_ALT_FILENAME.test(t)
    || JUNK_ALT_DIMENSIONS.test(t)
    || JUNK_ALT_CAMERA.test(t);
}

// textContent includes <style> and <script> bodies. On gob.pe that produced a
// label reading ".gobpe_safeguard_code_name_1788488262 {position:absolute
// !important;height:1px;width:1px;overflow:hidden;}" — a stylesheet announced
// to a screen reader as the name of a form field. A confident wrong answer, and
// the exact failure §2.2 exists to prevent.
//
// nearbyText already skipped those tags as siblings, but they can be nested
// anywhere below, and precedingText did not skip them at all. Fixing it here
// fixes every caller at once, which is why it belongs here and not in each.
const NON_TEXT = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|SVG|IFRAME|OBJECT)$/;

const text = (el) => {
  if (!el) return '';
  if (NON_TEXT.test(el.tagName)) return '';
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1 && !NON_TEXT.test(child.tagName)
               && child.getAttribute('aria-hidden') !== 'true') walk(child);
    }
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
};

function labelledByText(el) {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  return ids.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
}

// A cheap approximation of the accessible name. It only has to be right about
// "is there one at all", which is the same question axe's *-name rules ask.
// Content inside an aria-hidden subtree is NOT an accessible name: assistive
// tech never sees it. An icon-only button whose <svg aria-hidden="true"> holds
// a <title> reads as named here while a screen reader announces nothing — and
// axe correctly flags it, so the scanner disagreeing with axe means the element
// is silently never offered a name. The same blind spot existed in the harness.
function visibleClone(el) {
  const c = el.cloneNode(true);
  for (const h of c.querySelectorAll('[aria-hidden="true"]')) h.remove();
  return c;
}

function hasAccessibleName(el) {
  if (el.getAttribute('aria-label')?.trim()) return true;
  if (labelledByText(el)) return true;
  if (el.getAttribute('title')?.trim()) return true;
  const visible = visibleClone(el);
  if (text(visible)) return true;
  if (visible.querySelector('img[alt]:not([alt=""]), svg > title, [aria-label]')) return true;
  return false;
}

function inputHasLabel(el) {
  if (el.labels && [...el.labels].some((l) => text(l))) return true;
  if (el.getAttribute('aria-label')?.trim()) return true;
  if (labelledByText(el)) return true;
  if (el.getAttribute('title')?.trim()) return true;
  return false;
}

function boxOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function isDecorative(img, bbox) {
  if (DECORATIVE_SRC.test(img.currentSrc || img.getAttribute('src') || '')) return true;
  const w = bbox.width || img.width || img.naturalWidth;
  const h = bbox.height || img.height || img.naturalHeight;
  // An unmeasurable image is not evidence of decoration — it is an image that
  // has not loaded. Silencing it would be the failure this rule exists to avoid.
  if (!w || !h) return false;
  return Math.min(w, h) < DECORATIVE_MAX_PX;
}

// Already fine: axe is satisfied and so is a screen reader.
function imgAlreadyNamed(img) {
  const role = img.getAttribute('role');
  if (role === 'presentation' || role === 'none') return true;
  if (img.getAttribute('aria-hidden') === 'true') return true;
  if (img.getAttribute('aria-label')?.trim() || labelledByText(img)) return true;
  const alt = img.getAttribute('alt');
  return alt !== null && !isJunkAlt(alt);
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

// ---------------------------------------------------------------- selectors

// Identifies the element for the background. We keep the element itself, so
// this only has to be unique and valid — but it is a real selector, because a
// selector nobody can run is a debugging trap.
function cssPath(el) {
  // An id is only a shortcut while it is unique. Duplicate ids are invalid HTML
  // and completely ordinary on the real web — gob.pe ships three fields sharing
  // id="feedback_gobpe_safeguard_code_name". With a bare #id selector,
  // querySelector() returns the first match for every one of them, so a
  // description computed from one element's context lands on another and the
  // rest are never labelled. That is a confident wrong label, which SPEC §2.2
  // ranks below no label at all.
  if (el.id) {
    const escaped = `#${CSS.escape(el.id)}`;
    if (el.getRootNode().querySelectorAll(escaped).length === 1) return escaped;
  }
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === n.tagName) i++;
    }
    parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
  }
  return ['html', ...parts].join(' > ');
}

// ---------------------------------------------------------------- context

// Whatever nearby text is cheap to gather. This is what lets T1 answer without
// a model, so it is worth gathering well.
function nearestHeading(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
      if (/^H[1-6]$/.test(s.tagName)) return text(s);
    }
  }
  const h = document.querySelector('h1');
  return h ? text(h) : '';
}

function nearbyText(el) {
  return [el.previousElementSibling, el.nextElementSibling]
    .filter((s) => s && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(s.tagName))
    .map(text)
    .filter(Boolean)
    .join(' — ')
    .slice(0, 300);
}

// Text sitting immediately before a field, which is what an author writes when
// they skip the <label> element: a <p>, a <span>, a bare text node.
function precedingText(el) {
  // Walk up as well as back. gob.pe wraps each date field in three divs and puts
  // the real <label> — "Filtrar por fecha de publicación" — as a sibling of the
  // outermost one, so a direct-sibling scan finds nothing and the field falls
  // back to its own name attribute. That produced "Filter[start date]": English
  // bracket syntax on a Spanish page, while the words a human wrote sat two
  // levels up.
  for (let node = el, up = 0; node && up < 6; node = node.parentElement, up++) {
    let n = node.previousElementSibling;
    for (let back = 0; n && back < 2; back++, n = n.previousElementSibling) {
      if (/^(input|select|textarea|button|form)$/i.test(n.tagName)) break;
      const t = text(n);
      if (t && t.length <= 120) return t;
    }
  }
  return '';
}

function contextFor(el, kind) {
  const ctx = { lang: pageLang(), tag: el.tagName.toLowerCase() };
  const title = el.getAttribute('title')?.trim();
  if (title) ctx.title = title;

  if (kind === 'img') {
    const alt = el.getAttribute('alt');
    if (alt?.trim()) ctx.junkAlt = alt.trim();
    const src = (el.currentSrc || el.getAttribute('src') || '').split(/[?#]/)[0];
    const file = src.split('/').pop();
    if (file) ctx.filename = decodeURIComponent(file);
    const caption = el.closest('figure')?.querySelector('figcaption');
    if (caption) ctx.caption = text(caption);
  }

  if (kind === 'input') {
    // SPEC §4.1: `inputName`, never `name`. The old key collided with the
    // router's reading of `name` as the *accessible* name, so every named input
    // looked already-labelled and was skipped before T1 ran.
    ctx.inputType = el.type || 'text';
    if (el.name) ctx.inputName = el.name;
    if (el.placeholder) ctx.placeholder = el.placeholder;
    const before = precedingText(el);
    if (before) ctx.preceding = before;
  }

  if (kind === 'link') {
    const href = el.getAttribute('href');
    if (href) ctx.href = href;
  }

  // The author's own words, and often the only ones. elcomercio.pe ships
  // `v-short__close-btn` and `v-short__nav--left` on buttons whose icons are CSS
  // backgrounds — no SVG, no text, nothing else to read. A class name is a weak
  // signal and must stay behind every authored-text rule, but it beats the
  // generic, which says nothing at all.
  const cls = (el.getAttribute('class') || '').trim();
  if (cls) ctx.className = cls.slice(0, 200);

  if (kind === 'button' || kind === 'link') {
    // Markup, not pixels: class tokens, <use href="#icon-close"> and a nested
    // <title> are text the author wrote. Capped so a sprite sheet cannot ride
    // along into the message.
    const svg = el.querySelector('svg');
    if (svg) ctx.svg = svg.outerHTML.slice(0, 2048);
  }

  const labelledBy = [el.getAttribute('aria-labelledby'), el.getAttribute('aria-describedby')]
    .filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id)).filter(Boolean)
    .map((n) => text(n)).filter(Boolean).join(' ');
  if (labelledBy) ctx.labelledBy = labelledBy;

  // The background sorts by viewport and had no signal, so it guessed with
  // `bbox.y < 900` — roughly right on first paint and wrong after any scroll.
  // The content script already knows; it just never said.
  ctx.inViewport = inViewport(boxOf(el));

  const role = el.getAttribute('role');
  if (role) ctx.role = role;
  if (el.getAttribute('aria-hidden') === 'true') ctx.ariaHidden = true;

  const heading = nearestHeading(el);
  if (heading) ctx.heading = heading;
  const nearby = nearbyText(el);
  if (nearby) ctx.nearby = nearby;
  return ctx;
}

// ---------------------------------------------------------------- scanner

const inFlight = new WeakSet();

function kindOf(el) {
  switch (el.tagName) {
    case 'IMG': return 'img';
    case 'BUTTON': return 'button';
    case 'A': return 'link';
    case 'INPUT': return 'input';
    default: return null;
  }
}

function scan() {
  const candidates = [];
  const decorative = [];

  for (const el of document.querySelectorAll('img, button, a[href], input')) {
    if (el.hasAttribute(TIER_ATTR) || inFlight.has(el)) continue;
    if (el.closest(`[${UI_ATTR}]`)) continue;

    const kind = kindOf(el);
    if (!kind) continue;

    if (kind === 'img') {
      if (imgAlreadyNamed(el)) continue;
      const bbox = boxOf(el);
      if (isDecorative(el, bbox)) { decorative.push(el); continue; }
      candidates.push({ el, kind, bbox });
      continue;
    }

    if (kind === 'input') {
      if (SKIP_INPUT_TYPES.has(el.type)) continue;
      if (inputHasLabel(el)) continue;
    } else if (hasAccessibleName(el)) {
      continue;
    }
    candidates.push({ el, kind, bbox: boxOf(el) });
  }

  return { candidates, decorative };
}

// ---------------------------------------------------------------- injector

const records = [];
let observer = null;

// Every write goes through here. The observer is detached across the write and
// disconnect() empties its record queue, so our own mutations can never come
// back as work. This is the whole of the idempotency story.
function write(fn) {
  observer?.disconnect();
  try { fn(); } finally {
    if (observer && enabled) observer.observe(document.documentElement, OBSERVE);
  }
}

// ponytail: T0 is not one of SPEC §3.2's tiers. Decorative silencing happens
// here because geometry only exists in the page, and because an unanswered
// candidate must never become prose on a tracking pixel. Named distinctly so
// inspection mode does not credit it to a tier that never ran.
function silence(el) {
  el.setAttribute('alt', '');
  el.setAttribute(TIER_ATTR, 'T0');
  records.push({
    selector: cssPath(el), id: el.id || null, kind: 'img',
    before: el.getAttribute('alt'), after: '', tier: 'T0', decorative: true,
  });
  refreshInspector();
}

function apply(el, kind, result, ms = null) {
  const lang = pageLang();
  const described = typeof result?.description === 'string' && result.description.trim();
  const confident = described && (result.confidence ?? 0) >= CONFIDENCE_MIN;
  const value = confident ? result.description.trim() : generic(kind, lang);

  const before = kind === 'img' ? el.getAttribute('alt') : (el.getAttribute('aria-label') ?? null);
  if (kind === 'img') el.setAttribute('alt', value);
  else el.setAttribute('aria-label', value);
  el.setAttribute(TIER_ATTR, result?.tier || 'none');

  records.push({
    selector: cssPath(el), id: el.id || null, kind,
    before, after: value,
    tier: result?.tier || 'none',
    confidence: result?.confidence ?? null,
    ms,
    fallback: !confident,
  });
  refreshInspector();
}

// ---------------------------------------------------------------- pipeline

// The envelope around the frozen shapes is a seam, not a contract field: the
// background may answer with an array of Results or with { results }.
async function describe(batch) {
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'ariaweave:describe',
      candidates: batch.map(({ el, kind, bbox }) => ({
        selector: cssPath(el),
        kind,
        ...(kind === 'img' ? { src: el.currentSrc || el.getAttribute('src') || '' } : {}),
        bbox,
        context: contextFor(el, kind),
      })),
    });
    const results = Array.isArray(reply) ? reply : reply?.results;
    return Array.isArray(results) ? results : [];
  } catch {
    // No background, or it threw. Not an error path we can fix from here — the
    // honest-generic branch in apply() covers it, and a labelled element with
    // modest text beats an unlabelled one.
    return [];
  }
}

async function processBatch(batch) {
  if (!batch.length) return;
  batch.forEach(({ el }) => inFlight.add(el));
  // Round-trip for this batch. Measured here rather than in the background
  // because this is the number a user actually waits through: request out,
  // attribute on screen. Shown in inspection mode, so latency is something you
  // can see on a real page instead of inferring from a benchmark.
  const t0 = performance.now();
  const bySelector = new Map((await describe(batch)).map((r) => [r.selector, r]));
  const ms = Math.round(performance.now() - t0);
  write(() => {
    for (const item of batch) {
      apply(item.el, item.kind, bySelector.get(cssPath(item.el)), ms);
      inFlight.delete(item.el);
      claim(item.el);
    }
  });
}

const inViewport = (b) =>
  b.height > 0 && b.width > 0
  && b.y < innerHeight && b.y + b.height > 0
  && b.x < innerWidth && b.x + b.width > 0;

async function run() {
  const { candidates, decorative } = scan();
  if (decorative.length) write(() => decorative.forEach(silence));
  if (!candidates.length) return;

  // Viewport first. T3 costs ~2 s an image (SPEC §3.3.2), so a page drained in
  // DOM order makes the reader wait on pictures they cannot see yet.
  const visible = candidates.filter((c) => inViewport(c.bbox));
  const deferred = candidates.filter((c) => !inViewport(c.bbox));
  await processBatch(visible);

  // Off-screen work is paced, never abandoned.
  //
  // Draining `deferred` in one go described every candidate at once: a news
  // front page with 200 unlabelled images is 200 inferences at ~2 s with two in
  // flight, which is three minutes of continuous on-device model, a spinning
  // fan and a flat battery.
  //
  // The obvious fix — only describe what scrolls into view — is wrong here, and
  // wrong in a way worth writing down. A screen reader user does not scroll.
  // They move by keyboard and virtual cursor and reach the whole document in
  // DOM order, so an element that never enters the visual viewport is still
  // read aloud. Gating on visibility would leave exactly that reader with
  // unnamed controls, which is the opposite of the point.
  //
  // So: viewport and focus raise priority, idle time does the rest, and
  // everything is eventually named.
  observeApproach(deferred);
  drainWhenIdle(deferred);
}

// 300px of runway, so something is usually named before it reaches the eye.
const APPROACH_MARGIN = '300px';
const IDLE_CHUNK = 3;

let approach = null;
const pending = new Map();

function claim(el) {
  const item = pending.get(el);
  if (item) { pending.delete(el); approach?.unobserve(el); }
  return item;
}

function observeApproach(items) {
  if (!items.length) return;
  if (!approach) {
    approach = new IntersectionObserver((entries) => {
      const arrived = entries.filter((e) => e.isIntersecting)
        .map((e) => claim(e.target)).filter(Boolean);
      if (arrived.length) processBatch(arrived);
    }, { rootMargin: APPROACH_MARGIN });
  }
  for (const item of items) {
    if (pending.has(item.el)) continue;
    pending.set(item.el, item);
    approach.observe(item.el);
  }
}

// A screen reader user's cursor shows up here: moving to a control focuses it
// long before it would scroll into anyone's view.
addEventListener('focusin', (e) => {
  const item = e.target && claim(e.target);
  if (item) processBatch([item]);
}, true);

let idling = false;
function drainWhenIdle() {
  if (idling) return;
  idling = true;
  const step = () => {
    const batch = [];
    for (const el of pending.keys()) {
      if (batch.length >= IDLE_CHUNK) break;
      batch.push(claim(el));
    }
    if (!batch.length) { idling = false; return; }
    processBatch(batch).finally(() => schedule(step));
  };
  schedule(step);
}

// requestIdleCallback where it exists: the browser tells us when the page is
// not busy, which is the whole point of pacing this work.
const schedule = (fn) => (globalThis.requestIdleCallback
  ? requestIdleCallback(fn, { timeout: 2000 })
  : setTimeout(fn, 250));



let running = false;
let rerun = false;

async function tick() {
  if (running) { rerun = true; return; }
  running = true;
  try { await run(); } finally {
    running = false;
    if (rerun) { rerun = false; tick(); }
  }
}

// ---------------------------------------------------------------- observer

let debounce = null;

function startObserver() {
  observer = new MutationObserver((mutations) => {
    // Our own writes never arrive here (write() detaches), but the inspection
    // overlay is still ours and must not be treated as page content.
    if (mutations.every((m) => m.target.nodeType === 1 && m.target.closest?.(`[${UI_ATTR}]`))) return;
    clearTimeout(debounce);
    debounce = setTimeout(tick, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, OBSERVE);
}

function stopObserver() {
  clearTimeout(debounce);
  observer?.disconnect();
  observer = null;
}

// ---------------------------------------------------------------- inspection

const INSPECTOR_ID = 'ariaweave-inspector';

// The overlay is rendered once when inspection mode turns on, so it showed
// "0 elementos" on gob.pe while the popup — which reads live state — showed 3.
// Two views of the same data disagreeing is worse than one view: it makes the
// reader distrust both. Re-render whenever a record lands.
let inspectorPending = false;
function refreshInspector() {
  if (!inspecting || !enabled || inspectorPending) return;
  inspectorPending = true;
  requestAnimationFrame(() => { inspectorPending = false; renderInspector(true); });
}

function renderInspector(on) {
  const existing = document.getElementById(INSPECTOR_ID);
  write(() => {
    existing?.remove();
    if (!on) return;
    const panel = document.createElement('div');
    panel.id = INSPECTOR_ID;
    panel.setAttribute(UI_ATTR, '');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'AriaWeave: elementos corregidos');
    panel.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;'
      + 'max-height:50vh;width:340px;overflow:auto;background:#fff;color:#111;'
      + 'border:2px solid #111;border-radius:8px;padding:12px;'
      + 'font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';

    const h = document.createElement('h2');
    h.textContent = `AriaWeave — ${records.length} elementos`;
    h.style.cssText = 'margin:0 0 8px;font-size:14px';
    panel.append(h);

    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:0;padding:0;list-style:none';
    for (const r of records) {
      const li = document.createElement('li');
      li.style.cssText = 'margin:0 0 8px;padding-bottom:8px;border-bottom:1px solid #ddd';

      // The identifier is a control here too. The overlay lives in the page, so
      // it calls reveal() straight rather than going through the popup's
      // message round-trip — same behaviour, none of the plumbing.
      const what = document.createElement('button');
      what.type = 'button';
      what.textContent = `${r.id ? '#' + r.id : r.selector} · ${r.tier}`
        + (r.ms == null ? '' : ` · ${r.ms} ms`);
      what.title = 'Mostrar este elemento en la página';
      what.style.cssText = 'display:block;width:100%;text-align:left;margin:0 0 4px;'
        + 'padding:0;border:0;background:none;color:inherit;font:inherit;font-weight:600;'
        + 'cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px';
      what.addEventListener('click', () => {
        if (!reveal(r.selector)) what.textContent += ' — ya no está';
      });

      const body = document.createElement('span');
      body.style.whiteSpace = 'pre-line';
      body.textContent = `antes: ${r.before ?? '(sin atributo)'}\n`
        + `después: ${r.after === '' ? '(silenciado)' : r.after}`;

      li.append(what, body);
      ul.append(li);
    }
    panel.append(ul);
    document.documentElement.append(panel);
  });
}

// ---------------------------------------------------------------- lifecycle

let enabled = true;
let inspecting = false;

function stop() {
  stopObserver();
  renderInspector(false);
}

// Show me which one you mean.
//
// A selector like `div:nth-of-type(2) > div:nth-of-type(3) > a:nth-of-type(1)`
// is an address by position, and nobody reads it. Rather than make it prettier,
// let the page answer: scroll the element into view and flash a ring around it.
// The ring is drawn with an outline on a data-ariaweave-ui element so the
// observer ignores it and it cannot re-enter the scan.
function reveal(selector) {
  let el;
  try { el = document.querySelector(selector); } catch { return false; }
  if (!el) return false;

  el.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const r = el.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.setAttribute('data-ariaweave-ui', '');
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, {
    position: 'fixed',
    left: `${r.left - 4}px`, top: `${r.top - 4}px`,
    width: `${r.width + 8}px`, height: `${r.height + 8}px`,
    border: '3px solid #b0452f', borderRadius: '4px',
    boxShadow: '0 0 0 3px rgba(255,255,255,.9)',
    pointerEvents: 'none', zIndex: '2147483647',
    transition: 'opacity .3s ease', opacity: '1',
  });
  document.body.appendChild(ring);
  setTimeout(() => { ring.style.opacity = '0'; }, 1400);
  setTimeout(() => ring.remove(), 1800);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'ariaweave:state') {
    respond({ enabled, inspecting, records });
  }
  if (msg?.type === 'ariaweave:reveal') {
    respond({ found: reveal(msg.selector) });
  }
});

chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) {
    enabled = changes.enabled.newValue !== false;
    if (enabled) { startObserver(); tick(); } else { stop(); }
  }
  if (changes.inspecting) {
    inspecting = changes.inspecting.newValue === true;
    if (enabled) renderInspector(inspecting);
  }
});

(async function start() {
  const stored = await chrome.storage.local.get(['enabled', 'inspecting']).catch(() => ({}));
  enabled = stored.enabled !== false;
  inspecting = stored.inspecting === true;
  if (!enabled) return;
  startObserver();
  await tick();
  if (inspecting) renderInspector(true);
})();
