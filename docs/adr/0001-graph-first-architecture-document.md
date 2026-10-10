# ADR-0001: Graph-first architecture document

## Status

Proposed

## Context

The v1 document models a project as `services[]` with `dependencies: string[]`
plus a flat `connections[]` (`src/schema/architecture.ts:26-45`,
`src/schema/architecture.ts:106-107`). Four structural problems follow from that
shape, and none of them are fixable by adding fields.

**1. `dependencies[]` duplicates `connections[]`, and they disagree.** The
orphaned root `architecture.json:23` gives `cli` the dependencies
`["templates", "schema", "mcp-server", "scanner"]`, while
`architecture.json:74-110` declares the same four relationships as separate
connection objects. The same fact is stored twice with no reconciliation.
Worse, the direction is undefined: `skills/core/architecture-tracker/SKILL.md:83`
defines the field as "ids-of-services-this-depends-on", but
`architecture.json:23` is a list of things `cli` *uses*, and there is no way to
represent what depends on `cli`. Two readers will disagree about what the array
means and neither will be able to prove it.

**2. An edge has no type.** `ConnectionSchema.protocol` is
`z.string().min(1)` (`src/schema/architecture.ts:41`) — free text. "HTTP/REST",
"GraphQL", "function call" and "filesystem" all occupy the same field. The only
thing that distinguishes a call from a read from a write from a derivation is
the prose in `description`. The system literally cannot answer "what reads this
datastore", which is the second question `docs/VISION.md:35-39` names as the one
that matters.

**3. Decisions cannot be attached to what they produced.**
`DecisionSchema.relatedServices` is `z.array(z.string()).default([])`
(`src/schema/architecture.ts:59`). A decision that created an edge names a
service id, so it survives the edge's removal but points at nothing. Delete the
edge via `removeConnectionKeys` (`src/server/tools.ts:193-198`) and the decision
is silently orphaned while remaining in the array. "Why does this exist" cannot
be a traversal, which `docs/VISION.md:43-44` requires it to be.

**4. The validation rules are prose.** `AGENTS.md` §"Rules of the Road" requires
that every `connection.from`/`to` reference an existing `service.id`. No code
path checks it. `handleUpdateArchitecture` validates `relatedServices` against
service ids (`src/server/tools.ts:263-267`) but validates nothing about
connections, and `detectDrift` (`src/analysis/drift.ts:44-119`) never checks
referential integrity either — its four rules are about `package.json`
dependencies and low-confidence flags.

The cost is visible in arkive's own document. `arkive/architecture.json` records
3 services for a codebase containing an MCP server, an HTTP server, a schema
layer, a learning subsystem, a scanner, a drift engine, a template system, a
prompt queue and a snapshot store. At service granularity the real system is
invisible.

## Decision

**The document becomes a typed node/edge graph. This is a breaking change,
`schemaVersion: 2`.**

### Node kinds

`module`, `service`, `datastore`, `external`, `datastructure`, `endpoint`.

Each node carries `id`, `kind`, `name`, and `provenance` (see ADR-0002). The
`type` enum from `ServiceSchema` (`src/schema/architecture.ts:3-16`: `frontend`,
`backend`, `cache`, `queue`, …) is **deleted**. It is a taxonomy of deployment
concerns that overlaps `kind` and answers none of the structural questions. A
cache is a `datastore`; a queue is a `datastore` with an `endpoint` on it.

### Edge kinds

`imports`, `calls`, `reads`, `writes`, `derives_from`, `decided_by`.

Edges are first-class objects with `id`, `from`, `to`, `kind`, and an optional
`label` (free text, kept only for transport naming — `"HTTP/REST"`,
`"stdio"`, `"TCP/SQL"`). `label` is never used for semantics; `kind` is.

### Decisions own their subjects

`Decision` gains `subjects: Array<{ kind: "node" | "edge", ref: string }>`,
replacing `relatedServices`. A `decided_by` edge is a **projection**: emitted by
joining `decision.subjects` against the graph, never stored. Consequences:

- Removing an edge cannot orphan a decision, because the decision never pointed
  at the edge row — it pointed at an id that simply stops resolving.
- Removing a node cannot destroy rationale.
- A decision whose subject no longer exists is detectable (`subjects[]` entry
  that resolves to nothing) and is reported, not deleted.

### `services` survives as a computed projection, never stored

`services[]` is removed from the document. `project(services: Service[])` is a
pure function of the graph, exposed at the existing consumers:

| Consumer | Current | v2 |
|---|---|---|
| `src/server/resources.ts:113-122` (`architecture://services`) | returns `arch.services` | returns `projectServices(graph)` |
| `src/viewer/src/App.tsx:151-172` | `data.services` | projection at fetch time |
| `src/learning/questions.ts:59-102` | `arch.services` | projection (then deleted, ADR-0003) |
| `src/cli/commands/export.ts:22-26` | `generateMermaid(arch.services, arch.connections)` | projection |

No dual source of truth. Nothing is written twice, so nothing can disagree.
Existing clients keep working because the *resource shape* is unchanged even
though the *storage shape* is not.

### Node deletion

A node is never hard-deleted in one step, because edges reference it.

`removeNode(id)` performs, in a **single transactional write** (ADR-0006):
tombstone `nodes[id].deletedAt = now`, drop every edge where `from` or `to` is
`id`, leave all decisions and their `subjects` untouched, and append a `history`
entry naming the node and the exact count of edges dropped.

This extends the existing cascade in `src/server/tools.ts:182-191`, which
already removes connections and dependency entries when a service id is
removed — but that cascade is silent. The v2 cascade is recorded.

### Versioning policy

