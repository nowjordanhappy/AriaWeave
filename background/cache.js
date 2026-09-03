// Repeat visits are instant and cost zero (SPEC 2.1.5).
//
// The one invariant: NEVER CACHE A FAILURE. A getOrPut-shaped helper stores
// whatever the lambda returned, so a single bad lookup becomes permanent for the
// process and every retry button above it turns into decoration. The guard lives
// here, in `put`, so no caller can forget it.

const PREFIX = 'aw:';
const MAX_ENTRIES = 500;

const store = () => globalThis.chrome?.storage?.local;

// Keyed by image hash + element context (SPEC 2.1.5). `bytes` is the decoded
// image when we have it, so the same picture served from two URLs is one entry;
// when we never fetched (T1 answered from the DOM) the source string stands in.
export async function keyFor({ bytes, src = '', kind = '', lang = '', context = '' }) {
  const material = bytes
    ? await digest(bytes)
    : await digest(new TextEncoder().encode(src));
  const shape = await digest(new TextEncoder().encode(`${kind}|${lang}|${context}`.slice(0, 512)));
  return `${PREFIX}${material.slice(0, 16)}:${shape.slice(0, 8)}`;
}

async function digest(buf) {
  const out = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function get(key) {
  const s = store();
  if (!s || !key) return null;
  try {
    const hit = (await s.get(key))[key];
    return hit?.description ? hit : null;
  } catch {
    return null;                       // storage unavailable is a miss, not an error
  }
}

/**
 * Store a result — but only a good one.
 * Rejected: nothing, empty prose, the honest-generic fallback, and anything the
 * verifier let through on low confidence. Those are all states we want to retry
 * on the next visit, which is exactly what not caching them buys.
 */
export async function put(key, result) {
  const s = store();
  if (!s || !key || !result) return;
  if (!result.description || !String(result.description).trim()) return;
  if (result.fallback) return;
  if (!(result.confidence >= CACHEABLE_CONFIDENCE)) return;

  try {
    await s.set({ [key]: { ...result, at: Date.now() } });
    void evict(s);
  } catch { /* a full quota must not break the page */ }
}

export const CACHEABLE_CONFIDENCE = 0.6;

// ponytail: oldest-first trim at a fixed cap. An LRU would need a write on every
// read, which costs more than the eviction it improves.
async function evict(s) {
  try {
    const all = await s.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    await s.remove(keys.slice(0, keys.length - MAX_ENTRIES));
  } catch { /* best effort */ }
}

export async function clear() {
  const s = store();
  if (!s) return;
  const all = await s.get(null);
  await s.remove(Object.keys(all).filter((k) => k.startsWith(PREFIX)));
}
