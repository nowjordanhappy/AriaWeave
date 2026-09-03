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
    img: 'imagen no descrita con confianza',
    button: 'botón sin nombre accesible',
    link: 'enlace sin nombre accesible',
    input: 'campo sin etiqueta',
  },
  en: {
    img: 'image not described with confidence',
    button: 'button without accessible name',
    link: 'link without accessible name',
    input: 'field without label',
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

const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function labelledByText(el) {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  return ids.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
}

// A cheap approximation of the accessible name. It only has to be right about
// "is there one at all", which is the same question axe's *-name rules ask.
function hasAccessibleName(el) {
  if (el.getAttribute('aria-label')?.trim()) return true;
  if (labelledByText(el)) return true;
  if (el.getAttribute('title')?.trim()) return true;
  if (text(el)) return true;
  if (el.querySelector('img[alt]:not([alt=""]), svg > title, [aria-label]')) return true;
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
  if (el.id) return `#${CSS.escape(el.id)}`;
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
    ctx.type = el.type || 'text';
    if (el.name) ctx.name = el.name;
    if (el.placeholder) ctx.placeholder = el.placeholder;
  }

  if (kind === 'link') {
    const href = el.getAttribute('href');
    if (href) ctx.href = href;
  }

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
}

function apply(el, kind, result) {
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
    fallback: !confident,
  });
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
  const bySelector = new Map((await describe(batch)).map((r) => [r.selector, r]));
  write(() => {
    for (const item of batch) {
      apply(item.el, item.kind, bySelector.get(cssPath(item.el)));
      inFlight.delete(item.el);
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
  await processBatch(deferred);
}

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
      li.textContent = `${r.id ? '#' + r.id : r.selector} · ${r.tier}\n`
        + `antes: ${r.before ?? '(sin atributo)'}\n`
        + `después: ${r.after === '' ? '(silenciado)' : r.after}`;
      li.style.whiteSpace = 'pre-line';
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

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'ariaweave:state') {
    respond({ enabled, inspecting, records });
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
