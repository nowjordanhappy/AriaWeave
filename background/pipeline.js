// The tier ladder (SPEC 3.2). Each rung is a plain async function returning
// either a candidate description or null. Escalation, verification and retry
// feedback live in service-worker.js; a tier itself never decides to escalate.
//
// T1 free rules · T2 free OCR · T3 free on-device · T4 paid cloud.
// Most elements never reach a model at all, and that is the point.

import { readContext, isJunkName } from './router.js';

export const MAX_LENGTH = 240;

// Emitted deliberately when nothing cleared the bar. A wrong description is
// worse than none (SPEC 2.2), so this string is the floor, not an error.
const HONEST = {
  es: 'Imagen no descrita con confianza',
  en: 'Image not described with confidence',
};
export const honestFallback = (lang) => HONEST[base(lang)] || HONEST.en;

const base = (lang) => String(lang || 'en').slice(0, 2).toLowerCase();

// ---------------------------------------------------------------------------
// language — the DOM decides, because the screen reader takes its voice from it
// ---------------------------------------------------------------------------

// ponytail: stopword counting, not the Language Detector API. The detector is
// async, per-call, and only reached on the minority of pages that ship no lang
// at all; swap it in if a third language ever enters the tested scope.
const MARKERS = {
  es: /\b(el|la|los|las|un|una|de|del|con|sobre|en|y|que|para|se|su|por|no|más)\b/gi,
  en: /\b(the|a|an|of|with|on|in|and|that|for|is|are|its|to|from|by)\b/gi,
};

export function detectLang(text) {
  if (!text || text.length < 12) return '';
  const count = (re) => (String(text).match(re) || []).length;
  const es = count(MARKERS.es), en = count(MARKERS.en);
  if (es === en) return '';
  return es > en ? 'es' : 'en';
}

/**
 * Declared > detected > browser locale.
 *
 * Declared wins even when it is visibly wrong, per SPEC 5: a screen reader reads
 * the DOM's `lang`, so a Spanish string under `lang="en"` produces an English
 * voice pronouncing Spanish — worse than no label. The wrong-`lang` rule is
 * deliberately still open (SPEC 8); when it closes, it closes here.
 */
export function pickLang(candidate) {
  const ctx = readContext(candidate);
  const declared = ctx.lang || candidate.lang || '';
  if (declared) return base(declared);
  const detected = detectLang(`${ctx.pageText} ${ctx.heading} ${ctx.nearby}`.trim());
  return detected || base(globalThis.navigator?.language);
}

// ---------------------------------------------------------------------------
// T1 — heuristic rules. Free, instant, and never wrong: it stays silent instead.
// ---------------------------------------------------------------------------

const CONTROL_VERB = {
  es: { pdf: (n) => `Descargar el ${n} en PDF`, download: 'Descargar el archivo' },
  en: { pdf: (n) => `Download the ${n} as a PDF`, download: 'Download the file' },
};

const INPUT_BY_TYPE = {
  es: { email: 'Correo electrónico', tel: 'Número de teléfono', search: 'Buscar en el sitio',
        password: 'Contraseña', url: 'Dirección web' },
  en: { email: 'Email address', tel: 'Phone number', search: 'Search the site',
        password: 'Password', url: 'Web address' },
};

const clean = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);

const usable = (s) => {
  const t = clean(s || '');
  return t.length >= 8 && !isJunkName(t) ? t : null;
};

