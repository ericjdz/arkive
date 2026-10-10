# 0015 — Retire quiz learning mode

status: open
stream: comprehend
blocked_by: 0009

## Context

The maintainer's words: *"I dont really like the learning mode and quiz that I
built."*

What exists: `src/learning/` (question generation from architecture data,
concept mastery, progress persistence), `skills/learning/learning-mode/`,
`skills/learning/explain-decisions/`, and a Learning Mode viewer view with a
`QuizPanel`, `ConceptMap`, and `ProgressTracker`.

It was built early — commit sequence around "Plan 3", 2026-05-05, within hours of
the schema. It was the most speculative thing in the product and it has had no
user since.

## Scope

Delete, do not preserve:

- `src/learning/` question generation and concept mastery
- `QuizPanel`, `ConceptMap`, `ProgressTracker` components
- `skills/learning/learning-mode/` including its `question-templates.md`
- Learning Mode from the viewer (folds into 0010)
- The `learn` CLI command's quiz surface

Assess and keep or delete:

- `skills/learning/explain-decisions/` — "why this?" explanation. This is
  adjacent to the walkthrough engine (0009) and may survive as a skill that
  invokes it. Decide explicitly; do not leave it orphaned or silently kept.

## Constraint

The `learn` command currently imports `"open"`, which is not in
`package.json` dependencies (`learn.ts:30`), so it always takes the `.catch()`
branch and never opens a browser. Whatever survives must actually work. A
retired command that still appears in the README is worse than a deleted one.

## Acceptance criteria

- [ ] No quiz, mastery, or progress-bar code remains in the repo.
- [ ] No README or skill reference points at deleted paths.
- [ ] `npm run lint` and `npm test` pass with the tests removed, not skipped.
- [ ] A deliberate decision is recorded on `explain-decisions` — keep, fold in,
      or delete. Written down, not left ambiguous.

## Note

Deleting is the right call and should not be softened. The replacement in 0009
is strictly better for the stated goal, and keeping a disliked half-feature
costs maintenance and dilutes the product's position. The maintainer built it in
hours and it has not earned five years.