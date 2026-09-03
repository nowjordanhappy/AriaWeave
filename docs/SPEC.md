# AriaWeave — Specification

**Status:** spec-ready · **Target:** Howdy Dev Day 2026 · **Deadline:** 2026-09-14

---

## 1. Objective

A zero-configuration Chrome extension (MV3) that detects accessibility-naming
gaps on any webpage and autonomously fixes them by injecting correct `alt` and
`aria-label` attributes into the live DOM, using a tiered inference pipeline
with automated verification.

The user is the **visitor**, not the site owner. Every comparable tool
(AltText.ai, AutoAlt, CMS plugins) is a site-owner tool with a manual trigger,
sold on SEO. AriaWeave runs automatically, for the person browsing, on sites
they do not control. That distinction is the project.

---

## 2. Requirements

### 2.1 Functional

1. On page load, scan the DOM for:
   - `img` without `alt`, or with junk `alt` (filenames, "image", empty-but-meaningful)
   - icon-only buttons and links with no accessible name
   - form inputs with no associated label
2. Watch dynamically added content via a debounced `MutationObserver` (SPA
   support). **Must be idempotent** — the extension's own mutations must never
   re-trigger the scan.
3. For each candidate, generate a description through the tiered pipeline
   (§3) and write the real attribute into the live DOM.
4. Description language follows the page (§5), not a global setting.
5. Cache results by image hash + element context. Repeat visits are instant
   and cost zero. **Never cache a failed result.**
6. Popup UI: on/off toggle, count of fixed elements, list of element →
   generated description, per-item "report bad description" flag.
7. Inspection mode (toggle/shortcut): a visible overlay showing before → after
   per fixed element, and which tier handled it. Exists for debugging and demo.

### 2.2 Non-functional

- **Zero configuration to be functional.** The free path works with nothing set
  up: no account, no API key. That floor is **T1 + T2 only** (see §3.3). T3 is
  opportunistic and is not part of the promise.
- Cloud-tier API key via gitignored config for the hackathon build. BYOK and a
  hosted proxy are roadmap, not build.
- **A wrong description is worse than none.** On low confidence, emit honest
  generic text (e.g. `"imagen no descrita con confianza"`), never a confident
  guess.
- The extension's own UI (popup, overlay) must pass the same axe checks as the
  fixtures. Note: axe passing is necessary, not sufficient — see §7.
- Latency: time-to-first-description within the budget asserted by the harness.
  Cache hits near-instant.

---

## 3. Architecture

```
content script                  background service worker
┌──────────────┐   candidates   ┌────────────────────────────────┐
│ scanner.js   │───────────────▶│ router.js   (deterministic)    │
│ observer.js  │                │   skip / decorative / OCR /    │
│ injector.js  │◀───────────────│   vision                       │
└──────────────┘  fixed attrs   │ pipeline.js                    │
                                │   T1 rules            (free)   │
                                │   T2 Tesseract.js OCR (free)   │
                                │   T3 Gemini Nano local(free)   │
                                │   T4 Claude Sonnet    (paid)   │
                                │ verifier.js  → retry loop      │
                                │ cache.js     (chrome.storage)  │
                                └────────────────────────────────┘
```

### 3.1 The router is deterministic code, not an agent

It decides *whether a model is needed at all*:

- already labeled → skip
- tiny / spacer (< ~32px, known decorative patterns) → `alt=""`
- text-heavy → OCR path
- otherwise → vision path

Rules give guarantees; models give judgment. Anything that can be decided by a
rule is decided by a rule.

### 3.2 Tier ladder

| Tier | Engine | Handles | Failure mode |
|---|---|---|---|
| **T1** *free* | Heuristic rules | Filename alt, nearby caption text, `title`/`figcaption` reuse, decorative detection | Silent — falls through, never wrong |
| **T2** *free* | Tesseract.js OCR | Text-heavy images: banners, scanned forms, infographics — very common on government sites | Garbage strings; the verifier catches them |
| **T3** *free* | Gemini Nano, on-device | General image description with no key and no network | **Flag-gated today, so absent for ordinary users.** Absence is a normal path, not an error |
| **T4** *paid* | Claude Sonnet, cloud | Whatever survives; batched per page, images resized to ≤1024px, structured JSON out | Costs money and latency — the thing the ladder exists to avoid |

Escalation: each tier's output goes to the verifier. Only on rejection does the
next, more expensive tier run — carrying the rejection reason as feedback. Most
elements never reach a model at all.

### 3.3 Chrome's built-in AI is three separate things

Only one of them is T3.

- **Gemini Nano via the Prompt API** — on-device, free, keyless,
  Chrome-desktop-only (no Firefox, no Safari, no Chrome for Android). Needs a
  multi-gigabyte one-time model download plus disk and VRAM headroom.
