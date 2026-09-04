# AI Development Log

Written as it happens, not reconstructed afterward. Each entry records what was
attempted, what the machine actually said, and what changed as a result.

---

## 2026-09-02 — Phase 2: the probe that answered wrong

**Goal.** Decide whether T3 (Gemini Nano, on-device, free) exists before Lane D
writes fixtures assuming a four-tier ladder.

**What was built.** A minimal MV3 extension that reports what it finds rather
than assuming an API shape: which entry point answers, what `availability()`
returns for text and for image input, and whether a session accepts a real image
blob. The test image is drawn on a canvas with two unmistakable facts in it — a
red circle and a blue square — so a genuine description is distinguishable from
plausible prose written without looking.

**First run, and the useful failure.** The probe reported:

```
✗ create({image}) failed
  NotAllowedError: Requires a user gesture when availability is
  "downloading" or "downloadable".

T3 DOES NOT EXIST HERE.
```

That verdict was wrong, and the evidence against it was two lines above it in
the probe's own output: `Image availability: downloadable`. Present-but-not-
fetched is not missing. Chrome refuses to pull a multi-gigabyte model from a
script nobody clicked, and the probe auto-ran on load, so it never had a
gesture — then converted "nobody clicked anything" into "the capability does
not exist".

This is precisely the failure mode the project's verifier exists to catch: an
output that is well-formed, confident, and false. Finding it in the tool built
to look for it is the reason the test image carries known content at all.

**Second defect, found by measuring instead of trusting.** The pre-flight note
claimed "multi-gigabyte download, several minutes". Measured on this machine:

| | |
|---|---|
| Free disk before | 220.00 GB |
| Free disk after | 219.98 GB |
| Real cost | **~20 MB, ~30 s** |
| What `du` reported | 4.01 GB in the new version directory |

The 4 GB model was already on disk from other Chrome AI features, and APFS
copy-on-write cloned it into the Prompt API's directory — `du` counts shared
blocks as owned, `df` tells the truth. The note was replaced with one that does
not state a size it cannot know, and `create()` now reports whether a download
event actually fired.

**Result after the fix.**

```
✓ Prompt API found — LanguageModel
✓ Text availability: available
✓ Image availability: available
✓ Image prompt returned in 1968ms
  "A blue square and a red circle float on a white background."
✓ Description matches the drawn image

T3 EXISTS.
```

No flags were needed on Chrome 152; the built-in AI flags searched for in the
plan no longer exist because the API has shipped to stable.

**What changed in the spec.**

1. §3.3.2 added: the one-time user gesture is a product constraint, not a probe
   quirk. AriaWeave cannot silently enable T3 on a machine without the model, so
   a one-time opt-in is the only honest route and the zero-config default stays
   T1 + T2.
2. The latency finding, which matters more than the verdict: **1968 ms per
   image** is fine for one and unusable for twenty. Viewport-first scheduling
   became a Lane B requirement rather than an optimisation, and the latency
   budget is now measured as time-to-first-visible-description.

**Orchestrator decisions logged.** Kept T3 in the ladder. Refused to add a
second cloud model as a hedge. Deferred the wrong-`lang` rule until the corpus
shows how it fails. Did not build visual-regression testing for the popup —
screenshots cover it at a fraction of the cost.

---

## 2026-09-03 — The verifier never rejects, and why that is not good news

**Goal.** Record criterion 3: an autonomous loop — generate, verifier rejects,
regenerate with the rejection as feedback, pass, with no human in between.

**The loop was already built.** The rejection reason is threaded into the next
tier call, and a same-tier retry runs when no costlier rung remains, under a
hard attempt cap. What was missing was evidence, and evidence could not be
manufactured: T1 is deterministic, so a synthetic retry returns the same string
and proves nothing. The loop only has something to feed back when a model is
answering. So the pipeline was instrumented rather than simulated.

**First instrument was itself wrong.** It logged only rejections, so a run where
everything passed printed nothing — and "no output" meant either "no loop
happened" or "this build is not running", with no way to tell them apart. The
same defect the hour-zero probe had on day one: an observation whose negative
and whose broken state look identical. Fixed by logging every outcome and
announcing itself at startup.

**Live run, larepublica.pe, 200 images.** Thirteen descriptions generated in
Spanish on a page nobody prepared:

```
T3 ACCEPTED  "La imagen muestra el título 'PUENTE A CHINA' con franja roja y
              amarilla, asociada a noticias políticas."
T3 ACCEPTED  "Una nota escrita a mano amenaza con leyes peores ... mientras una
              granada negra está adjunta al papel."
T3 ACCEPTED  "La imagen muestra el martillo de juez en primeros planos, con
              desenfoque y una atmósfera cálida."
```

One every ~1.5 s, two in flight, and a 42-second gap where the deferred
off-screen batch waited for a scroll — viewport priority working.

**Thirteen of thirteen accepted. Not one rejection.**

**Why, and it is a consequence of our own decision.** The verifier's rules
target refusals, JSON leakage, punctuation soup and single-character scatter.
That is OCR garbage and cloud formatting failure — the output of T2 and T4.
Dropping T2 to roadmap and leaving T4 unwired removed exactly the tiers that
produce what the verifier was built to catch. The gate does not close because
nothing dirty walks through it any more.

**What was not done.** Stub a tier to fail. That manufactures the artefact the
criterion asks for while proving nothing about the system.

**What was done instead.** `12-language-provocation.html`: a Spanish page
carrying an image whose text is entirely English — a supplier's banner, an
untranslated cover, ordinary on the real web. A tier that transcribes what it
sees answers in English; the page declares `lang="es"`, the language rule
rejects it, and the reason goes back as feedback. A real cause, not a forced
one. If the model answers in Spanish first time, no loop occurs, and that is a
result to report rather than engineer around.

**Also observed, and worth keeping honest.** T3 misreads logos — "PERE LEGAL",
"CUADADO" — and slips on gender, "El caricatura". The descriptions are useful.
They are not accurate, and the demo should not claim otherwise.
