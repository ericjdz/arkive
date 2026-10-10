# The orphaned `architecture.json`, and why `docs/` was ignored

## What happened

This repo used to be called **archlearn**. Its architecture document lived at the
repository root, in `architecture.json`.

A path migration moved the document to `arkive/architecture.json`. The migration
scaffolded a *new, empty* document at the new path and left the real one behind at
the old path. Nothing warned. The root file was shadowed by the new one and then
forgotten.

The cost was four architectural decisions that were silently lost. They are
recovered in [`../arkive/legacy-architecture.json`](../arkive/legacy-architecture.json),
preserved verbatim. That file is **not** loaded by arkive and is **not** a live
document — it is a historical record kept only so the reasoning is recoverable.

The recorded decisions, briefly:

| id | topic | decision |
|----|-------|----------|
| `d1` | Packaging surface | Bundle the CLI in `dist/` and publish templates and agent instructions alongside it. |
| `dec-002` | MCP + viewer in one package | Ship the MCP server and web viewer in a single npm package. |
| `dec-003` | React version for viewer | Force React 19 via Vite aliases to deduplicate with the root project. |
| `dec-004` | MCP transport modes | Support both stdio (`--stdio`) and HTTP modes in `serve`. |

`dec-003` is not merely historical. It is the reason `src/viewer/package.json`
does not install React: a second React copy in the module graph breaks hooks at
runtime, which is exactly the failure the decision was recorded to prevent. See
the comment in that file and the `.npmrc` beside it.

## A second, related loss

`.gitignore` contained `docs/`. Because of that, the original Plan 1–6 planning
documents were never committed and are now unrecoverable. The `docs/` entry has
been removed and the `docs/` tree — including this file, `VISION.md`, and
`docs/issues/` — is now tracked.

## Why this is a data-integrity failure, not a cleanup chore

Both of these are the exact failure the product exists to prevent: a structural
change that destroys recorded reasoning without anyone noticing. `VISION.md`
calls this out directly under "What the previous version got wrong", and ADR-0006
records migrations becoming a first-class, tested concern.

No path, schema, or configuration change should be able to destroy user data
silently. Recovering the four decisions and un-ignoring `docs/` is the minimum
repair. Deleting the orphaned file, or leaving `docs/` ignored, would have
destroyed the record a second time.