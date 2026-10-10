# 0007 — Continuous reconciliation

status: open
stream: derive
blocked_by: 0005

## Context

Drift detection is currently an on-demand command: `npx @ericjdz/arkive
reconcile`. Nobody runs it. The auto-reconcile hook that was supposed to run it
calls `reconcile --quiet`, an option that does not exist, and swallows the
failure.

A derived-first model (ADR-0002) changes the economics entirely. If structure
is derived from code rather than transcribed, then reconciliation is not a
separate maintenance task — it is a consequence of derivation. The derived
half of the graph is always current by construction. Only the authored half
(d(intent, rationale, rejected alternatives) drifts, and drift there is
semantic, not structural.

## Scope

1. **Split the graph by derivation status.** Derived nodes and edges refresh
   on every scan. Authored nodes and `human-verified` provenance never
   overwrite. The split is what makes continuous refresh safe.
2. **Watch mode.** `arkive watch` — scan on change, update the derived half,
   report deltas. This replaces the post-commit hook, which cannot block
   anything and ran unpinned remote code on every commit.
3. **Authored-drift detection.** The signal that matters: an authored claim that
   the code no longer supports. A `human-verified` service whose technology
   has disappeared from `package.json` is a real problem. A `derived` node that
   moved is not a problem, it is Tuesday.
4. **Orphan detection.** A node a human verified, which the derivation no longer
   produces. Ask, never delete.
5. **Report as a delta, not a wall.** The useful output is "3 nodes added, 1
   human-verified node no longer supported" — not a full redump.

## Out of scope

LLM-based semantic drift comparison (explicit non-goal). Watch mode for the
walkthrough.

## Acceptance criteria

- [ ] `arkive watch` updates derived nodes on change without touching authored
      ones. Test asserts an authored node survives 100 reconcile cycles.
- [ ] A human-verified node whose technology vanishes from `package.json`
      raises `critical` and names the node.
- [ ] Output is a delta.
- [ ] No unpinned remote code executes.
- [ ] `npm run lint` and `npm test` pass.