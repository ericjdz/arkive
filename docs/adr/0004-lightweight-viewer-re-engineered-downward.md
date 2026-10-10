# ADR-0004: Lightweight viewer, re-engineered downward

## Status

Proposed

## Context

`docs/VISION.md:76-85` puts the viewer last of the three layers: "deliberately
the smallest", "exists so a human can *see* the structure without a terminal, not
as a product in its own right", "the target is a build-free artifact that renders
the graph and nothing else." This ADR picks how. It has been deferred twice, so
the evidence is stated in full and the target is numeric.

### The test evidence

Measured on `master` at `bf89673`:

```
npm test
  Test Files  8 failed | 48 passed (56)
       Tests  3 failed | 283 passed | 1 skipped (287)
```

All five **suite-level** failures are viewer tests. They fail at collection with
`Failed to resolve import "../../src/viewer/node_modules/react/index.js"`:

| Failing file | Dead import |
|---|---|
| `tests/viewer/decision-log.test.tsx` | `:3-5` |
| `tests/viewer/topology.test.tsx` | `:3-5` |
| `tests/viewer/tree-view.test.tsx` | `:3-5` |
| `tests/viewer/prompt-input.test.tsx` | `:3-5` |
| `tests/viewer/prompt-queue-panel.test.tsx` | `:3-5` |

`src/viewer/node_modules` does not exist and never has: `src/viewer/package.json`
is a second, independent package manifest that `npm install` at the root does not
cover. So these five files have never once passed. The other six viewer tests
(`ConceptMap`, `ProgressTracker`, `QuestionCard`, `QuizPanel`, `search`,
`stack-view`) import `react` from the root instead and do run — the viewer test
suite is written in two mutually incompatible styles and only one of them works.

> **Concurrent work, observed 2026-10-11.** The numbers above were measured on a
> clean tree at `bf89673`. While this ADR was being written, uncommitted changes
> appeared in the working tree that repair the *other* half of this problem: the
> five test files were rewritten to import `react` / `react-dom` from the root
> (`tests/viewer/topology.test.tsx:3-4` and the four siblings), `vitest.config.ts`
> gained `resolve.dedupe` plus root-`react` aliases and `server.deps.inline:
> ["@xyflow/react"]`, and `tsconfig.json` was changed to **exclude** `src/viewer`
> and `tests/viewer` from `include`. That is the `docs/issues/0001` "Toolchain and
> CI green" track.
>
> This does not change the decision, and it is worth being precise about why. The
> concurrent work makes the tests pass by pointing them at the root React — it does
> not remove the nested `package.json`, the Vite build, or the duplicate-React
> problem that produced `dec-003`; it makes the test harness work around the same
> condition the application needs a workaround for. The tsconfig exclusion is, if
> anything, evidence for this ADR: something else has already concluded that the
> viewer should be outside the type-checked build. **If that track lands first,
> step 1 of the migration below (delete the five files) becomes trivial** rather
> than being blocked — the files will be passing and still should be deleted,
> because step 5 removes what they test.

The other three failures (`tests/cli/init.test.ts`,
`tests/cli/serve.test.ts`, `tests/install/install-sh.test.ts`) are not viewer
tests and are out of scope here.

### The build is broken, not just heavy

- `src/viewer/vite.config.ts:23-24` sets `outDir: ../../dist/viewer` with
  `emptyOutDir: true`.
- `scripts/build.mjs:29-35` cleans `src/viewer/dist`, then checks
  `existsSync(src/viewer/dist)` to copy it into the package. Vite never creates
  that path, so those branches are dead.
- `tsup.config.ts:9` emits declarations with `--rootDir src` across four entry
  points, which produces `dist/viewer/src/utils/markdown.d.ts` — the same
  directory Vite then empties.

Verified on disk: `dist/viewer/` contains four `.d.ts` files and **no**
`index.html` and **no** `assets/`. The Vite step has produced nothing, and if it
had run it would have deleted tsup's declaration output. `src/viewer/dist` does
not exist.

### The size and the coupling

- 33 source files under `src/viewer/`, 6 views (`src/viewer/src/App.tsx:151-179`).
- 11 dependencies in `src/viewer/package.json`: `@xyflow/react`, `d3`, `dagre`,
  `react`, `react-dom`, plus 6 devDependencies.
