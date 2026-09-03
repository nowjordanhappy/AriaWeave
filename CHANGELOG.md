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
- Decorative images are silenced with `alt=""` instead of being described.
- Every fixed element carries `data-ariaweave-tier`, so what produced a
  description is visible in the page.
- Popup: on/off toggle, a count of fixed elements, the before → after list for
  the current tab, and a per-item flag for a bad description.
- Inspection mode: an on-page overlay showing before → after and the tier that
  produced each description. Off by default.
