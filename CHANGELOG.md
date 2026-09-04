# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project specification and orchestration plan (`docs/SPEC.md`, `docs/SYSTEM.md`).
- Development log (`AI-DEV-LOG.md`), written incrementally.
- Naming gaps are found and fixed in the live DOM: missing and junk `alt` on
  images, icon-only buttons and links, unlabelled form inputs. Content that
  arrives after first paint is caught too.
- Descriptions are generated through the tiered pipeline: rules first, then OCR
  for text-heavy images, then the on-device model, and only then the cloud.
- Repeat visits reuse a stored description instead of re-inferring one. A failed
  lookup is never stored, so a retry is always a real retry.
- Decorative images are silenced with `alt=""` rather than described.
- When nothing clears the confidence bar, the extension says so in the page's
  language instead of guessing.
- Every fixed element carries `data-ariaweave-tier`, so what produced a
  description is visible in the page.
- Popup: on/off toggle, a count of fixed elements, the before → after list for
  the current tab, and a per-item flag for a bad description.
- Inspection mode: an on-page overlay showing before → after and the tier that
  produced each description. Off by default.
- Inspection mode and the popup show how long each batch took, so latency is
  visible on a real page rather than inferred from a benchmark.
- Click any entry — in the popup or in the inspection overlay — and the page
  scrolls to that element and flashes a ring around it. Keyboard-operable, and
  it says so when the element is gone.