- 11 test files.
- `dec-003` in the orphaned root `architecture.json:142-154` records a real
  decision: React 19 had to be forced via Vite aliases and `dedupe`
  (`src/viewer/vite.config.ts:10-16`) because a nested viewer package produced a
  duplicate React that broke hooks. A decision was spent on a build problem this
  ADR deletes.
- **The CLI depends on viewer source.** `src/cli/commands/export.ts:3-4` imports
  `../../viewer/src/utils/markdown.js` and `../../viewer/src/utils/mermaid.js`.
  Those two files import nothing (they are pure functions), so this is a coupling
  of *location*, not of React. But it means the viewer directory cannot be
  deleted without touching the CLI's export feature.

## Decision

**Option (b): replace the React viewer with a single-file, build-free HTML
artifact generated from the graph.**

`arkive export html` (or `arkive view`) reads the document, lays out the graph,
and writes one self-contained `arkive/graph.html`: inline CSS, inline SVG, the
graph data inlined as JSON, and vanilla JS for pan/zoom and node selection.
No bundler, no framework, no runtime dependency, opens from `file://`.

### Targets

| Metric | Today | Target |
|---|---|---|
| Runtime dependencies | 11 | **0** |
| Build step | Vite + tsup collision | **none** — `npm run build` runs tsup only |
| Artifact | Vite bundle + assets dir + index.html | **one file** |
| Uncompressed size | Vite bundle (React Flow + D3) | **≤ 150 KB** |
| External network requests | 0 (once loaded) | **0** |
| Test files | 11 | **2** |
| Source files | 33 | **≤ 4** |

The two tests are a layout test (positions are deterministic and stable, so
diffing a golden layout is meaningful) and a golden-HTML smoke test. Both are
pure functions: string in, string out. That is the structural difference —
React Flow layout could not be asserted without a DOM, a render loop, and the
React that cannot currently be resolved.

Layout is computed **in the generator**, not in the browser: a deterministic
layered placement (depth by dependency distance, ordered by node id for
stability) emitted as absolute coordinates plus inline SVG edge paths. The
browser does pan, zoom, and click. It does not lay out.

### Why (b) and not the others

- **(a) strip to the minimum that serves Comprehend** — keeps React, keeps Vite,
  keeps the nested `package.json` that produced five dead test files, keeps the
  React dedup decision. Deleting views does not delete the build.
- **(c) keep React, collapse to 2–3 views** — same problem, less of it. The cost
  is not the view count; it is the toolchain.
- **(d) drop the viewer entirely** — the closest rival, and wrong for one reason:
  a terminal cannot draw a graph. The hands-off builder's first question is
  "what is this system?" (`docs/VISION.md:71-72`), and topology is the one thing
  that is genuinely faster seen than read. Dropping View entirely would mean the
  product has no surface at all, which contradicts `docs/VISION.md:76-80` keeping
  View as a layer.

(b) is the only option where the build step, the dependency tree, and the test
strategy all simplify at once. It is also the only one whose output is
*committable*: a generated HTML file can be reviewed in a pull request the way
the JSON is.

### Scope of the artifact

Deliberately narrow, because it renders the graph and nothing else:

- Force-directed-looking but deterministic layout, pan and zoom.
- Node selection showing: kind, inbound and outbound edges grouped by edge kind,
  data shapes, and the decisions that produced it (`decided_by`).
- A text filter over node names.
- Deep links by node id, so the agent can hand the user a URL.

**Not in the artifact:** prompt queue, learning, editing, decision authoring.
The prompt queue moves into the agent conversation. Learning mode is deleted
(ADR-0003). Editing is the document's job and the document is a file.

### Migration

1. **Freeze.** No new viewer features. Fix the five dead test files by
   **deleting** them, not by creating `src/viewer/node_modules` — making a
   never-passing test pass by materialising a nested `node_modules` directory
   would be building on the decision this ADR reverses.
2. **Relocate.** Move `src/viewer/src/utils/markdown.ts` and `mermaid.ts` to
   `src/export/`. They are pure, they are not viewer code, and this breaks the
   `export.ts:3-4` coupling. `tests/export/{markdown,mermaid}.test.ts` keep
   passing unchanged.