export async function T1(candidate, lang) {
  const ctx = readContext(candidate);
  const l = base(lang);

  // Text already written for a human, reused rather than invented. Ordered by
  // how deliberately an author wrote it for this element.
  for (const source of [ctx.figcaption, ctx.labelledBy, ctx.title]) {
    const t = usable(source);
    if (t) return { description: t, confidence: 0.9, tier: 'T1' };
  }

  if (candidate.kind === 'input') {
    const t = usable(ctx.preceding) || usable(ctx.placeholder);
    if (t) return { description: t, confidence: 0.85, tier: 'T1' };
    const byType = INPUT_BY_TYPE[l]?.[ctx.inputType];
    if (byType) return { description: byType, confidence: 0.7, tier: 'T1' };
    const humanised = usable(humanise(ctx.attrName));
    if (humanised) return { description: humanised, confidence: 0.6, tier: 'T1' };
  }

  if (candidate.kind === 'link') {
    // Filename reuse (SPEC 3.2): a link with no name whose href names the file
    // is the commonest unlabelled control on a government site.
    const href = ctx.href || candidate.src || '';
    const pdf = /\/([^/?#]+)\.pdf(\?|#|$)/i.exec(href);
    if (pdf) {
      const stem = humanise(decodeURIComponent(pdf[1]));
      const t = usable(CONTROL_VERB[l]?.pdf?.(stem.toLowerCase()));
      if (t) return { description: t, confidence: 0.8, tier: 'T1' };
    }
    const t = usable(ctx.nearby);
    if (t) return { description: t, confidence: 0.55, tier: 'T1' };
  }

  // Deliberately no rule for icon buttons: an SVG path is not text, and guessing
  // "Guardar" from a floppy outline is the confident-wrong answer SPEC 2.2 bans.
  // They fall through to a model, which is what models are for.
  return null;
}

const humanise = (s) =>
  String(s || '').replace(/[-_+.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// T2 — Tesseract.js OCR. Half the zero-config promise (SPEC 7.1): with T3
// needing an opt-in, OCR is what makes the free path produce anything but rules.
// ---------------------------------------------------------------------------

let ocrEngine;   // resolved once; `null` means "checked, absent"

async function loadOcr() {
  if (ocrEngine !== undefined) return ocrEngine;
  try {
    // Vendored, not bundled from a CDN: MV3 forbids remote code.
    const mod = await import('./vendor/tesseract.js');
    ocrEngine = mod.createWorker ? mod : null;
  } catch {
    ocrEngine = null;
  }
  return ocrEngine;
}

let ocrWorker;
export async function T2(candidate, lang, image) {
  const engine = await loadOcr();
  if (!engine || !image) return null;

  try {
    ocrWorker ||= await engine.createWorker(base(lang) === 'es' ? 'spa' : 'eng');
    const { data } = await ocrWorker.recognize(image.blob);
    const text = clean(data?.text || '');
    if (text.length < 8) return null;                 // nothing legible: fall through
    // OCR confidence is 0..100 and notoriously generous; halve the headroom so a
    // smug garbage read still lands under the verifier's bar.
    const confidence = Math.min(0.95, (data.confidence ?? 0) / 100);
    return { description: text, confidence, tier: 'T2' };
  } catch {
    return null;
  }
}

export const ocrAvailable = () => loadOcr().then(Boolean);

// ---------------------------------------------------------------------------
// T3 — Gemini Nano, on-device. ABSENCE IS A NORMAL BRANCH, NOT AN ERROR.
// Chrome will not fetch the model without a one-time user gesture (SPEC 3.3.2),
// so a machine that has never opted in simply has no T3 and the ladder goes on.
// ---------------------------------------------------------------------------

const nanoApi = () =>
  globalThis.LanguageModel
  ?? globalThis.chrome?.aiOriginTrial?.languageModel
  ?? globalThis.ai?.languageModel
  ?? null;

let nanoState;   // 'ready' | 'absent'
let nanoSession;

export async function nanoAvailability() {
  const api = nanoApi();
  if (!api) return 'absent';
  try {
    const a = await api.availability({ expectedInputs: [{ type: 'image' }] });
    return a === 'available' ? 'ready' : a;   // 'downloadable' needs the gesture
  } catch {
    return 'absent';
  }
}

async function nano() {
  if (nanoState === 'absent') return null;
  if (nanoSession) return nanoSession;
  const api = nanoApi();
  if (!api) { nanoState = 'absent'; return null; }
  try {
    // No monitor and no download here on purpose: create() throws
    // NotAllowedError without a user gesture, and a service worker has none.
    // The opt-in button is the popup's job.
    if (await api.availability({ expectedInputs: [{ type: 'image' }] }) !== 'available') {
      nanoState = 'absent';
      return null;
    }
    nanoSession = await api.create({ expectedInputs: [{ type: 'image' }] });
    nanoState = 'ready';
    return nanoSession;
  } catch {
    nanoState = 'absent';                      // normal path, not an error
    return null;
  }
}

export async function T3(candidate, lang, image, feedback) {
  const session = await nano();
  if (!session || !image) return null;
  try {
    const answer = await session.prompt([{
      role: 'user',
      content: [
        { type: 'text', value: visionPrompt(candidate, lang, feedback) },
        { type: 'image', value: image.blob },
      ],
    }]);
    const text = clean(stripPreamble(answer));
    if (!text) return null;
    return { description: text, confidence: 0.7, tier: 'T3' };
  } catch {
    nanoSession = null;                        // a dead session is not a dead tier
    return null;
  }
}

// ---------------------------------------------------------------------------
// T4 — Claude Sonnet. The only paid tier, and the thing the ladder exists to
// avoid. One cloud model, never two (SPEC 3.3): a second means two prompt
// formats, two parsers and two failure modes for no demo value.
// ---------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

let cloudConfig;   // null once checked and absent

async function config() {
  if (cloudConfig !== undefined) return cloudConfig;
  try {
    const mod = await import('../config.local.js');   // gitignored, hackathon-only
    cloudConfig = mod.default?.apiKey ? mod.default : (mod.apiKey ? mod : null);
  } catch {
    cloudConfig = null;
  }
  return cloudConfig;
}

export const cloudAvailable = () => config().then(Boolean);

export async function T4(candidate, lang, image, feedback) {
  const cfg = await config();
  if (!cfg || !image) return null;

  const content = [
    { type: 'text', text: visionPrompt(candidate, lang, feedback) },
    { type: 'image', source: { type: 'base64', media_type: image.type, data: image.base64 } },
  ];

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.model || MODEL,
        max_tokens: 300,
        system: 'You write alt text. Reply with JSON only: '
              + '{"description": string, "confidence": number between 0 and 1}. '
              + 'No prose outside the JSON.',
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const raw = body?.content?.find((c) => c.type === 'text')?.text ?? '';
    const parsed = parseJson(raw);
    const description = clean(parsed?.description || stripPreamble(raw));
    if (!description) return null;
    const confidence = Number(parsed?.confidence);
    return {
      description,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.8,
      tier: 'T4',
    };
  } catch {
    return null;
  }
}

function parseJson(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------------------------------------------------------------------------
// shared: the prompt, and the image both vision tiers need
// ---------------------------------------------------------------------------

const KIND_ASK = {
  es: {
    img: 'Describe el contenido de esta imagen en una sola frase, en español, para una persona que usa lector de pantalla.',
    button: 'Este icono es un botón. Da su etiqueta en español: una o tres palabras que digan qué hace al pulsarlo, no cómo se ve.',
    link: 'Este icono es un enlace. Da su etiqueta en español: unas pocas palabras que digan a dónde lleva.',
    input: 'Da la etiqueta en español de este campo de formulario: qué debe escribir la persona.',
  },
  en: {
    img: 'Describe the content of this image in one sentence, in English, for someone using a screen reader.',
    button: 'This icon is a button. Give its English label: one to three words saying what pressing it does, not what it looks like.',
    link: 'This icon is a link. Give its English label: a few words saying where it goes.',
    input: 'Give the English label for this form field: what the person should type.',
  },
};

export function visionPrompt(candidate, lang, feedback) {
  const l = base(lang) === 'es' ? 'es' : 'en';
  const ctx = readContext(candidate);
  const parts = [KIND_ASK[l][candidate.kind] || KIND_ASK[l].img];

  const around = [ctx.heading, ctx.nearby, ctx.preceding].filter(Boolean).join(' · ').slice(0, 400);
  if (around) {
    parts.push(l === 'es'
      ? `Contexto de la página: "${around}". Úsalo solo si concuerda con lo que ves.`
      : `Page context: "${around}". Use it only where it agrees with what you see.`);
  }

  parts.push(l === 'es'
    ? 'No empieces con "una imagen de" ni "la foto muestra". Máximo 25 palabras. Si no distingues el contenido, responde exactamente: NO_LO_SE'
    : 'Do not start with "an image of" or "the photo shows". 25 words maximum. If you cannot make out the content, reply exactly: NO_LO_SE');

  // The autonomous loop (SPEC 3.4, DoD 3): the rejection reason is carried into
  // the retry, so the next attempt knows what was wrong with the last one.
  if (feedback) {
    parts.push(l === 'es'
      ? `Un intento anterior fue rechazado por: ${feedback}. Corrige eso.`
      : `A previous attempt was rejected because: ${feedback}. Fix that.`);
  }
  return parts.join('\n');
}

function stripPreamble(text) {
  let t = String(text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (/^NO_LO_SE\b/i.test(t)) return '';
  t = t.replace(/^(una?\s+)?(imagen|foto|fotograf[íi]a|ilustraci[óo]n)\s+(de|que muestra|mostrando)\s+/i, '');
  t = t.replace(/^(an?\s+)?(image|photo|photograph|picture|illustration)\s+(of|showing|that shows)\s+/i, '');
  t = t.replace(/^(the\s+)?(image|photo)\s+shows\s+/i, '');
  return t.replace(/^./, (c) => c.toUpperCase());
}

const MAX_EDGE = 1024;   // SPEC 3.2: resize before the paid tier sees it

/** Fetch and normalise once; both vision tiers and the cache key share it. */
export async function loadImage(candidate) {
  const src = readContext(candidate).dataUrl || candidate.src;
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    let blob = await res.blob();
    if (!/^image\//.test(blob.type)) return null;

    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch { return null; }

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    // Rasterise SVGs too: a vision model cannot read markup, and the canvas
    // round-trip is what turns any source format into one the tiers accept.
    if (scale < 1 || blob.type === 'image/svg+xml') {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);          // flatten transparency; models read alpha as black
      g.drawImage(bitmap, 0, 0, w, h);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    bitmap.close?.();

    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { blob, bytes, type: blob.type, base64: toBase64(bytes) };
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
