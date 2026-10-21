# 0015 — Retire quiz learning mode

status: done
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

- [x] No quiz, mastery, or progress-bar code remains in the repo.
      `src/learning/` (5 files), `tests/learning/` (5 files),
      `src/cli/commands/learn.ts`, `tests/cli/learn.test.ts`,
      `tests/cli/serve-learning.test.ts`, and
      `skills/learning/learning-mode/` (2 files) are deleted. The
      `/api/learning/progress` GET/PUT endpoints and the `learn` command
      registration are gone. The viewer components had already gone with 0010.
      Historical mentions remain only in `docs/VISION.md`, the ADRs,
      `arkive/legacy-architecture.json`, one legacy migration fixture, and
      decision records — preserved rationale, not live code or instructions.
      The graph retains 36 tombstones for the removed modules as ADR-0001
      requires; every one carries `deletedAt`, and no live node points at a
      deleted path.
- [x] No README or skill reference points at deleted paths. README, `AGENTS.md`,
      `CLAUDE.md`, the `AGENTS.md.hbs` / `CLAUDE.md.hbs` templates,
      `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
      `package.json` keywords, and the installed-skill registry were updated.
- [x] `npm run lint` and `npm test` pass with the tests removed, not skipped.
      `npm run lint` exits 0. `npx vitest run` (the `test` script) exits 0:
      79 files, 1106 passed, 2 skipped. The two skips are pre-existing and
      unrelated; the 7 quiz suites were deleted, not skipped.
- [x] A deliberate decision is recorded on `explain-decisions` — keep, fold in,
      or delete. Written down, not left ambiguous.

## Completion record

Deleted the quiz surface in the source, CLI, HTTP server, skill tree, plugin
manifest, package metadata, and installer registry. `install-skill` now installs
8 skills (`architecture-tracker`, `arkive-init`, `arkive-import`, `arkive-view`,
`process-prompts`, `walkthrough`, `explain-decisions`, `reconciliation`).

### `explain-decisions`: kept, reframed

Decision `dec-021` records the call. The skill is kept at
`skills/learning/explain-decisions/SKILL.md` because ADR-0003 explicitly keeps
it and lifts its MUST-NOT list into every walkthrough traversal. It is now
reference narration for the walkthrough's `decisionsAbout` step and the
`why_does_this_exist` tool, not an optional standalone mode. Its trigger no
longer claims a "Why this?" button in the web viewer. Moving it under
`skills/walkthrough/` was rejected: `findSkillDir` only searches the layer
subdirectories and the skills root, so a nested skill would ship but never
install — the exact class of omission 0014 repaired.

### Defects found while integrating

Two real bugs in the v2 write handlers were exposed and fixed, each with a
regression test in `tests/server/tools.test.ts`:

1. **Existing-node edits were silently reverted.** `readArchitecture` returns
   `services[]` / `connections[]` projected from the pre-call graph;
   `writeArchitecture` folds a stored v1 view back onto the graph. Updating an
   existing authored node therefore wrote a success history entry while keeping
   the old values. The handler now drops the stale view when the caller used only
   the v2 surface and lets the writer regenerate it. This is why the corrected
   `viewer` node initially still claimed `React + Vite`. `record_decision` had
   the same re-fold on every decision write; it now uses the same helper, and
   its regression test asserts an untouched node gains no `legacyType`.
2. **Removing a connection removed it from only one representation.** The
   connection sweep and edge sweep shared one match counter, so the first sweep
   consumed the count and the edge survived. It was latent while the v1 fold
   deleted the edge as a side effect. The two representations now use
   independent counters, and the test asserts both the connection and the edge
   are gone.

## Note

Deleting is the right call and should not be softened. The replacement in 0009
is strictly better for the stated goal, and keeping a disliked half-feature
costs maintenance and dilutes the product's position. The maintainer built it in
hours and it has not earned five years.