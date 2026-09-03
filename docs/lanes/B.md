# Lane B — pipeline

You own `background/`. Nothing else. Not `content/`, not `verifier/`, not
`tests/`.

Read [../SPEC.md](../SPEC.md) first, especially §3.1, §3.2, §3.3 and §4.

## What you build

1. **router** — deterministic code, not an agent. Decides *whether a model is
   needed at all*: already labeled → skip; tiny/spacer (<~32px, known
   decorative patterns) → `alt=""`; text-heavy → OCR; otherwise vision.
2. **tiers** — T1 rules, T2 Tesseract.js OCR, T3 Gemini Nano on-device, T4
   Claude Sonnet. Each tier's output goes to the verifier; only on rejection
   does the next, more expensive tier run, carrying the rejection reason.
3. **cache** — `chrome.storage`, keyed by image hash + element context.
   **Never cache a failure.** One failed lookup would otherwise become
   permanent for the process and every retry above it becomes decoration.

## Your contract

**Frozen** — if you need another field, stop and ask the orchestrator.

```js
Candidate = { selector, kind, src?, bbox, context }
Result    = { selector, description, confidence, tier }
```

## Rules that will bite you

- **T3 may be absent, and that is a normal branch, not an error.** Nano needs
  the model present, and fetching it requires a one-time user gesture. Handle
  absence as an ordinary path.
- **T4 is the only paid tier.** Do not add a second cloud model. Batch per page,
  resize images to ≤1024px, ask for structured JSON.
- **~2s per image on T3** (measured, SPEC §3.3.2). Do not drain the queue in DOM
  order. Concurrency and viewport priority are requirements, not optimisations.
- **Below the confidence threshold, emit the honest generic string**, never a
  confident guess. A wrong description is worse than none.

## Your harness slice

```
npx playwright test quality.spec.js latency.spec.js
```

Green means: descriptions are useful, resemble the human references, the
text-heavy fixture is handled by T2 rather than escalating to T4, and the
latency budget holds. Needs lane A to be landing candidates — coordinate
through the orchestrator, not by reading their code.
