# Fixtures

Synthetic pages with planted, countable accessibility failures. Each one exists
for a reason recorded in `expectations.json` and in a comment at the top of the
file — if a fixture's purpose is not obvious, that is a bug in the fixture.

## Still missing: real snapshots

`expectations.json` covers the synthetic corpus only. The spec's definition of
done also requires a live run against a real Peruvian government page, captured
here as a snapshot so the harness stays deterministic.

To add one:

1. Save the page complete (HTML + assets) into `tests/fixtures/real/<name>/`.
2. Strip analytics and third-party scripts — the harness must not hit the network.
3. Add an entry to `expectations.json` with reference descriptions written by a
   human. **Do not generate the references with the same pipeline under test**;
   that makes the similarity criterion circular and it will pass while being
   worthless.

Not faked in advance. A synthetic page pretending to be gob.pe would prove
nothing and would be found out in the demo.

## Why the assets are PNG

`createImageBitmap()` cannot decode SVG in a worker — there is no layout engine
there. Measured: SVG fails `InvalidStateError: The source image could not be
decoded`, PNG succeeds. The pipeline runs in a service worker, so an SVG fixture
is invisible to every tier below T1 and the corpus silently tests nothing.

The `.svg` files are kept as the source. Regenerate a `.png` by rendering the
`.svg` in a sized HTML wrapper and screenshotting it headless; a direct
`--screenshot` of an `.svg` ignores `--window-size` and gives you 756x469.

Real sites do serve SVG images. Describing them needs the content script to
rasterise in the page, where a layout engine exists, and hand a data URL to the
pipeline — `loadImage()` already prefers `context.dataUrl` if present. Not built.
