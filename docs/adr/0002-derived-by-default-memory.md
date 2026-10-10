# ADR-0002: Derived-by-default memory

## Status

Proposed

## Context

arkive's entire premise is structural memory. Today that memory is transcribed
by an LLM and then trusted, and the results are visible in three places.

**The confidence and provenance system is inert.** `src/schema/architecture.ts:34-35`
declares `source` and `confidence` on every service and connection. Two places
read them: `src/analysis/drift.ts:106-113` raises a `low-confidence` drift
warning, and `src/server/session-context.ts:37-41` adds a ⚠ marker. **No code
path in the repository ever writes either field.** They are absent from
`UpdateArchitectureInputSchema` (`src/server/tools.ts:24-42`) and
`RecordDecisionInputSchema` (`src/server/tools.ts:44-51`), which have no
confidence parameter of their own. They survive only because
`src/cli/commands/init.ts` injects an instruction telling the agent to set them
(`README.md:184`). So the drift warning fires if and only if an agent voluntarily
followed a markdown instruction — the same disease as the lifecycle rules, at a
smaller scale. Commits `61603e1` and `1411e8f` shipped machinery with no
producer.

**The instructions forbid the thing that would fix drift.**
`skills/core/architecture-tracker/SKILL.md:157` reads: *"Do NOT re-derive the
architecture from code if `arkive/architecture.json` exists — trust the
document."* This is the load-bearing instruction of the system and it is wrong:
it makes the document an authority over the code rather than a record of it, and
it converts every omission into permanent drift with no recovery path.

**Drift detection is on demand, narrow, and gives false assurance.**
`src/cli/commands/reconcile.ts:25-31` runs `scanProject` and prints
*"No drift detected. arkive/architecture.json is in sync."* when there are no
warnings. But `src/analysis/scanner.ts:15` hardcodes
`scanImports(join(dir, "src"))` — for a project whose source lives in `app/`,
`lib/`, or `packages/*/src`, `scanImports` returns `[]`
(`src/analysis/scanner.ts:39`), the dependency set is small, every warning loop
finds nothing, and reconcile reports a clean bill of health on a document it
never examined. The scanner also derives `untracked-service` from string
containment between a package name and a `service.technology` string
(`src/analysis/drift.ts:132-141`), which is a heuristic that silently goes quiet
rather than going wrong. `DriftSeverity` includes `"critical"`
(`src/analysis/drift.ts:4`) but no code path ever emits it — `finalize`
(`src/analysis/drift.ts:143-157`) initialises the counter to zero and nothing
writes to it.

**The write path grows without bound.** `handleUpdateArchitecture` pushes a
history entry on every call (`src/server/tools.ts:233-238`) and
`writeArchitecture` writes a full-document snapshot on every write
(`src/io/architecture-file.ts:97-101`, `:108-118`). The cure for context rot
reproduces context rot.

## Decision

**Static analysis owns structure. Agents and humans own intent. Anything
structurally derivable from the code is derived, never transcribed.**

### Node kinds

| Kind | Status | Derivation |
|---|---|---|
| `module` | **Derived** | Directory tree plus import graph. `src/analysis/scanner.ts:38-75` already walks the tree; it needs to stop assuming `src` (see below). |
| `external` | **Derived** | A third-party package the project imports. Already available: `normalizePackage` (`src/analysis/scanner.ts:77-89`) returns exactly this. |
| `datastructure` | **Derived** | Type declarations and schema files. |
| `service` | **Hybrid** | Derived *only* when a deployable artifact boundary is detectable (Dockerfile, serverless config, workspace package). Otherwise authored. |
| `datastore` | **Hybrid** | Migrations and schema files are derived evidence that a datastore exists; "this is our primary datastore" is intent and is authored. |
| `endpoint` | **Hybrid** | Route registration is derived; whether a route is public, internal, or deprecated is authored. |

Hybrid is honest, not a hedge. A `service` boundary is a human decision, and
pretending the parser can find one would produce a confidently wrong graph.

### Edge kinds

| Kind | Status | Derivation |
|---|---|---|
| `imports` | **Derived** | Import graph. Evidence: file and line per edge. |
| `calls` | **Derived** | Static call sites. Dynamic dispatch is not derivable and is the acknowledged limit. |
| `reads` / `writes` | **Hybrid** | Derived when datastore access appears statically at a call site; authored when it sits behind an ORM, where only the author knows the access pattern. |
| `derives_from` | **Authored** | "This schema was derived from that one" is a decision, not something a parser observes. |
| `decided_by` | **Authored** | Projection of `decision.subjects` (ADR-0001). |

### Provenance is per element, and mandatory

Every node and edge carries exactly one of:

- **Derived:** `derived: true`, `rule: <rule-id>`, `evidence: string[]`
  (`file:line`). Evidence is an array because an import edge between two
  directories has many sites, and `src/analysis/scanner.ts:42-56` already
  visits them all.