- **The Gemini cloud API** — an unrelated paid service. **Deliberately excluded.**
  Two paid clients means two prompt formats, two response parsers and two
  failure modes for zero demo value. T4 is Sonnet and stays Sonnet.
- **The Translator and Language Detector APIs** — also built-in, on-device and
  free. Used here for *verification*, not generation.

### 3.3.1 Nano is not zero-config today

An earlier draft of this section said Nano required three Chrome flags. **That
was wrong**, and the probe (§3.3.2) disproved it: on Chrome 152 the API has
shipped to stable and no flags exist to enable. The flag names in that draft
returned nothing at all when searched.

The conclusion survives on different grounds. What Nano actually requires is
that the model be present, and fetching it needs a **one-time user gesture** —
Chrome will not pull gigabytes for a script nobody clicked. So the extension
cannot silently turn T3 on for someone who does not already have the model.

**T3 therefore cannot be the free floor.** The zero-config promise in §2.2
rests entirely on T1 and T2, which ship inside the extension and need nothing
at all. A one-time opt-in button is the only honest way to offer T3: opt-in is
not configuration, but a silent multi-gigabyte fetch would be worse than either.

Say so during the demo. Claiming zero-config on-device vision is a claim a
judge can check in thirty seconds — and on a clean machine it would fail.

### 3.3.2 First use needs a user gesture — measured 2026-09-02

Confirmed on the dev machine (Chrome 152, M1 Pro, 16 GB): the `LanguageModel`
API is present with **no flags required**, and both text and image input report
`available`. A canvas-drawn test image was described correctly in **1968 ms**.

Two facts the probe established that change how the extension must behave:

1. **Chrome will not fetch the model without a user gesture.** While
   availability is `downloadable`, `create()` throws `NotAllowedError`. This is
   once per browser, not once per page — after the fetch, availability becomes
   `available` and no gesture is ever needed again. It means AriaWeave cannot
   silently enable T3 on a machine that lacks the model; a one-time opt-in
   button is the only honest route, and the zero-config default stays T1 + T2.

2. **The fetch is cheap when the component already exists.** Here it took ~30
   seconds and ~20 MB of real disk, because the 4 GB model was already present
   from other Chrome AI features and APFS cloned it. On a clean profile it is
   several gigabytes. Do not state a figure to the user that has not been
   measured on their machine.

**Latency consequence, and it is the important one.** 1968 ms per image is fine
for one image and unusable for twenty: a page processed serially would take
forty seconds to finish. Lane B must not treat the tier ladder as a queue drained
in DOM order. Visible-viewport candidates go first, off-screen work is deferred,
and the latency budget in §2.2 is measured as time-to-first-visible-description,
not time-to-page-complete.

**T3 absence is a normal branch.** The hour-zero probe checks specifically
whether the Prompt API accepts **image input** on the dev machine — text-only
Nano cannot describe a picture. If image input is missing, T3 collapses and the
zero-config promise rests on T1 and T2 alone. The mitigation is never a second
cloud model.

### 3.4 Verifier

Rule-based first: non-empty, not generic, length bounds, correct language, no
hallucination markers. On failure → retry with the rejection reason attached.
That loop is the autonomous behaviour the project is graded on.

A hard retry cap prevents infinite loops. An optional semantic check by a
smaller model is added only if the rules prove too weak — decided after seeing
real outputs, not before.

---

## 4. Contracts

The lanes never read each other's source. They agree on two message shapes,
defined here before the split. **Any change to either is escalated to the
orchestrator, not negotiated between lanes.**

```js
// content script → background
Candidate = { selector, kind, src?, bbox, context }

// background → content script
Result    = { selector, description, confidence, tier }
```

- `kind` — `"img" | "button" | "link" | "input"`
- `confidence` — 0..1; below threshold the honest-generic path applies
- `tier` — which tier produced it; surfaced in inspection mode

---

## 5. Language

Tested scope is **English and Spanish**. That is a test-scope decision, not a
code decision: the pipeline takes one `lang` variable, so every language works.
en and es are simply the two the fixture corpus carries reference descriptions
for and the verifier is tuned against.

**Description language follows the page, not the user.** A screen reader picks
its *voice* from the DOM's `lang` attribute. A Spanish `aria-label` injected
into an `<html lang="en">` page produces an English voice pronouncing Spanish —
worse than no label at all, which violates §2.2.

```js
// the screen reader takes its voice from the DOM, so the DOM decides
const lang = document.documentElement.lang || navigator.language
```

If a user-language override is ever added, writing `lang` onto the injected
element is **mandatory, not optional**.

