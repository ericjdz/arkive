---
name: reconciliation
description: Detect drift between architecture.json and the actual codebase. Run periodically or when things feel out of sync.
---

# Reconciliation — Drift Detection

## When to Use

- When returning to a project after a break
- When multiple developers (or AI agents) have made changes
- When you suspect the architecture doc is out of date
- Periodically as a health check

## How to Reconcile

### Step 1: Read architecture.json

Load the current architecture document.

### Step 2: Scan the Codebase

Check these files for ground truth:

- `package.json` / `requirements.txt` / `go.mod` → actual dependencies
- `docker-compose.yml` / `Dockerfile` → actual services and infrastructure
- Import statements across source files → actual service connections
- Config files (`.env`, `nginx.conf`, database configs) → actual infrastructure
- API route definitions → actual endpoints and protocols

### Step 3: Compare and Report

For each mismatch, report:
- **What the doc says** vs **what the code shows**
- **Severity**: Critical (service missing), Warning (dependency mismatch), Info (minor drift)
- **Suggested fix**: What to update in architecture.json

### Step 4: Update

After reviewing the report, update architecture.json to reflect reality. Add a history entry:

```json
{
  "timestamp": "now",
  "action": "reconciliation",
  "summary": "Reconciled architecture.json with codebase — fixed N mismatches"
}
```

## Common Drift Patterns

- Dependency added to package.json but not reflected in stack
- New API route added but no service/connection entry
- Service renamed in code but old name in architecture.json
- Infrastructure change (e.g., switched from Vercel to AWS) not recorded
