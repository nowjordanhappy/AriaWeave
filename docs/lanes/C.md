# Lane C — verifier

You own `verifier/`. Nothing else. Not `content/`, not `background/`, and
**especially not `tests/`** — see the warning below.

Read [../SPEC.md](../SPEC.md) first, especially §2.2, §3.4 and §5.

## What you build

A rule-based verifier that accepts or rejects a generated description, plus the
retry loop that feeds a rejection reason back to the pipeline.

Rules, in the order they are cheapest to check: non-empty; not generic
("imagen", "image", "logo", a filename); within length bounds; in the requested
language; free of hallucination markers.

On rejection, return the **reason**, not just a boolean. The reason is what the
next tier receives as feedback, and that loop is the autonomous behaviour the
whole project is graded on.

**A hard retry cap.** No exceptions. An uncapped loop is the failure mode that
looks like progress.

## The language check

Chrome's built-in **Language Detector API** is on-device, free and keyless — use
it rather than heuristics. It is a separate API from the Prompt API and does not
need a model download of its own.

The wrong-`lang` case (`08-lang-wrong.html`: a page declaring `lang="en"` over
Spanish content) has **no decided rule**. The spec defers it deliberately. Report
what you observe and let the orchestrator decide; do not invent a rule and do not
edit the fixture to match your behaviour.

## Do not edit the harness

`tests/helpers/quality.js` contains rules that overlap yours. That duplication
is deliberate. If your verifier and the harness judged descriptions with the
same code, a broken verifier would pass its own tests and the whole criterion
would be circular.

**They are allowed to disagree.** A disagreement is a finding to report, not a
bug to reconcile by editing the harness.

## Your harness slice

```
npx playwright test quality.spec.js
```

Plus your own unit tests over the labeled reference set in
`tests/fixtures/expectations.json` — read it, do not modify it.
