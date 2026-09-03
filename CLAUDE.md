# AriaWeave

Chrome extension (MV3) that injects real `alt` / `aria-label` attributes into
the live DOM so a visitor's own screen reader works better on sites they do not
own.

**Read [docs/SPEC.md](docs/SPEC.md) before writing code.** It is the single
source of truth for requirements, architecture and the definition of done.
[docs/SYSTEM.md](docs/SYSTEM.md) covers how the work is split.

## Rules

- **Spanish is data, not code.** Descriptions, fixture content and reference
  text are Spanish; identifiers, comments, commits and docs stay English.
- **The contracts in SPEC.md §4 are frozen.** If you need a field that is not
  there, stop and escalate to the orchestrator. Do not extend the shape and do
  not work around it.
- **A wrong description is worse than none.** Below the confidence threshold,
  emit honest generic text. Never a confident guess.
- **Never cache a failed result.** `getOrPut`-style helpers store whatever the
  lambda returns, so one failure becomes permanent for the process. Cache on
  success only.
- **Description language follows the page**, from `document.documentElement.lang`
  — never a global setting. The screen reader takes its voice from the DOM.
- **Edit only your lane's folder.** Worktrees keep the other lanes out of sight,
  but they are not a sandbox — a shell can reach a sibling directory. If a fix
  seems to belong in another lane's files, that is a contract question, not a
  patch you make.
- **No new dependencies** without asking. This is a 13-hour build; a few lines
  beats a package.

## Before claiming something works

Run the harness. Then read [docs/SYSTEM.md §6](docs/SYSTEM.md) — a green
harness is not proof of a working product, and two named defect classes pass it
while being wrong.

## Commits

The history is read, not just replayed — treat it as part of the deliverable.

- `type(scope): imperative summary` — types: `feat`, `fix`, `docs`, `test`, `chore`.
- **One commit per decision or unit of work.** Never batch unrelated changes.
- **The body answers *why*.** The diff already says what changed; it cannot say
  what you knew at the time or what you rejected.
- A commit that reverses an earlier decision states what the earlier one got
  wrong, so the reasoning survives instead of silently disappearing.
- User-facing changes go into `CHANGELOG.md` under `[Unreleased]` in the same
  commit that makes them.
