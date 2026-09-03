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
