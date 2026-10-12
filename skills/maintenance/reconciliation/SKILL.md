---
name: reconciliation
description: Derive the architecture graph from the code and report what a human's claims no longer support.
trigger: User says "check drift", "reconcile", "is the architecture up to date", "derive the graph", or when returning to a project after a break.
---

# Reconciliation — Derive, then report

## When to Use

- When returning to a project after a break
- After a change to the module tree, the dependency list, or the source layout
- When the document and the code may disagree
- Periodically as a health check

## What reconciliation is for

Structure comes from static analysis. `reconcile` runs the derivation over the
code and reports the delta against the document. The derived half cannot drift,
because nothing structural is stored — so this is not a search for a
transcription that has gone stale.

What it *does* report is the gap between the code and the **authored** half:
a `service` node claiming a technology the manifest does not declare, a decision
explaining something that no longer exists, a node a previous run derived and
this run cannot reproduce.

## How to Reconcile

### Report (default)

```bash
npx @ericjdz/arkive reconcile
```

Scans the project, prints what derivation *would* change, and writes nothing.

It prints the scan's own coverage — files scanned, unreadable, not reached — and
a per-language breakdown of the derived graph. An empty warning list over a
partial scan is **not** a clean bill of health, and the command says so: look
for the `coverage:` line and for a `note:` about what it skipped. If it says
arkive could not verify the document, that is the finding.

### Persist

```bash
npx @ericjdz/arkive reconcile --apply
```

Writes the derived half and exits. This is the one-shot escape from `watch`.

Narrow the scan with `--include <path>` / `--exclude <path>` (both repeatable,
both overriding `arkive.config.json`), and suppress the graph summary with
`--no-graph`.

### Continuous

```bash
npx @ericjdz/arkive watch
```

Runs the same derivation on every change and reports the delta. Exits non-zero
only if the *initial* scan failed — a watcher cannot retroactively set an exit
code its shell already read.

### Scope with `--include` or `--exclude`

```bash
npx @ericjdz/arkive reconcile --include src --exclude src/generated
```

A narrowing is reported in the coverage line. A scan that quietly covered half a
repository would otherwise read as a scan that covered all of it.

## After Reconciliation

The derived half is now correct by construction. Record what you learned in the
authored half:

```json
{
  "timestamp": "<ISO 8601 now>",
  "action": "reconciliation",
  "summary": "Reconciled — derived 412 module nodes and 87 external nodes"
}
```

If the run reported an authored claim the code does not support, fix the claim
or remove it — do not edit the code to match the document.

## MUST NOT

- Do NOT hand-edit `nodes[]` or `edges[]` to make a report go away. The derived half is rewritten from the code on the next `--apply` or `watch` cycle, and your edit disappears without a warning.
- Do NOT treat "No drift detected" as proof of anything without reading the coverage line above it.
- Do NOT silently fix authored findings without reporting what changed.
- Do NOT remove an authored element without verifying it is genuinely gone from the codebase. `reconcile` reports a dangling reference rather than dropping it, and that is deliberate.
- Do NOT add a `confidence` field to resolve a finding. It was deleted because it was declared and read but written by no code path; a number an LLM assigns to itself is not evidence. `evidence: ["file:line"]` is.