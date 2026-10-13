# 0010 — Viewer re-architecture

status: done
stream: view
blocked_by: 0009
adr: docs/adr/0004-lightweight-viewer-re-engineered-downward.md

## Context

The maintainer's instruction: *"maybe a better running viewing experience. more
light weight. re engineer it."*

The current viewer is six React views on React Flow + D3 + Vite, under
`src/viewer/`. It is the largest surface in the repo and accounts for 5 of the
8 failing test files (`tests/viewer/*.test.tsx`, which import React from
`src/viewer/node_modules/react/index.js` — a path that does not exist, so they
have never passed). Measured on clean `bf89673`: 7 of 56 files failed, 5 of the
7 were viewer suites. It has its own React dedup problem (commit `d812126`
/ decision `dec-003`: React 18 vs 19 duplicate breaking hooks, resolved with Vite
aliases).

Under the vision, the viewer is the *smallest* of the three layers. It exists so
a human can see the structure without a terminal. It is not a product.

## Decision required

Evaluate and choose, with numbers:

- **(a)** Strip React Flow and D3, keep React, collapse to 2–3 views.
- **(b)** Build-free artifact — generate a single self-contained HTML file from
  the graph, no build step, no runtime dependencies. Graph render plus walkthrough.
- **(c)** Drop the viewer entirely; run walkthroughs through the agent
  conversation, which is where the maintainer actually wants the experience.

ADR-0004 should land this. Do not start implementation until it is decided.

## Constraints regardless of choice

- The viewer must never block a release. Build failure in the viewer is not a
  release blocker for CLI, MCP, or skills.
- It renders the graph from 0003 — topology, layers, and provenance — and hosts
  the walkthrough from 0009. Nothing else.
- It does not own the data. The JSON file is the source of truth; the viewer is
  a reader. Today `serve.ts` exposes a write API (`POST`, `DELETE`) with no
  auth — see 0013.
- Target is a stated budget, chosen in ADR-0004: bundle size, build step count,
  or dependency count. Whichever, it is measured and enforced in CI.

## Acceptance criteria

- [ ] ADR-0004 names the option, the budget, and the migration plan.
- [ ] Viewer renders the v2 graph including provenance.
- [ ] Walkthrough from 0009 is reachable from the viewer.
- [ ] Budget enforced in CI — a regression fails the build.
- [ ] Viewer build failure does not block CLI/MCP/skills release.
- [ ] The security findings in 0013 are resolved regardless of which option is
      chosen. An unauthenticated `ACAO: *` server on `0.0.0.0`
      (`serve.ts:25`, `serve.ts:160`) is not acceptable in any option — if the
      answer is (c), the hole disappears with the server.

## Caution

This viewer has been expanded rather than evaluated twice now. Six views for a
three-service document is over-built. The default failure mode here is another
half year of surface area. Hold the budget.