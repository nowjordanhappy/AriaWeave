# AriaWeave

**Weaves the missing accessibility layer into any page, live.**

A Chrome extension (MV3) that scans any page for accessibility-naming gaps —
unlabeled images, icon-only buttons, orphan form inputs — generates real
descriptions, and writes actual `alt` and `aria-label` attributes into the live
DOM. The user's own screen reader then just works better.

Not an SEO tool for site owners. Assistive infrastructure for the person
browsing, on sites they do not own and cannot file a ticket against.

Built for Howdy Dev Day 2026.

## Documents

| File | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | What is built, the contracts between lanes, and the definition of done |
| [docs/SYSTEM.md](docs/SYSTEM.md) | How it is built: lanes, isolation, harness, and orchestration |
| [CHANGELOG.md](CHANGELOG.md) | User-facing changes |

## Status

Spec committed. No implementation yet — by design: the spec predates the code,
and the test harness predates both.
