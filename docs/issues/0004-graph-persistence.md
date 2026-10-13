# 0004 — Graph persistence and projections

status: done
stream: graph
blocks: 0005, 0006, 0008
blocked_by: 0003, 0013

## Context

The schema lands in 0003. This issue makes it real on disk: reading, writing,
versioning, migrating, and keeping the old `services` view available.

Today `src/io/architecture-file.ts` reads and writes a flat v1 document with no
version logic — `version` is a decorative string that defaults to `"1.0.0"` and
drives nothing. There is no migration path because there have only ever been
one shape.

## Scope

1. **Version-aware IO.** `readArchitecture` detects the document version and
   routes to a migration chain. `writeArchitecture` stamps the current version.
   Bump to `2.0.0`.
2. **Migration chain.** Registry of `migrate(vN) -> vN+1` transforms, applied in
   order on first read of an older document, with the result written back only
   on the next real write — never as a side effect of a read.
3. **Migrate on write, not on read.** Reading must be side-effect-free. A read
   that rewrites the file is how you lose data to a tool the user ran while
   curious.
4. **The `services` projection.** Maintain the deprecated top-level
   `services[]` / `connections[]` as a *derived* view over the graph, so v1
   consumers and the `arkive-init` / `architecture-tracker` skills keep working
   during the transition. Mark them clearly as derived in the schema. Decide
   honestly whether this projection survives v0.3 or is deleted once consumers
   migrate — and if it survives, it must never be authored directly, because a
   hand-editable derived field is a drift source.
6. **History bounding.** `history[]` appends on every write and never prunes.
   Per ADR-0002: cap at **50** entries with an explicit `historyTruncated: true`
   flag, so truncation is never silent. Archive the overflow somewhere not read
   at session start. An unbounded document the agent is told to read every
   session is the context rot the product claims to cure.
7. **Snapshot policy.** Deduplicate snapshots by **content hash**, not by
   timestamp — `saveSnapshot` (`architecture-file.ts:112-117`) replaces only
   `:` in `lastUpdated`, leaving `.` intact, so two writes in the same
   millisecond collide. Cap at 10 distinct states. The durable record is git,
   not the JSON file.

## Out of scope

Deriving the graph from code (0005). `decided_by` edge generation (0008).
Walkthroughs (0009).

## Acceptance criteria

- [ ] Reading a v1 document returns a v2 in-memory graph with no file writes.
- [ ] The next write persists v2 and the v1 fields survive as projections.
- [ ] Migration is covered by fixtures in `tests/fixtures/` for v1-empty,
      v1-populated, v1-decisions-only.
- [ ] A round-trip write never loses a node, edge, or decision.
- [ ] `history` is capped and the archive path is excluded from session context.
- [ ] `npm run lint` and `npm test` pass.

## Risk

This is the highest-risk issue in the wave: it is the only place that writes
user data, and 0013's invariants land in the same place. If 0013 is not
genuinely done, do not start this — write the invariant tests first, in 0013.