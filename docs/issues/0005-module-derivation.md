# 0005 — Module derivation engine

status: open
stream: derive
blocks: 0007, 0014
blocked_by: 0004

## Context

This is the issue that makes the graph trustworthy. Vision layer 1 says the
graph is **derived first, authored second**: structure comes from static
analysis of real code, because structure is a fact and facts should not be
transcribed by an LLM.

Today the scanner (`src/analysis/scanner.ts`) is a token gesture:

- `scanner.ts:15` hardcodes `scanImports(join(dir, "src"))`. A Python, Go,
  Rust, or JS project using `lib/`, `app/`, or `packages/` yields
  `imports: []`, so `detectDrift` returns zero warnings and `reconcile` prints
  *"No drift detected. arkive/architecture.json is in sync."*
- **That is the worst possible failure mode for a drift detector — it
  manufactures false confidence.**
- `collectSourceFiles` (`scanner.ts:60-75`) does not exclude `node_modules`, so
  it will walk a vendored tree.
- `DriftSeverity` declares `critical` (`drift.ts:4`) but nothing ever emits it,
  so the red path at `reconcile.ts:35` and `status.ts:77` is dead code.

## Scope

1. **Language-aware import extraction.** TypeScript/JavaScript (ESM, CJS,
   dynamic `import()`, re-exports), Python, Go. Each behind a small extractor
   interface so a language is one file, not a branch in a walker.
2. **Repo-root walk.** Walk from the project root, honouring `.gitignore`,
   skipping `node_modules`, `dist`, `build`, `vendor`, `.git`, and test
   fixtures. Configurable roots via `arkive.config.json` with sensible
   auto-detection. Cap the walk (file count, file size) so it cannot run away.
3. **Emit graph nodes and edges.** Module nodes with `path`; `imports` edges
   resolved to internal modules (external packages become `external` nodes).
   This is what populates the graph the viewer and walkthrough will render.
4. **`--include` / `--exclude` flags** on the CLI, plus config file equivalents.
5. **Emit `critical` drift.** A `service` node whose technology appears nowhere
   in the scanned tree, or an edge pointing at a node with no file on disk.
   Wire it so the dead `critical` path actually renders.
6. **Honesty about coverage.** If the scanner cannot parse a tree, say so.
   Report the fraction of files successfully parsed. *"I could not read 40% of
   this repository"* is a useful answer; *"in sync"* is a lie.

## Out of scope

`datastructure` node extraction (0006). Watch mode (0007). LLM-based
verification — explicitly a non-goal; this must stay deterministic and offline.

## Acceptance criteria

- [ ] Given a fixture repo with a `src/`, a fixture with `lib/`, and a fixture
      with `packages/`, all three produce equivalent graph coverage.
- [ ] A repo containing a deleted module produces `critical` drift, not
      silence.
- [ ] Scanner reports parse coverage as a percentage. A partial parse never
      reports "in sync."
- [ ] `node_modules` never appears in output.
- [ ] Adding a new language requires one new file, not an edit to the walker.
- [ ] Performance: full scan of a 5,000-file repo completes under 5s.
- [ ] `npm run lint` and `npm test` pass.

## Note

The post-commit auto-reconcile hook currently calls `reconcile --quiet`, and
`--quiet` is not a registered option on that command — Commander exits 1 and
`2>/dev/null || true` swallows it. The hook has never done anything. Fix or
remove it as part of wiring this up; do not leave a no-op hook that appears to
work.