# Lane A — content

You own `content/` and `popup/`. Nothing else. Not `background/`, not
`verifier/`, not `tests/`.

Read [../SPEC.md](../SPEC.md) first, especially §2.1, §3.1, §4 and §5.

## What you build

1. **scanner** — find candidates in the DOM: `img` without `alt` or with junk
   `alt` (filenames, "imagen", "image", dimensions), icon-only buttons and links
   with no accessible name, form inputs with no associated label.
2. **observer** — a debounced `MutationObserver` for content that arrives after
   first paint. **It must not re-trigger on your own writes.**
3. **injector** — write the returned attribute onto the element: `alt` for
   images, `aria-label` for controls. Also set `data-ariaweave-tier` with the
   tier that produced it (the harness and inspection mode both read it).

## Your contract

You send candidates to the background and receive results. **Frozen** — if you
need another field, stop and ask the orchestrator.

```js
Candidate = { selector, kind, src?, bbox, context }   // kind: img|button|link|input
Result    = { selector, description, confidence, tier }
```

`context` is whatever nearby text you can cheaply gather (caption, heading,
`title`, adjacent paragraph). It is what lets T1 answer without a model, so it
is worth gathering well.

## Rules that will bite you

- **Language comes from the page**, not the user: `document.documentElement.lang
  || navigator.language`. Pass it in `context`. A screen reader takes its voice
  from the DOM.
- **Decorative elements get `alt=""`, never a description.** Inventing prose for
  a tracking pixel is worse than skipping it. See fixture `05-decorative.html`.
- **Viewport first.** T3 costs ~2s per image (measured, SPEC §3.3.2). A page
  drained in DOM order takes forty seconds. Send visible candidates first and
  defer off-screen ones.

## Your harness slice

```
npx playwright test axe.spec.js idempotency.spec.js
```

Green means: every planted candidate is found, attributes land, the observer
catches late content, and it does not feed itself. `quality.spec.js` depends on
lane B and will stay red for you — that is expected, not your bug.