- `version: z.string().default("1.0.0")` (`src/schema/architecture.ts:97`) is
  **replaced** by `schemaVersion: z.number().int()` with **no default**. An
  integer with no default means a v1 document fails to parse immediately and
  loudly. The current field is decorative — it is defaulted, never read as a
  discriminator, and only echoed back by `src/server/resources.ts:100`.
  A semver string with a default is the worst of both: it parses successfully
  under the wrong reader and is silently ignored.
- **Major** (`2` → `3`): breaking. Requires an explicit `migrate(vN) -> vN+1`.
- **Minor**: additive only — new optional node kinds, new optional edge kinds,
  new optional fields. Readable by any older v2 reader, because the projection
  layer means consumers never see unknown fields.
- An unknown major is a **hard error**, never a best-effort parse.
- Migrations are pure functions, applied in memory on read, persisted only on an
  explicit write. A read must never rewrite the file.

### `migrate(1) -> 2`

1. Each `services[]` entry → `nodes[]` with `kind: "service"`, `name` and
   `description` preserved, `type` dropped.
2. Each `dependencies[]` entry → an `imports` edge.
3. Each `connections[]` entry → an edge with `kind: "calls"`, `label: protocol`.
   An edge whose `from`/`to` does not resolve to a node is migrated as an
   **orphan edge** with `dangling: true`, preserving the dangling reference
   instead of dropping it. Dropping it is the same class of silent data loss as
   `62066bc` (ADR-0006).
4. Each `decisions[].relatedServices` → `subjects[]`, filtered to ids that
   resolve; unresolvable ids are preserved in `subjects` anyway, because
   `record_decision` at `src/server/tools.ts:263-267` may have accepted them
   before the graph existed.
5. `dataFlows[]` and `history[]` carry over unchanged.

6. **Migrated elements are `authoredBy: "agent"`, never `derived: true`.** A
   migration runs no analysis. Claiming a derivation rule produced something
   no rule ever saw would be a fabrication, and it would be a fabrication
   baked into every migrated document permanently. The provenance a user
   inherits must be the one that is actually true.

`flows` stays a separate authored array in v2. A data flow is an ordered
narrative, not a graph element, and it is consumed as one
(`src/viewer/src/views/DataFlowView.tsx`,
`src/learning/questions.ts:144-165`). Modelling it as a path through the graph is
correct and is not a v2 requirement; recording it as a wart is better than
forcing it into a shape that does not fit.

### On `decided_by` not being stored

Storing decisions as `subjects` means "which decision explains the *absence*
of an edge" is unanswerable, and that is accepted. The same reasoning applies
to `derives_from`, which ADR-0002 classifies as authored: it is an assertion
a derivation cannot confirm and nothing ever checks it.

That is not an argument against the projection. Decisions genuinely are not
derivable. It is a note that `decided_by` is not special — it is one of two
edge kinds with no derivation path at all, and ADR-0002's table is formatted
as a binary precisely so the other one is not mistaken for cheaper work.

## Consequences

### Positive

- The second question from `docs/VISION.md:35-39` becomes answerable by
  traversal: filter edges where `kind ∈ {reads}` and `to = datastore.id`.
- Decisions survive every deletion path, because they are not stored as edges.
- Consumers keep their input shape via projection, so the migration is
  contained to `src/schema/`, `src/io/`, and `src/server/`.
- `dependencies[]` stops being a second, contradictory copy of the truth.
- The `type` enum stops being a taxonomy that must be extended by hand every
  time someone ships a new kind of infrastructure.

### Negative

- **This breaks every document in the wild.** Anyone who upgrades and runs a v2
  binary against a v1 file without the migrator fails hard. Mitigated by
  shipping `migrate(1) -> 2` in the same release as the reader, and by the
  migration guard in ADR-0006.
- **Deriving `service` boundaries is not free.** A `module` is a directory; a
  `service` is a judgment. The graph schema admits `service` nodes but v2 does
  not derive them — see ADR-0002 for which kinds are derivable and which are
  authored. On day one, service-boundary derivation is unimplemented and those
  nodes are authored, which means the migration above is the honest starting
  point and not the destination.
- The projection layer is code that exists to serve legacy shapes. It has an
  end date: delete it when `docs/issues/0010` completes.

## Alternatives considered

**Additive-only — keep `services[]`, add `nodes[]`/`edges[]` alongside.**
Rejected. Two arrays describing the same system is the exact defect that
produced the contradiction between `architecture.json:23` and
`architecture.json:74-110`. Additive-only also forces every one of the eight MCP
tools (`src/server/tools.ts:86-132`), six viewer views
(`src/viewer/src/App.tsx:151-179`), four quiz generators
(`src/learning/questions.ts:167-175`) and the mermaid exporter to branch on two
document shapes forever, and there is no forcing function that ever removes the
old branch.

**Keep `services[]` as a stored array maintained alongside the graph.** Rejected.
This is the dual-source-of-truth failure with extra steps. Two writers, no
reconciler, guaranteed divergence.

**Model `services` as nodes but leave `connections` free-text.** Rejected. This
is a rename, not a change of model. The absence of edge types is the defect
(`src/schema/architecture.ts:41`), and renaming does not create them.

**Store `decided_by` edges directly on the graph.** Rejected. It puts decisions
in the blast radius of node deletion (this ADR's deletion section), and it makes
"which decision explains the absence of an edge" unanswerable, because the
decision no longer exists anywhere.

**Adopt an existing graph format — JSON-LD, RDF, or a graph database.** Rejected.
The moat is a git-committed local file (`docs/VISION.md:113-114`). A graph
database cannot be committed, diffed, or reviewed in a pull request, and every
one of them is strictly heavier than the problem.

## Related

- ADR-0002 — which node and edge kinds are derived versus authored.
- ADR-0006 — the migration guard and transactional writes this schema depends on.