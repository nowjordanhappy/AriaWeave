# Lane C — findings for the orchestrator

Four things the verifier work surfaced that are **not mine to decide**. Each is
pinned by an assertion in `verifier.test.js`, so if someone changes the corpus
or the harness the finding fails loudly instead of drifting.

Run: `node --test verifier/verifier.test.js` (13 tests, all green).

---

## 1. `03-icon-controls.html #save` cannot pass both quality tests

`expectations.json` gives `#save` the reference `"Guardar"`. Two harness rules
apply to it, and no string satisfies both.

- `tests/helpers/quality.js` sets `MIN_LENGTH = 8`. `"Guardar"` is **7**
  characters, so the reference itself fails the harness's own quality rule.
- `similarity()` is a Dice coefficient over **word bigrams**. A one-word
  reference has no bigrams, so `grams()` falls back to the single word — and
  only that exact word scores above `SIMILARITY_THRESHOLD = 0.25`. Anything
  longer scores **0**:

  | candidate | length rule | similarity vs `"Guardar"` |
  |---|---|---|
  | `Guardar` | ✗ 7 < 8 | ✓ 1.00 |
  | `Guardar cambios` | ✓ | ✗ 0.00 |
  | `Guardar el documento` | ✓ | ✗ 0.00 |

`#trash` (`"Eliminar"`, 8 characters) sits exactly on the floor — it passes, but
only for the exact word, so any rephrasing fails it too.

**Not fixable in `verifier/`.** The candidates are: lower `MIN_LENGTH`, exempt
`kind: "button" | "link"` from it, lengthen the references
(`"Guardar cambios"`, `"Eliminar registro"`), or make `similarity()` fall back to
character bigrams for short strings. All four are edits to `tests/`, which is
Lane D's, and I am not making them.

The verifier currently agrees with the harness and rejects `"Guardar"`
(`too short: 7 characters, minimum is 8`). Say which way to go and it is a
constant.

## 2. The verifier is stricter than the harness in five places, never laxer

The important direction is pinned as an assertion: **nothing the verifier
accepts is rejected by the harness.** If that ever inverts, the product ships
text the arbiter fails on.

