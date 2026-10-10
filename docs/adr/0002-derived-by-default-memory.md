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

The split is binary, not a gradient. An earlier draft of this ADR presented
derived / hybrid / authored as a completeness axis. It is not one, and the
layout invited readers to assume the middle column was cheaper work than the
right-hand end.

| Kind | Mechanically derived | Requires someone to have understood something |
|---|---|---|
| `module` | Directory tree, import graph (`src/analysis/scanner.ts:38-75` already walks it) | — |
| `external` | Third-party package identity — `normalizePackage` (`scanner.ts:77-89`) already returns exactly this | — |
| `datastructure` | Field names, types, and structure from type declarations | What the shape *means*, and which fields are load-bearing |
| `service` | A deployable boundary, where one is mechanically detectable (Dockerfile, serverless config, workspace package) | Whether this grouping is the *right* boundary, and what it is for |
| `datastore` | Migrations and schema files are evidence a datastore exists | "This is our primary datastore" is intent |
| `endpoint` | Route registration | Whether a route is public, internal, or deprecated |

Deriving a `service` boundary from a Dockerfile is evidence, not proof. A
parser that confidently emitted one for every detected artefact would produce
a confidently wrong graph, which is the single failure mode this ADR exists
to prevent.

### Edge kinds

| Kind | Mechanically derived | Requires someone to have understood something |
|---|---|---|
| `imports` | Import graph. Evidence: file and line per edge. | — |
| `calls` | Static call sites. Dynamic dispatch is not derivable and is an acknowledged limit. | — |
| `reads` / `writes` | Datastore access visible statically at a call site | Access patterns hidden behind an ORM — only the author knows |
| `derives_from` | — | Entirely. "This schema was derived from that one" is a claim no parser observes |
| `decided_by` | — | Entirely. Decisions are not derivable; `Alternative.whyNot` (`src/schema/architecture.ts:47-50`) is the artifact the product exists to preserve |

Three kinds are derivable. Three are not. `derives_from` and `decided_by` sit
at the same level of effort — both are assertions that nothing ever checks —
and neither is "later" or "weaker" than the other.

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

### The scanner's `src` assumption is a credibility bug, not a coverage bug

`src/analysis/scanner.ts:15` must scan the project tree with an explicit ignore
list (`node_modules`, `.git`, `dist`, build output, vendored directories),
configurable, defaulting to the whole tree. Under derived-by-default a missing
derivation does not produce a quiet report — it produces an empty graph that
*looks* correct.

An earlier draft of this ADR filed this as a coverage defect. It is worse than
that, and the distinction matters enough to state plainly:

**`reconcile` printed "No drift detected. arkive/architecture.json is in
sync." on documents it never examined.** "In sync" is an output people trust
without reading it — it is the one string in this product that a user acts on
without verifying. A scanner that silently scans nothing therefore does not
just miss drift; it asserts its absence with the full authority of the tool.

Three consequences, all now implemented:

1. The scan reports **coverage** — `parseCoverage`, `filesScanned`,
   `filesUnreadable`, `filesTruncated`. A partial parse never reports "in sync".
2. Drift findings carry a `conclusive` flag. `critical` now actually emits
   (`incomplete-scan`, `missing-manifest`, `dangling-edge`, `orphan-subject`).
3. Import rules are **suppressed rather than run on half-evidence**. A rule
   that fires on 40% of the files is worse than one that does not fire: it
   produces findings the user cannot trust.

`arkive status` and `arkive reconcile` exit non-zero when the scan is
inconclusive. **This changes CI behaviour for anyone gating on their exit
code** — it is the intended change, and it is called out here because it will
surface as a surprise otherwise.

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