- **Authored:** `authoredBy: "agent" | "human"`, `reviewedAt?: ISO-8601`.

The optional `confidence: number` field is **deleted**. A self-assessed scalar
that nothing sets and two call sites read is worse than no field: it produced a
drift warning that could never fire. Provenance that is structurally impossible
to omit replaces it.

### Drift detection becomes continuous, and mostly disappears

The derived half is regenerated on every scan, so it cannot drift. There is
nothing to reconcile. `arkive reconcile` is retained as a **one-shot
`arkive check`** that reports only what derivation cannot cover:

1. An authored node whose kind is derivable but which has no derivation.
2. A decision whose `subjects[]` no longer resolve — a decision that explains
   something that no longer exists.
3. A node derived in a previous run that the current run cannot reproduce.

Everything else — "you imported a package we don't know", "your stack lists a
framework that isn't a dependency" — is either derived or gone.

`arkive watch` runs the same derivation on change. The `post-commit` git hook is
removed (ADR-0005).

### The scanner's `src` assumption becomes a correctness bug

`src/analysis/scanner.ts:15` must scan the project tree with an explicit ignore
list (`node_modules`, `.git`, `dist`, build output, vendored directories),
configurable, defaulting to the whole tree. Under derived-by-default a missing
derivation does not produce a quiet report — it produces an empty graph that
*looks* correct. A silent omission in a derived system is indistinguishable from
a fact, which is the one failure mode that must never exist here.

### The `trust the document` instruction is deleted

`skills/core/architecture-tracker/SKILL.md:157` is replaced. The new rule is the
opposite: structure is never transcribed; the agent records intent only, and
every structural fact comes from derivation.

### Bounded growth

`history[]` is capped at 50 entries with an explicit `historyTruncated: true`
flag; snapshots are deduplicated by content hash and capped at 10 distinct
states. The durable record is git, not the JSON file. See ADR-0006 for the
write mechanics.

## Consequences

### Positive

- The document cannot drift structurally, because nothing structural is stored.
- `low-confidence` drift warnings are replaced by provenance that cannot be
  absent, so `src/analysis/drift.ts:104-116` and the ⚠ branch at
  `src/server/session-context.ts:39-41` get deleted rather than kept on the hope
  that an agent fills in a number.
- Session context shrinks: derived edges do not need to be narrated, only
  referenced.
- Reconcile stops being a chore nobody runs
  (`docs/issues/0007`) and becomes a diagnostic that has something real to say.
- Provenance is auditable: "why is this node here" is answered by `rule` and
  `evidence`, not by a number.

### Negative

- **Static analysis is never complete.** Dynamic dispatch, reflection, runtime
  plugin loading, and DI containers produce no `calls` edges. The graph will be
  incomplete, and users will find the gaps. The mitigation is that authored
  edges can fill them, with honest provenance.
- **The hybrid kinds require judgment on every scan.** Deriving `service`
  boundaries when a Dockerfile exists, and not when it does not, means derivation
  behaviour differs per project and must be tested per project.
- **Deletes a shipped feature.** `source` and `confidence` disappear. Anyone
  relying on them loses a field. They never worked, so the population is small.
- **The instruction reversal is behavioural.** Agents trained by
  `SKILL.md:157` to trust the document will now be told to derive it. That
  requires deleting the skill text, not amending it (ADR-0005).

## Alternatives considered

**Keep transcription, improve drift detection — better rules, richer heuristics.**
Rejected. It makes correctness a function of parser coverage against an LLM's
transcription. Every heuristic added is a heuristic that silently returns nothing
on an unusual codebase, which is how `src/analysis/scanner.ts:15` already fails.
This keeps the failure mode and adds maintenance cost.

**Hybrid — derive cheap structure, let the agent transcribe the rest.**
Rejected. This is status quo with better labelling. Once any structure is
transcribed, its correctness becomes a maintenance task, and the system is back
to needing reconcile. The split must be along the derived/authored line, not
along the easy/hard line.

**Keep `confidence` but make it mandatory and auto-populate it.**
Rejected. It fixes the "nothing sets it" defect without fixing the underlying
one: a number an LLM assigns to itself is not evidence. `evidence: ["file:line"]`
is.

**Call an LLM to detect drift and propose repairs.** Rejected by
`docs/VISION.md:115-117` as a decided non-goal, and rejected independently:
confidently wrong repairs destroy determinism and offline operation.

**Derive everything, including decisions, by mining commit messages.**
Rejected. Commit messages record what changed, not what was rejected and why.
`Alternative.whyNot` (`src/schema/architecture.ts:47-50`) is the artifact that
cannot be derived, and it is the one the product exists to preserve.

## Related

- ADR-0001 — the graph this derives into.
- ADR-0005 — hooks that run derivation without asking the agent.
- `docs/issues/0005`, `0006`, `0007` — module derivation, data structure
  extraction, continuous reconciliation.