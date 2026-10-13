# Walkthrough contract (FROZEN)

Status: frozen. Issue 0010 builds the viewer against this file. Changes
require a new issue; do not edit in place once 0010 starts.

Backing: `src/io/decisions.ts` (`whyDoesThisExist`, `gateFor`,
`evidenceFor`, `caveatsFor`); `src/server/session-context.ts` (System-layer
shape); `src/server/tools.ts` (`why_does_this_exist` ≈ `decisionsAbout`
backing); `src/server/resources.ts` (`architecture://` reads). The
`topology()` / `open()` / `trace()` / `dataShapes()` primitives below are
the specified engine interface from ADR-0003 §The mechanism — they do not
exist as tools yet and are implemented under 0009's engine half, not here.

## 1. Levels

### System — sub-concepts, no paths

Per node: `id`, `kind`, `name`, `summary`. Per edge: `from`, `to`, `kind`.
Plus `counts` (nodes, edges, decisions). No `path`, no `tech`, no
filenames, no rationale, no alternatives. Source: `topology()`.

### Subsystem — one service or cluster opened

`ref`, `kind`, `name`, `summary`, `children[]` (`id`, `kind`, `name` —
no paths), `inbound[]` / `outbound[]` (`ref`, `kind`), `dataShapeRefs[]`
(`id`, `name`), `decisionRefs[]` (`id`, `topic` — topics only, full
rationale via `decisionsAbout`). Every item carries its provenance gate.
Source: `open(ref, depth)` with `depth` 1.

### Module — real paths

`ref`, `path` (required, real — a module with no path is reported, never
invented), `imports[]` (real paths), `importedBy[]` (real paths),
`reads[]` / `writes[]` (shape ids), full `decisionsAbout(ref)` claims.
Every claim carries gate + evidence + caveats (§4). Source: `open(ref,
depth)` at full depth.

## 2. Traversal catalogue

Primitives (pure queries over the graph):

- `topology() -> SystemLevel` — every node and edge, no prose.
- `open(ref, depth) -> SubsystemLevel | ModuleLevel` — one node opened
  into children, inbound/outbound edges by kind, data shapes, projected
  `decided_by` decisions (projection only — never stored, see §4).
- `trace(entryRef, exitRef) -> hops[]` (`from`, `to`, `via` edge kind) —
  path over `calls` / `reads` / `writes` edges, annotated per hop.
- `decisionsAbout(ref) -> claims[]` (`decision`, `rationale`,
  `rejectedAlternatives`, `gate`, `evidence[]`, `caveats[]`) — the
  `whyDoesThisExist` shape in `src/io/decisions.ts:317-349`.
- `dataShapes(ref) -> shapes[]` (`id`, `name`, `definedAt`, `writtenBy[]`,
  `readBy[]`).

Named traversals (compositions — at least these four work end to end):

- `traceRequest(entryRef, exitRef)` = `trace` over `calls`, then
  `decisionsAbout` at each boundary hop on request.
- `explainBoundary(ref)` = `open(ref, 1)` + `decisionsAbout(ref)`:
  modules, edges by kind, and why the grouping exists.
- `explainDecision(ref)` = `decisionsAbout(ref)` against rejected
  alternatives, at the node it created. Reached by descent, never offered
  as an opening move.
- `followDataShape(shapeRef)` = `dataShapes` + `trace` through define,
  write, read, transform sites.

## 3. Navigation

Every node is walkable at all three levels. `open` descends, System
ascends; both preserve the learner's place (current ref + level +
trail). "Open that one" and "why is this boundary here" are first-class
moves.

## 4. Provenance rule

Every claim carries `gate` (`authored` | `derived` | `unresolved`) +
`evidence[]` (`file:line`, derived only) + `caveats[]`. Derived
language: "the scan found this at `src/x.ts:42`". Authored language:
"recorded by agent/human, reviewed/unreviewed". Unresolved subjects are
reported, never dropped. There is no confidence score — the evidence is
the report.

## 5. Abstraction-honesty rule

System level never leaks filenames, paths, or import detail. Module
level always uses real paths. Leaking the wrong granularity into the
wrong level is the failure mode; a Module without a path is reported
as such, never invented.

## 6. Narration rule

AI chooses presentation, learner chooses destination. No script, no
linear progression, no gating on answers. Presentation adapts to the
learner's stated goal; the learner picks where to go next.

## 7. MUST-NOT

- Do NOT fabricate rationale not in `arkive/architecture.json`.
- Do NOT guess at unrecorded alternatives.
- Do NOT present a derived element as chosen, or an authored element
  as scanned.
- Do NOT cite `services[]` / `connections[]` — computed view, not source.
- Do NOT invent a `confidence` figure.
- No quiz, no concept-mastery score, no progress bar anywhere in the flow.
