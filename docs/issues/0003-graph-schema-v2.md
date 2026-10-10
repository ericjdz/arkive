# 0003 — Graph schema v2

status: open
stream: graph
blocks: 0004, 0005, 0006, 0008, 0010
blocked_by: 0001, 0002
adr: docs/adr/0001-graph-first-architecture-document.md

## Context

The current schema (`src/schema/architecture.ts`) models a project as
`services[]` with `dependencies: string[]` plus a flat `connections[]`. That
captures *pieces* but not *structure*. The vision requires a connected graph
with typed nodes and typed edges, where decisions attach to the graph elements
they produced.

The repo's own dogfood makes the gap concrete: `arkive/architecture.json`
records 3 services (`cli`, `viewer`, `architecture-store`) for a codebase
containing an MCP server, HTTP server, schema layer, learning subsystem,
scanner, drift engine, template system, prompt queue and snapshot store. At
service granularity the real system is invisible.

## Scope

Define the v2 graph schema. Do not implement persistence — that is 0004.

1. **Node types.** `module`, `service`, `datastore`, `external`,
   `datastructure`, `endpoint`. Each node carries: `id`, `kind`, `name`,
   `summary`, optional `tech`, optional `path` (for `module`), optional
   `owner`, and provenance (`source`: `derived | agent-authored |
   human-verified`, `confidence`: 0–1, `derivedAt`, `evidence`).

2. **Edge types.** `imports`, `calls`, `reads`, `writes`, `derives_from`,
   `decided_by`. Each edge carries `from`, `to`, `kind`, optional `protocol`,
   optional `note`, and the same provenance block as nodes.

3. **Provenance on everything — per ADR-0002, not the existing model.** The
   current `source` / `confidence` pair is **inert**: declared on every service
   and connection (`src/schema/architecture.ts:34-35`), read in two places
   (`src/analysis/drift.ts:106-113`, `src/server/session-context.ts:37-41`), but
   **written by no code path**. They only populate if an agent voluntarily
   follows a markdown instruction — the same disease as the lifecycle rules, at
   a smaller scale. Commits `61603e1` and `1411e8f` shipped machinery with no
   producer.

   ADR-0002 therefore **deletes `confidence` entirely** and replaces it with
   provenance that is structurally impossible to omit:
   - **Derived:** `derived: true`, `rule: <rule-id>`, `evidence: string[]`
     of `file:line`.
   - **Authored:** `authoredBy: "agent" | "human"`, `reviewedAt?: ISO-8601`.

   A self-assessed scalar that nothing sets is worse than no field: it produced
   a drift warning that could never fire. `evidence: ["src/x.ts:42"]` is
   evidence; `confidence: 0.8` is not. Implement ADR-0002's model here.

4. **Decisions gain graph links.** `relatedServices: string[]` becomes
   `relatedNodes: string[]` plus optional `relatedEdges: string[]`.

5. **Migration.** `services[]` → `node[]` (kind `service`), `connections[]` →
   `edge[]`, `dependencies[]` → `imports` edges. Define the exact transform
   and its version bump. The `version` field currently defaults to `"1.0.0"`
   and drives nothing — 0004 must make it real.

6. **Invariants.** Enforce: no dangling edge endpoints; no duplicate node `id`;
   `decided_by` edges must reference an existing decision; deletion of a node
   cascades or is rejected, never silently orphaned.

7. **Unknown-key preservation.** Zod v4 `z.object()` strips unknown keys, and
   `writeArchitecture` writes the validated output. A user who adds a custom
   field loses it silently. Decide and specify the preservation strategy here
   so 0004 can implement it — likely `.passthrough()` on the user-extensible
   containers.

## Out of scope

Persistence, migration execution, the `services` projection (0004), derivation
(0005), viewer changes.

## Acceptance criteria

- [ ] `src/schema/graph.ts` exports `NodeSchema`, `EdgeSchema`, `GraphDocument`,
      and a top-level `ArchitectureDocumentV2Schema`.
- [ ] `services`/`connections` remain in the schema, marked deprecated, so
      0004 can project them during migration.
- [ ] Semantic validation runs beyond shape: dangling refs, duplicate ids,
      `decided_by` integrity. Follow the existing pattern in
      `src/schema/validate.ts`.
- [ ] `.passthrough()` (or equivalent) on containers that accept user extensions,
      with a test proving a custom field survives a read/write cycle. (See
      ADR-0006 — write the *original parsed object*, not the validated one.)
- [ ] Provenance matches ADR-0002: `derived` / `rule` / `evidence[]` for derived
      elements, `authoredBy` / `reviewedAt` for authored ones. No `confidence`
      field survives the migration.
- [ ] `version` becomes a real, defaultless integer. It is currently
      `z.string().default("1.0.0")` (`src/schema/architecture.ts:97`) and drives
      nothing — nothing in the repo has ever branched on document shape. It is
      the entire safety mechanism once ADR-0006's migration probe exists, so it
      cannot stay decorative.
- [ ] Pure `migrate(v1) -> v2` function with unit tests covering: empty doc,
      populated doc, doc with existing decisions, doc with no services.
- [ ] Migration is lossless — a test asserts no `id` from v1 is absent in v2.
- [ ] `npm run lint` and `npm test` pass.

## Notes

`src/index.ts:1` currently re-exports `ArchitectureSchema` from a module that
does not export it. Whatever lands here must be exported cleanly from the
package entry point — that is issue 0001's fix, but do not regress it.