Going the other way, the verifier rejects five shapes the harness's
deliberately-crude rules let through. All five come straight from the spec —
§3.2 ("garbage strings; the verifier catches them") and §3.4 ("hallucination
markers") — which `quality.js` does not implement:

| rejected text | rule |
|---|---|
| `Lo siento, no puedo describir esta imagen` | refusal / model self-reference |
| ` ```json {"description": "una plaza"} ``` ` | fenced or JSON leakage |
| `[imagen aquí] con un sello rojo de aprobación` | placeholder markup |
| `\|\|\|\| ~~~ @@@ ### $$$ %%% ^^^ &&&` | punctuation soup (T2 garbage) |
| `H 0 r 4 r 1 0 d 3 4 t 3 n c 1 0 n` | one-character token scatter (T2 garbage) |

Stricter is the safe direction: it costs an escalation, never a wrong
description. Recorded rather than reconciled — this is the duplication working.

## 3. The built-in AI APIs are **unavailable** in the profile the harness launches

Measured 2026-09-02, same machine and same Chrome 152 as the SPEC §3.3.2 probe,
but in a throwaway persistent context — exactly what `launchWithExtension()`
creates:

```
file://   LanguageDetector: unavailable   LanguageModel: unavailable   Summarizer: unavailable   Translator: present
https://  LanguageDetector: unavailable   LanguageModel: unavailable   Summarizer: unavailable   Translator: present
LanguageDetector.create() → NotSupportedError: Model not available
```

§3.3.2 measured `available` because that probe ran as a manually loaded
extension **in the dev machine's own Chrome profile**, which already had the
model. A fresh profile has no components at all, and `availability()` returns
`unavailable` — not `downloadable`, so this is not the user-gesture case from
§3.3.2 and no click would fix it.

Two consequences, and the second is not my lane:

1. **The Language Detector is not there under test.** Lane C's brief says use
   it rather than heuristics; the verifier does, guarded by
   `availability() === 'available'`, and falls back to a marker-count heuristic
   otherwise. Under the harness it is always the heuristic. It never calls
   `create()` while merely `downloadable`, for the §3.3.2 reason.
2. **T3 is unavailable under the harness too**, by the same measurement. Lane B
   should expect `LanguageModel` to be absent in CI-style runs even on this
   machine. If a demo needs T3, it needs the real profile — which the harness
   deliberately does not use.

## 4. The wrong-`lang` case: what I observe, no rule invented

`08-lang-wrong.html` declares `lang="en"` over Spanish content. SPEC §5 defers
the rule. What the corpus actually contains:

- `expectations.json` sets `"lang": "en"` **and** `"langUndecided": true`, so
  `quality.spec.js` skips the language assertion.
- But the reference for `#convocatoria` is **Spanish**:
  `"Una plaza urbana con edificios a los lados y un árbol al centro"`, and the
  similarity test is **not** skipped.

So the corpus, without saying so, already forces an answer: a description in
`en` — which is what SPEC §5's `document.documentElement.lang` snippet
literally prescribes — scores ~0 against a Spanish reference and fails.
**Following §5 to the letter fails fixture 08.** The deferred question is
answered de facto by the reference text, in the opposite direction.

The verifier does not resolve this. `detectPageLanguage(declared, sampleText)`
returns `{ declared, detected, conflict }`, and `conflict: true` stands the
language rule down — every other rule still applies. That is a refusal to
enforce an undecided rule, not a decision about which language wins.

Three ways to close it, all one line here:

- **Declared wins** (§5 literal): the reference on 08 must be rewritten in
  English. Honest to the screen-reader argument; makes the fixture agree with
  the spec.
- **Content wins**: describe in the detected language and write `lang="es"` onto
  the injected element — §5 already says that write is *mandatory* under a
  language override, and this is one. Matches the reference as it stands.
- **Stand down** (current): describe in either, assert neither. Ships, but
  leaves 08 proving nothing about language.

I would take the second — it is the only one where the injected label and the
`lang` around it agree, which is the whole reason §5 exists — but it changes a
fixture reference's meaning and that is the orchestrator's call.

## 5. Fixed: the harness never installed the extension

Not a disagreement — a defect, found while trying to explain why the merged
stack still produced `null` for every candidate. Recorded here because it
invalidates every red result any lane read before 2026-09-02.

`launchWithExtension()` passed `--load-extension`. **Chrome ignores it.** The
flag was removed from official Chrome-branded builds in Chrome 137 and Chrome
accepts it silently. Measured on Chrome 152:

| check | result |
|---|---|
| `--load-extension` on the command line (`chrome://version`) | present |
| AriaWeave in `chrome://extensions-internals` | **absent** — only the component PDF viewer |
| `ctx.serviceWorkers()` | empty |
| content-script console output | none |
| same tree in Playwright's bundled Chromium | loads, injects, works |

So "the harness is red" meant "no extension was installed", for every lane, for
the whole build. Fixed by `Extensions.loadUnpacked` over a browser-scoped CDP
session, authorized by the orchestrator as a cross-lane edit. The quality rules,
the fixtures and `launchClean()` were not touched.

Two traps worth keeping, because both fail silently:

- Playwright passes `--disable-extensions` by default. Leave it in and
  `loadUnpacked` still returns an extension id while the extension does nothing.
- The Extensions CDP domain is not available on a page-scoped session
  (`Method not available`) and is pipe-only. Playwright already launches over a
  pipe, so a browser-scoped session works with no extra flags.

Full suite, all three lanes merged, after the fix: **31 passed, 11 failed.**

## 6. `latency.spec.js` observes the wrong document, and always has

Independent of everything above, and **not fixed** — Lane D's call, and outside
what the orchestrator authorized.

`tests/latency.spec.js:21-37` awaits `page.evaluate()` **before**
`page.goto()`. The MutationObserver is therefore installed on `about:blank`,
the evaluate blocks for `budget * 3` (9 s) until its own timeout resolves with
`Infinity`, and only then does the navigation happen. The observer never sees
the fixture's document at all.

```js
const elapsed = await page.evaluate(async (budget) => { /* observes about:blank */ });
await page.goto(fixtureUrl('01-missing-alt.html'));   // ← too late
expect(elapsed, 'no description ever appeared').toBeLessThan(Infinity);
```

`elapsed` is `Infinity` on every run no matter how fast the extension is, so
this test cannot pass and its failure carries no information about latency. It
needs `page.addInitScript()` to install the observer before navigation and stash
the timestamp on a global the test reads after `goto`.

Worth fixing before the demo: SPEC §6 criterion 4 is half latency, and right now
nothing measures it.