Real pages lie about this. Government sites frequently ship no `lang` at all,
or `lang="en"` over Spanish content. The corpus therefore needs a
missing-`lang` fixture and a wrong-`lang` fixture. **The wrong-`lang` case has
no clean answer; the rule is decided after seeing it fail, not before.**

### 5.1 Repo language

Code, identifiers, comments, commits and every document — SPEC, SYSTEM,
AI-DEV-LOG, README — in English. Spanish appears only as **data**: generated
descriptions, fixture page content, the labeled reference set.

Two exceptions: the popup's handful of user-facing strings are hardcoded
Spanish because that is what the demo shows, and the video's narration language
waits on the publication question (§8).

---

## 6. Definition of done

1. On the fixture corpus, axe-core `image-alt`, `button-name` and `label`
   violations go from N to zero after the extension runs.
2. Every generated description passes the verifier's quality rules, and
   similarity against the reference set clears the threshold on the labeled
   fixtures.
3. At least one recorded autonomous loop: generate → verifier rejects →
   regenerate with the rejection as feedback → pass, with zero human prompts in
   between.
4. Latency budget met, and the idempotency test is green: no `MutationObserver`
   self-trigger loop.
5. A live run on a real Peruvian government page, snapshotted in fixtures and
   performed in the demo.

**Criteria 1 and 2 are a pair, not a redundancy.** `alt="image"` drops the axe
violation to zero while being worthless. If scope is cut and criterion 2 goes,
criterion 1 alone will happily certify garbage.

---

## 7. Constraints and known limitations

Stated deliberately — pretending otherwise loses more than it gains.

- **Naming only.** Not focus order, not contrast, not keyboard traps. Explicit
  scope, not an oversight.
- **Not everywhere.** No `chrome://` pages, no Web Store, no closed shadow DOM;
  some cross-origin iframes are out of reach.
- **Per-session, per-user.** The page is fixed for this person, now. That is
  the positioning — assistive infrastructure — not a weakness.
- **axe passing is not proof of correctness.** Both a useless label and a
  visually broken own-UI can be fully axe-clean. Screenshots cover what axe
  cannot; full visual regression is out of scope for this build.

### 7.1 Risk cut-line

If the lanes slip: drop popup polish, drop the per-item "report bad description"
flag, and take the fixture corpus to the low end of the 8–12 range.

**Never cut** the harness, the autonomous-loop evidence, the SPEC and SYSTEM
documents, or **T2**.

T2 is not optional. With T3 flag-gated (§3.3.1), OCR is half of the entire
zero-config promise; routing text-heavy images straight to T4 would leave the
free path producing nothing but rule-based labels. An earlier draft of this
cut-line said to drop Tesseract first — that would have quietly deleted §2.2.

---

## 8. Open questions

| Question | Blocks | Owner |
|---|---|---|
| ~~Does the Prompt API accept image input on the dev machine?~~ | ~~Whether T3 exists at all~~ | **Answered 2026-09-02: yes, no flags, 1968 ms. See §3.3.2** |
| Can the repo be published and continued after the competition? | Video language, roadmap | Organizers |
| Any "AriaWeave" collision in the Chrome Web Store? | Name | 2-minute check |
| What is the rule for a wrong `lang` attribute? | A verifier rule | Deliberately deferred until the corpus shows how it fails |

---

## 9. Decisions log

| Date | Decision |
|---|---|
| 2026-09-02 | **Name: AriaWeave**, replacing the working title "Léelo". *Aria* is the standard injected; *Weave* is integration into the DOM fabric rather than narration over it, with Ariadne's thread as demo material. Rejected: Aria (it is the spec itself), Ariadne (collides with the GraphQL library), AriaThread (awkward in Spanish, "thread" overloaded). |
| 2026-09-02 | **Form: Chrome extension.** The web DOM is the only layer where third-party content is genuinely fixable at runtime. A WebView browser is an extension with more friction; an Android AccessibilityService can only speak over a read-only foreign tree and would race Google's own TalkBack work; system-wide iOS is impossible. A Compose source auditor stays as the roadmap twin: fix where fixing is real — DOM on web, source on native. |
| 2026-09-02 | **Zero configuration.** No settings page in the build. The free local tier is the default and engine choice is made by the router, never by the user. |
| 2026-09-02 | **One paid model.** T4 is Sonnet; cloud Gemini is excluded. |
| 2026-09-02 | **T3 absence is a normal path.** Built-in AI is Chrome-desktop-only and may be missing at runtime. |
| 2026-09-02 | **T3 confirmed present on the dev machine** (§3.3.2), so the ladder stands as specced. But at ~2 s per image it cannot be drained in DOM order — viewport-first scheduling is now a Lane B requirement, not an optimisation. |
| 2026-09-02 | **Language follows the page.** en and es are the tested scope, not the coded scope. Repo and docs in English; Spanish only as data. |
