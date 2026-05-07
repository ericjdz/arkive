---
name: reconciliation
description: Detect drift between arkive/architecture.json and the actual codebase.
trigger: User says "check drift", "reconcile", "is the architecture up to date", or when returning to a project after a break.
---

# Reconciliation — Drift Detection

## When to Use

- When returning to a project after a break
- When multiple developers or AI agents have made changes
- When you suspect the architecture doc is out of date
- Periodically as a health check

## How to Reconcile

### Option A: Via CLI (recommended)

Run: `npx @ericjdz/arkive reconcile`

This scans `package.json` and source imports under `src/`, then reports mismatches against `arkive/architecture.json`.

### Option B: Via MCP tool

Call the `check_drift` tool. It returns the same report as the CLI command.

### Option C: Manual scan

If neither CLI nor MCP is available:

1. Read `arkive/architecture.json`
2. Check these files for ground truth:
   - `package.json` / `requirements.txt` / `go.mod` → actual dependencies vs `stack`
   - Import statements across source files → actual connections vs `connections`
3. For each mismatch, note:
   - What the doc says vs what the code shows
   - Severity: Critical (service missing), Warning (dependency mismatch), Info (minor drift)

**Current scanner limitations:** The automated scanner checks `package.json` dependencies and `src/` import statements. It does NOT currently scan Docker, nginx, env files, or infrastructure configs. For those, do a manual review.

## After Reconciliation

Update `arkive/architecture.json` to reflect reality. MUST append a history entry:

```json
{
  "timestamp": "ISO 8601 now",
  "action": "reconciliation",
  "summary": "Reconciled arkive/architecture.json with codebase — fixed N mismatches"
}
```

## MUST NOT

- Do NOT silently fix drift without reporting what changed
- Do NOT remove entries from arkive/architecture.json without verifying they are truly gone from the codebase