3. **Build the generator.** `src/export/html.ts` — pure, reads the v2 graph,
   emits the artifact. Add the layout test and the golden test. At this point
   `npm test` is green with 0 failing files.
4. **Cut over.** `arkive export html` writes `arkive/graph.html`.
   `src/cli/commands/serve.ts:117-128` serves the artifact instead of
   `express.static(viewerDir)`; the `existsSync(viewerDir)` branch and its
   "Viewer not built. Run `npm run build:viewer` first." error (`:125`) both go.
5. **Delete.** `src/viewer/` in full — 33 files, `package.json`,
   `package-lock.json` (92 KB), `vite.config.ts`, `tsconfig.json`, `index.html`;
   the 11 test files; the `build:viewer` script in `package.json`;
   `scripts/build.mjs:21-35`. Also delete the React Flow / D3 / dagre entries
   from `docs/VISION.md`'s dogfood example once arkive's own document is
   regenerated.

Step 1 and step 2 are independent of the graph schema and can start now. Step 4
depends on ADR-0001.

## Consequences

### Positive

- The five permanently-failing test files are deleted rather than repaired. The
  suite goes from 8 failing files to 3, all non-viewer.
- `npm run build` stops having two tools fight over `dist/viewer`
  (`tsup.config.ts:9` vs `src/viewer/vite.config.ts:23-24`).
- `dec-003` and the React dedup configuration stop being load-bearing.
- A 92 KB `package-lock.json` and a second toolchain leave the repository.
- The artifact is committable and diffable, which the Vite bundle never was.
- Layout becomes testable as a pure function instead of untestable through a DOM.

### Negative

- **Loses interactive graph exploration.** A generated artifact cannot re-layout,
  cannot filter by edge kind across the whole graph, cannot animate anything. If
  a user's primary activity is playing with the topology, this artifact is worse
  than what it replaces. Accepted: `docs/VISION.md:76-80` says the viewer exists
  to *see* structure, not to be a tool.
- **Generation must run for every change.** The artifact is a snapshot. A
  generator that is cheap to run is a prerequisite; a stale committed artifact
  is worse than no artifact. Mitigated by not committing it by default and by
  `arkive export html` being a sub-second operation.
- **Loses the 6 passing viewer tests.** `ConceptMap`, `ProgressTracker`,
  `QuestionCard`, `QuizPanel`, `search`, `stack-view` all test components being
  deleted. Replaced by 2 generator tests.
- Hand-written SVG layout is less polished than React Flow's force simulation.
  The layout quality is now arkive's problem rather than a library's.

## Kill condition

If the artifact needs interactivity that only a running app provides —
persistent user annotations, live editing, or a filter across the whole graph
that must respond in under one frame — this decision is wrong and option (a) is
correct. Set that threshold before building, not after.

## Alternatives considered

**Strip React Flow and D3, keep React, collapse to 2–3 views.** Rejected. Keeps
Vite, keeps the nested `package.json` that caused the five dead test files, keeps
`emptyOutDir: true` pointed at `dist/viewer` where tsup also writes. Reduces
symptoms, keeps the machine.

**Build-free single-file HTML generated from the graph.** Chosen. See above.

**Keep React, collapse to 2–3 views.** Rejected — the same rejection as (a) with
a slightly different view count. Three views is still three components, three
hooks, and a bundler.

**Drop the viewer entirely; run walkthroughs through the agent.** Rejected. It
is the right direction for comprehension (ADR-0003) but wrong for View. Topology
is the one artefact that is faster seen than read, and removing it leaves the
product with no surface a human can open without a terminal — which is the
surface `docs/VISION.md:76-80` says View exists to provide. The agent narrates;
the artifact shows.

**Generate the HTML once and commit it; never regenerate.** Rejected. It becomes
a lie in the repository that drifts silently — the exact class of failure in
ADR-0006, applied to a rendering.

## Related

- ADR-0001 — the graph the artifact renders.
- ADR-0003 — deletion of the Learning and prompt-queue surfaces removes two of
  the viewer's three non-graph features.
- `docs/issues/0010`.