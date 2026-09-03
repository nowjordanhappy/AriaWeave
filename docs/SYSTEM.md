# AriaWeave — Engineering System

How this is built. The competition grades the engineering system above the
product, so this document is a deliverable, not a description written afterward.

---

## 1. The mental model

Orchestration is not many chat tabs. It is:

1. **One spec everyone reads** — [SPEC.md](SPEC.md), written and committed
   before any implementation.
2. **Work split into lanes with physically isolated context** — one git
   worktree and one session per lane, so agents cannot touch each other's files
   even by accident.
3. **A test harness that already exists** — each lane loops against its own
   slice of it, reading real failures instead of being told about them.
4. **A human defining contracts and judging** — not relaying error messages.
   The harness reports errors. The human decides what they mean.

The mechanics come from git worktrees (isolation of files) and separate
sessions (isolation of context). Both are boundaries, not conventions: a lane
*cannot* read another lane's code, so it cannot couple to it.

---

## 2. Lanes

| Lane | Owns | Context it is given | Its harness slice |
|---|---|---|---|
| **D — harness** | `tests/` | Spec only | Itself. Everything red at handoff |
| **A — content** | `content/` | Spec + DOM injection contract | Finds every planted candidate; injects; idempotency holds |
| **B — pipeline** | `background/` | Spec + pipeline contract + API docs | Candidates in, descriptions out; tier routing; cache hits |
| **C — verifier** | `verifier.js` + scoring | Spec + quality rules + labeled reference set | Rejects planted-bad text, accepts good; retry loop terminates |

**Each lane's session gets only its row** — not the whole repo, not the other
lanes' code. This is what context engineering means in practice.

Lanes communicate exclusively through the two contracts in
[SPEC.md §4](SPEC.md#4-contracts). If a lane needs something from another lane,
that is a contract change and it goes through the orchestrator.

---

## 3. Execution order

| # | Phase | Budget | Output |
|---|---|---|---|
| 1 | Spec and contracts | 1h | `docs/SPEC.md`, `docs/SYSTEM.md` committed before any code |
| 2 | Nano probe | 0.5h | Answers whether T3 exists, before fixtures assume it |
| 3 | **Lane D** | 2h | Fixtures + Playwright/axe rig. All red |
| 4 | Lanes A, B, C in parallel | 4h | Three worktrees, three sessions, each looping autonomously |
| 5 | Integration | 2h | Merge, full harness, fix the seams. Capture recovery loops |
| 6 | Polish and evidence | 2h | Popup, inspection mode, live gob.pe run, screenshots |
| 7 | Docs and demo | 2h | AI-DEV-LOG.md, README, 3-minute video |

**Phase 2 gates phase 3.** Lane D must not write fixtures for a four-tier
ladder before anyone knows whether the third tier exists on the machine.

**Phases 1 and 2 are the orchestrator's alone.** From phase 3 on, the
orchestrator stops writing implementation code and starts defining contracts
and judging output.

### 3.1 Lane D details

- 8–12 fixture pages: mostly synthetic with planted issues under our control,
  plus 2–3 real snapshots including the gob.pe page, the missing-`lang` case
  and the wrong-`lang` case.
- Playwright launches Chromium with the extension loaded.
- axe-core assertions before and after the extension runs.
- Quality and similarity scoring against the labeled reference descriptions.
- Latency and idempotency tests.

### 3.2 Almost everything fails at handoff — but not quite everything

The plan said "all red". Building it showed that one group must be green: the
**corpus self-check**, which runs each fixture through axe with no extension
installed and asserts the planted violations are actually there. It passes at
handoff (9 fixtures, 19 violations, confirmed).

That green is what makes the red meaningful. Without it, a fixture that
silently lost its planted `<img>` would report zero violations after the
extension ran, and the harness would certify success on an empty page. The
corpus check tests Lane D's own work; everything about the extension is red.

Every extension-dependent test fails with the same deliberate message rather
than a launch stack trace:

```
No manifest.json at /Volumes/DATOS/Projects/AriaWeave.
The harness is red because the extension does not exist yet. That is the
expected state until lanes A and B land.
```

A lane must never have to debug the harness to find out whether the failure is
its own.

### 3.3 The harness drives Chrome, not Chromium

`channel: 'chrome'` is set deliberately. Gemini Nano is a Chrome browser
component and Playwright's bundled Chromium does not have it, so the default
setup would make T3 permanently untestable — and the failure would look like a
model bug rather than a harness choice. It also means no browser download:
`npm i` installs three packages and nothing else.

---

## 4. Deterministic controls

These are what turn "we used AI" into an engineering system, and they are cheap:

- **The harness runs automatically on every change** — a hook, not a polite
  request in a prompt.
- **Worktree boundaries make out-of-lane edits impossible**, rather than
  discouraged.
- **The verifier's retry loop has a hard cap**, so it cannot spin forever.
- **The router is deterministic code.** Anything decidable by a rule is decided
  by a rule; models are only reached for judgment.

---

## 5. Evidence to capture

The process is graded, which means the evidence is part of the build, not a
write-up afterward. Capture as it happens:

- **Autonomous recovery loops, verbatim.** Best candidates: the
  `MutationObserver` self-trigger loop, and a verifier rejection → regenerate →
  pass cycle. Needs zero human prompts in between to count.
- **A lane timeline** showing the three lanes overlapping — parallelisation
  evidence.
- **Orchestrator decisions**, logged as they are made: contract definitions,
  ambiguous-description triage, scope cuts, and the call on when to stop.
  Human-as-orchestrator evidence is worth as much as the automation.

Destination: `AI-DEV-LOG.md`, written incrementally.

---

## 6. What manual review still owns

The harness cannot see everything. Two classes of defect produce valid,
semantic, axe-clean output and still fail:

- A useless-but-passing label (`alt="image"`) — covered by
  [SPEC.md §6](SPEC.md#6-definition-of-done) criterion 2, which is why criteria
  1 and 2 are a pair.
- A visually broken own-UI — CSS can silently rearrange content while the DOM
  stays correct. Screenshots catch it; assertions do not, at any reasonable cost.

Neither is a gap to automate away in this build. Both are named so nobody
mistakes a green harness for a finished product.
