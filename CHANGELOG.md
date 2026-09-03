# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project specification and orchestration plan (`docs/SPEC.md`, `docs/SYSTEM.md`).
- Development log (`AI-DEV-LOG.md`), written incrementally.
- Descriptions are generated through the tiered pipeline: rules first, then OCR
  for text-heavy images, then the on-device model, and only then the cloud.
- Repeat visits reuse a stored description instead of re-inferring one. A failed
  lookup is never stored, so a retry is always a real retry.
- Decorative images are silenced with `alt=""` rather than described.
- When nothing clears the confidence bar, the extension says so in the page's
  language instead of guessing.
