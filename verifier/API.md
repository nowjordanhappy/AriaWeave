# The verifier seam — what Lane B calls

SPEC §4 freezes the two *message* contracts. It says nothing about how the
background worker reaches the verifier, because both live in the same process.
This is that seam, written down so Lane B does not have to read `index.js` to
find it. Everything here is Lane C's to change; ask before depending on more.

```js
import { generateVerified } from '../verifier/index.js';
```

## The one call that matters

```js
const { description, tier, confidence, attempts, rejections } =
  await generateVerified(ladder, { lang, langUndecided });
```

`ladder` is the tiers **in escalation order**. The verifier does not know what a
tier is or what it costs — it runs them in the order given and stops at the
first output that passes:

```js
const ladder = [
  { tier: 'T1', run: async ({ lang, feedback, attempt }) => heuristics(c, lang) },
  { tier: 'T2', run: async ({ lang, feedback }) => ocr(c, lang, feedback) },
  { tier: 'T3', run: async ({ lang, feedback }) => nano(c, lang, feedback) },
  { tier: 'T4', run: async ({ lang, feedback }) => sonnet(c, lang, feedback) },
];
```

- **`run` returns** a string, or `{ text, confidence }`, or `null`.
- **`null` is a normal path**, not an error: T1 falling through silently, T3
  absent on this machine. It costs an attempt and moves on.
- **`feedback`** is the previous tier's rejection reason, a plain sentence such
  as `filename: "plaza.jpg" is a file name, not a description`. Put it in the
  prompt. It is `null` on the first attempt. This is the loop SPEC §6.3 grades,
  so it needs to visibly reach the model.
- **A thrown `run`** is caught and recorded as a rejection — except
  `AbortError`, which is rethrown, because a cancelled page is not a rejection.

## What comes back

| field | |
|---|---|
| `description` | Always a string. Never empty, never null. |
| `tier` | The tier that produced it, or **`null`** when nothing passed. |
| `confidence` | The tier's own number, or `1` if it returned a bare string, or `0` on exhaustion. |
| `attempts` | How many tiers ran. Never exceeds `MAX_ATTEMPTS` (4). |
| `rejections` | `[{ tier, reason }]` — the whole trail. This is inspection-mode material and the evidence for SPEC §6.3. |

**`tier === null` means the ladder was exhausted** and `description` is the
honest-generic string from SPEC §2.2 (`"imagen no descrita con confianza"`, or
the English form). It is deliberate output, not a failure — inject it. But it is
also not a description, so per CLAUDE.md **do not cache it**: cache on
`tier !== null` only.

The `Result` contract needs a `tier` string. What to send for `null` is an
orchestrator call, not mine — `"none"` and `"fallback"` are both defensible.

## The language argument

`lang` is the page's language, decided by Lane A/B from
`document.documentElement.lang || navigator.language` (SPEC §5). The verifier
rejects a description that is in a different language.

Real pages lie about it. Before running the ladder:

```js
const { conflict } = await detectPageLanguage(declaredLang, pageSampleText);
await generateVerified(ladder, { lang: declaredLang, langUndecided: conflict });
```

`langUndecided: true` suppresses **only** the language rule; every other rule
still applies. That is a deliberate stand-down on `08-lang-wrong.html`, which
SPEC §5 leaves undecided — see FINDINGS.md finding 4. If you skip this call
entirely, the verifier simply enforces the declared language.

## Also exported, if you want the pieces

- `verify(text, { lang })` — the synchronous rules alone. `{ ok, reason?, fallback? }`.
- `check(text, { lang, langUndecided })` — `verify` plus the async language rule.
- `honestFallback(lang)` / `isHonestFallback(text)` — the SPEC §2.2 string.
- `MIN_LENGTH`, `MAX_LENGTH`, `MAX_ATTEMPTS`.

## Two things that will bite

- **The built-in Language Detector is `unavailable` in the profile the harness
  launches** (FINDINGS.md finding 3), so the language rule runs on a heuristic
  under test. The same measurement says `LanguageModel` is unavailable there
  too — expect T3 to return `null` in every harness run.
- **A rejected description costs a tier.** If T1 emits junk the verifier catches
  it, but the page still pays for T2. Router quality (SPEC §3.1) is what keeps
  the ladder short; the verifier is the net, not the plan.
