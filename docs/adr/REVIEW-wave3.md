# ADR review feedback — Wave 3

Findings raised while implementing `0010` (viewer re-architecture) against
ADR-0004. Recorded before the ADR moves from `Proposed` to `Accepted`.
Corrections are PROPOSED here — ADR-0004 itself is not edited.

---

## 1. Migration step 4 cites stale line numbers

**Challenge.** Step 4 points at `src/cli/commands/serve.ts:117-128` with the
"Viewer not built" error at `:125`. The viewer branch actually lived at
`:291-307` (error string at `:296`). Step 5 cites `scripts/build.mjs:21-35`;
the viewer branches were `:17` (`src/viewer/dist` clean) plus `:22-35`
(Vite build + copy).

**Verdict: accepted (cosmetic).**

**Action.** Refresh the two line references. The cutover itself matches the
step's intent: the `express.static(viewerDir)` branch and its error are
gone, replaced by artifact serving with a "run `arkive export html` first"
404. One addition beyond the letter of the step: `GET /graph.html` is
served alongside `/` and `/index.html`.

---

## 2. The viewer test count is 14, not 11

**Challenge.** The ADR counts 11 test files under `tests/viewer/`. At
implementation time there were 14: `api-auth`, `ConceptMap`,
`decision-log`, `hooks`, `ProgressTracker`, `prompt-input`,
`prompt-queue-panel`, `QuestionCard`, `QuizPanel`, `search`, `stack-view`,
`topology`, `tree-view`, `viewer-session`. The ADR's table of five dead
imports names only the original five.

**Verdict: accepted (counting).**

**Action.** Restate step 5 as "the 14 test files" (or drop the number).
All 14 were deleted; the file count is corroborated by the deletion, not
by the ADR's table.

---

## 3. Step 1 is moot — implemented as steps 1+5 together

**Challenge.** Step 1 says to delete the five dead test files rather than
repair them. By implementation time the toolchain track (issue 0001) had
already made every viewer test pass by pointing imports at the root React,
so there was nothing dead left to delete early — and step 5 deletes all 14
files regardless.

**Verdict: accepted (timing).**

**Action.** Note that step 1 applied to the tree as measured at `bf89673`
and collapses into step 5 once the toolchain track lands first (the ADR
itself anticipates this at :60-62: step 1 "becomes trivial").

---

## 4. The 150 KB budget needs a denominator

**Challenge.** The targets table says "Uncompressed size … **≤ 150 KB**"
without saying over what graph. The repo's own graph (494 nodes, 1297
edges, 20 decisions) generates a 1,374 KB artifact — every node carries
its panel data (grouped edges, shapes, full decision claims), and that
scales with the codebase. A budget gated on the live graph fails the day
any real project exports.

**Verdict: accepted, needs a ruling.**

**Action.** Proposed ruling, as implemented: the budget is gated on a
FIXED fixture graph (`tests/export/html-budget.test.ts` — ≤150 KB
uncompressed, zero external references), and the live-graph size is
reported, not gated. If the ADR intends the live graph to fit 150 KB, the
generator needs a trimming strategy (summaries out, decisions
lazy) that is not in this implementation.

---

## 5. "Force-directed-looking" was not built

**Challenge.** §Scope of the artifact promises a "Force-directed-looking
but deterministic layout". The generator emits deterministic layered
columns (depth by dependency distance, node-id order) with cubic edge
paths — readable, but nobody would call it force-directed-looking.

**Verdict: accepted (wording).**

**Action.** Restate as "deterministic layered layout". Layout quality is
now explicitly arkive's problem (the ADR's Negative section already
accepts this); the scope text should not promise an aesthetic the
implementation does not attempt.

---

## 6. Step 5's VISION.md instruction was reported, not executed

**Challenge.** Step 5 ends with deleting the React Flow / D3 / dagre
entries from `docs/VISION.md`'s dogfood example. VISION.md is frozen
without asking.

**Verdict: accepted as a follow-up, not a blocker.**

**Action.** Whoever owns VISION.md removes the viewer-toolchain dogfood
lines once the architecture document is regenerated without viewer nodes.
The implementation did not touch the file.

---

## 7. 0018 evaporates — both items, verified

**Challenge.** Issue 0018 (blocked by 0010) asks for two fixes: (1) tsup
declaration output polluting `dist/viewer/`, (2) a dev-proxy origin
allowance.

**Verdict: both evaporated, no fix needed.**

**Action.** (1) The declaration emit in `tsup.config.ts` lists explicit
entry files and never covered `src/viewer/`; after deletion a clean
`npm run build` produces no `dist/viewer/` at all — verified on disk.
`tsup.config.ts` was left untouched. (2) The Vite dev proxy is gone with
Vite. Propose closing 0018 with no change.

---

## 8. Kill condition: NOT met

The ADR's kill condition fires if the artifact needs running-app
interactivity: persistent annotations, live editing, or whole-graph
filtering under one frame. None is needed. The artifact's interactions —
pan, zoom, node selection, text filter, deep links — are stateless and
client-side with no server round-trip; nothing in 0009 or 0010 asks for
annotations, editing, or authoring in the viewer (all three are explicitly
out of scope). Option (b) stands.
