# 0008 — Decision attachment

status: done
stream: record
blocks: 0009
blocked_by: 0004

## Context

Vision layer 1 has three parts and this is the first one: **Record**.

Today a decision is `{ id, topic, decision, rationale, alternatives[], timestamp, relatedServices[] }`. `relatedServices` is a list of string IDs that a human must maintain by hand. Nothing connects a decision to the structure it produced, so *"why does this exist"* is a text search across rationale strings rather than a traversal.

The schema already supports `decided_by` edges (0003). This issue makes the system generate them, and makes the decision record attach automatically at the moment the structure is created.

The repo's own lost document had exactly the decision this feature exists to make durable — `dec-003`: *force React 19 via Vite aliases to deduplicate with the root project*, with `whyNot: "would still cause duplicate React instances since root has React 19"`. That is a real decision with a real rejected alternative. It survived in a file that got orphaned by a path migration.

## Scope

1. **Attach at creation.** When `update_architecture` adds a node or edge, if a decision was recorded in the same operation, emit the `decided_by` edge automatically. The human should never hand-maintain the link.
2. **Backfill.** `relatedServices: string[]` → `relatedNodes`/`relatedEdges`, resolved through the graph so a decision attaching to a node implicitly reaches its module children.
3. **Confidence gates.** A decision attached to a derived (inferred) node is a
   different claim from one attached to a human-verified node. Represent that.
4. **Require a rejected alternative.** The schema already enforces
   `min 1` on alternatives (commit `f8add27`). Keep it. A decision with no
   rejected alternative is usually an observation, not a decision — surface
   that distinction rather than encoding it silently.
5. **Query.** "Why does this module exist" resolves in one traversal. Add it as
   an MCP resource or tool.

## Out of scope

Walkthrough narration of decisions (0009). The viewer's decision log view
(0010).

## Acceptance criteria

- [ ] Creating a node with an accompanying decision produces a `decided_by`
      edge with no manual linking step.
- [ ] A decision on a parent node is discoverable from its module children.
- [ ] `whyDoesThisExist` returns the decision, its rationale, its rejected
      alternatives, and the provenance of every claim in it.
- [ ] Every claim in a returned decision carries its provenance.
- [ ] `npm run lint` and `npm test` pass.

## Note

ADR-0001 and ADR-0006 both constrain this. The attach-at-creation path writes
to the user document — 0013's atomicity and unknown-key invariants apply from
the first line.