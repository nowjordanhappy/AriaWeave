# Open findings

Things measured but not yet fixed. Each says which lane owns it and how to
reproduce it. Lane-internal findings live in `verifier/FINDINGS.md`; this file
is the orchestrator's list.

---

## 1 — FIXED 2026-09-03 — duplicate `id` sent a label to the wrong element

> Confirmed, reproduced and fixed. `cssPath()` returned `#id` whenever an element
> had one, so two elements sharing an id produced the same selector and
> `querySelector()` answered with the first for both. Demonstrated by fixture
> `11-duplicate-ids.html`: without the fix the email field was labelled
> **"Número de teléfono"** — the second field's description written onto the
> first — and the second was never labelled at all.
>
> **axe stayed green through the whole bug.** "Zero violations with the
> extension" passed with the wrong label in place, because axe asks whether a
> name exists, not whether it is the right one. Criteria 1 and 2 are a pair, and
> this is what the pair is for.
>
> `cssPath()` now uses `#id` only after confirming it matches exactly one
> element, and falls back to the positional path otherwise.
>
> Original report below.

### Original report

**Lane A. Found 2026-09-02 on the first real-world run** (clearlydecoded.com, a
blog, not even a hard case).

The popup listed **two separate entries both reading `#email`**. Either the page
ships duplicate ids — extremely common on the real web — or the injector
processed one element twice.

Either way the risk is the same and it is the worst kind: if selector generation
prefers `id` when present, two different elements collapse to one selector and a
description can be written onto **the wrong element**. A screen reader user then
hears a confident, wrong label — which is exactly the failure SPEC §2.2 says is
worse than no label at all, arrived at by a different route than the one the
spec anticipated.

**Why the harness could not catch it:** all nine fixtures have unique ids. The
corpus cannot express the bug.

**To reproduce:** load any page with a duplicated id and check whether two popup
entries share a selector.

**Suggested fixture:** `10-duplicate-ids.html`, two inputs both `id="email"` in
different forms, asserting each gets its own label and neither is overwritten.
That fixture is Lane D's to write, i.e. mine.

---

## 2 — Controls without a name have no path beyond T1

> **Amended 2026-09-03: this is partly a routing bug, not only a spec gap.**
> `router.js:51` reads `context.name` as the *accessible* name while
> `content/index.js:190` sends it as the input's `name` **attribute**, so every
> named input is skipped before T1 runs. Verified in the loaded extension:
> `#dni`, `#correo` and `#nacimiento` all come back `tier: "none"`, and T1 given
> the same candidate returns "Email address" at 0.7. A second casualty: T1's
> `humanise(attrName)` rule can never fire, because lane A never sends
> `attrName`.
>
> **The harness certifies the bug.** `quality.spec.js:65` accepts `tier: none`
> plus the honest string as a pass — the SYSTEM §6 defect class, an honest
> fallback masking a routing failure. Lane D narrows that branch first, so the
> harness fails before anyone fixes anything.
>
> Contract amended in SPEC §4.1: `inputName` replaces `name`, which is now a
> forbidden key. Remaining genuine gap below.

**Lane B, and possibly a spec gap. Found in the same run.**

All seven elements found on that page resolved to `tier: "none"` and the honest
generic — *"link without accessible name"*, *"field without label"*. Honest, and
useless to the person it is for.

They were links and form inputs, not images, so no vision tier applies. **The
tier ladder in SPEC §3.2 is image-centric**: T2 is OCR, T3 and T4 are vision.
When T1's heuristics find no nearby text, the pipeline has nothing left to try
and gives up.

Unexplored routes, none of them in the spec:
- the `href` itself — `/contacto`, `informe.pdf` carry real meaning
- `title`, `name`, `placeholder`, `type` on inputs
- the icon's own SVG markup, which is right there in the DOM
- rasterising the icon in the content script and sending it to a vision tier —
  `loadImage()` already prefers `context.dataUrl`, so the hook exists

**Worth noting for the demo:** fixture `03-icon-controls.html` passes because its
buttons sit next to headings T1 can read. The fixture is easier than the web.

---

## 3 — `MIN_LENGTH = 8` rejects the harness's own reference

**Lane D, i.e. mine. Reported by Lane C** (`verifier/FINDINGS.md` finding 1),
still unfixed.

`expectations.json` gives `#save` the reference `"Guardar"` — 7 characters —
while `tests/helpers/quality.js` sets `MIN_LENGTH = 8`. And `similarity()` uses
word bigrams, so a one-word reference matches only that exact word and scores 0
for anything longer. No string satisfies both rules.

Options: lower `MIN_LENGTH`, exempt `button`/`link` kinds from it, lengthen the
references, or fall back to character bigrams for short strings. All are edits
to `tests/`.

---

## 4 — CLOSED 2026-09-03 — T2 dropped to roadmap after measurement

> T3 was handed `09-text-heavy.html`, whose whole meaning is text burned into a
> PNG, and returned "atención al público de 8 a 16 horas, Ventanilla 3 - Mesa de
> Partes" — every word that mattered. Shipping Tesseract would have added 8-20 MB
> to duplicate a capability the machine already has.
>
> The cost is stated in SPEC §7.1 rather than buried: on a machine that never
> opted into the model, the free path is T1 alone, so structure and controls are
> fixed and images are not.

### Original entry — T2 is a stub

**Lane B.** The one tier that could carry criterion 2's similarity slice in a
clean profile, for free and with no key. SPEC §7.1 says it is never cut. It is
the only remaining red test in the reproducible project.

---

## 5 — Decision pending: does the demo need a cloud tier at all?

**Orchestrator. Raised 2026-09-03.**

T4 is unwired. Before wiring anything, answer the prior question: **T1 and T3
already work end to end.** If a cloud tier adds nothing the demo shows, leaving
T4 unwired and saying so as an explicit limit costs nothing and scores in a
competition that grades honesty about scope.

If a cloud tier *is* wanted, Gemini Flash's free tier is a candidate for the T4
slot — a swap of which model occupies it, not a second paid model, so it does
not reverse the "one paid model" decision.

**What it is not:** a replacement for T3, on two grounds.

1. It needs an API key. That does not remove the model download, it trades one
   click for an AI Studio signup — more friction for the end user, not less. The
   zero-config promise gets worse.
2. **Images would leave the machine.** T3 is on-device and nothing is uploaded.
   For a tool that runs on whatever page the user happens to open — medical
   records, bank statements, personal photos — that is a change to what the
   product *is*, not a deployment detail. It deserves to be a stated decision
   rather than a side effect of picking a tier.

Shipping our own key inside the extension is not an option: a public `.zip`
unpacks in a minute and the quota, the bill and the ban are ours. A hosted proxy
is already recorded in SPEC §2.2 as roadmap, not build.
