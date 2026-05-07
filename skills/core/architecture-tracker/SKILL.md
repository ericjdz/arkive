---
name: architecture-tracker
description: Maintain the living architecture document as you build. This is the core skill — always active when arkive/architecture.json exists.
trigger: Always active when arkive/architecture.json exists in the arkive/ directory. Activates on session start and after any major change.
---

# Architecture Tracker

## Operating Mode

**MCP-first, file-fallback.** Choose your write path:

| Condition | Read via | Write via |
|---|---|---|
| arkive MCP server is connected | MCP resources (`architecture://overview`, etc.) | MCP tools (`update_architecture`, `record_decision`) |
| MCP not available | Read `arkive/architecture.json` directly | Edit `arkive/architecture.json` directly, validate manually |

To check if MCP is available: attempt to read `architecture://overview`. If it succeeds, use MCP for all reads/writes.

## The Rules

1. **On every session start**: Read `arkive/architecture.json` (or MCP `architecture://overview`) FIRST. This is your memory across sessions. Do NOT re-derive architecture from the codebase if this file exists.
2. **Before any major change**: Re-read to align your changes with existing architecture.
3. **After any major change**: Update `arkive/architecture.json` using the post-change sequence below.

## Lifecycle Hooks (NON-NEGOTIABLE)

These hooks govern your behavior for the ENTIRE session, not just during explicit architecture work.

### session_start (BEFORE anything else)
1. Check if `arkive/architecture.json` exists in the arkive/ directory.
2. If it exists: read it completely. This is your cross-session memory. Do NOT re-derive architecture from code.
3. If it does not exist: inform the user that arkive is not initialized. Suggest `/arkive-init`.
4. This step is NON-NEGOTIABLE. Do NOT skip it even if the user's first message seems urgent.

### post_major_change (IMMEDIATELY after any major change)
1. Re-read `arkive/architecture.json` to get current state.
2. Call `update_architecture` with changes (or edit directly if MCP unavailable).
3. Call `record_decision` for any architectural choices made.
4. Append a `history` entry.
5. Do NOT defer this to "later" or "end of session." Update IMMEDIATELY after the change.

### pre_completion (BEFORE claiming work is done)
1. Re-read `arkive/architecture.json`.
2. Verify it reflects the current state of the project.
3. If any architectural changes were made during this session that are not reflected: update now.
4. Call `check_drift` and resolve any mismatches.
5. Do NOT claim completion until architecture is current.

## What Counts as a Major Change

- Adding, removing, or replacing a service, database, or external API
- Changing how services communicate (new endpoints, protocol changes)
- Adding or modifying infrastructure (hosting, CI/CD, caching, CDN)
- Adopting a new library or framework for a significant function
- Refactoring that changes module boundaries or data flow

## Post-Change Sequence (MUST follow this order)

### Via MCP tools:
1. Call `update_architecture` with new/changed services, connections, data flows, and stack entries. To remove stale entries, use `removeServiceIds`, `removeConnectionKeys`, or `removeDataFlowNames` fields.
2. Call `record_decision` for EVERY architectural choice made — MUST include at least one rejected alternative with `whyNot`
3. Optionally call `check_drift` to verify consistency

### Via direct file editing:
1. Read `arkive/architecture.json`
2. Add/update entries in `services`, `connections`, `dataFlows`, `stack`
3. Add decision entries to `decisions` with `id`, `topic`, `decision`, `rationale`, `alternatives` (min 1), `timestamp`, `relatedServices`
4. Append to `history` with `timestamp`, `action`, `summary`
5. Update `project.lastUpdated` to current ISO 8601 timestamp
6. Write the complete valid JSON back

## Schema Quick Reference

### Service
```json
{
  "id": "kebab-case-id",
  "name": "Human Readable Name",
  "type": "frontend|backend|database|cache|queue|gateway|cdn|storage|auth|search|monitoring|other",
  "technology": "Specific tech (e.g., 'Next.js', 'PostgreSQL')",
  "description": "What this service does in one sentence",
  "dependencies": ["ids-of-services-this-depends-on"]
}
```

### Connection
```json
{
  "from": "service-id-that-initiates",
  "to": "service-id-that-receives",
  "protocol": "HTTP/REST|GraphQL|WebSocket|gRPC|TCP/SQL|AMQP|etc",
  "description": "What data flows through this connection"
}
```

### Decision (CRITICAL — never skip)
```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY you chose it — specific to this project's needs",
  "alternatives": [
    { "name": "Alternative A", "whyNot": "Why this was rejected" }
  ],
  "timestamp": "ISO 8601",
  "relatedServices": ["service-ids-affected"]
}
```

### Data Flow
```json
{
  "name": "What the user is doing",
  "steps": [
    { "actor": "service-id", "action": "What happens at this step" }
  ]
}
```

### History (append on every update)
```json
{
  "timestamp": "ISO 8601",
  "action": "added_service|architecture_decision|refactor|reconciliation|...",
  "summary": "One-line summary"
}
```

## Validation Rules

- Every `connection.from` and `connection.to` MUST reference an existing `service.id`
- Every `service.dependencies[]` entry MUST reference an existing `service.id`
- Every decision MUST include at least one rejected alternative with `whyNot`
- All timestamps MUST be ISO 8601
- MUST update `project.lastUpdated` on every change

## MUST NOT

- Do NOT update `arkive/architecture.json` for non-architectural changes (typos, formatting, variable renames, test-only changes, comment edits)
- Do NOT create decisions without rejected alternatives — decisions without alternatives are defaults, not decisions
- Do NOT leave orphaned references (connections pointing to removed services)
- Do NOT re-derive the architecture from code if `arkive/architecture.json` exists — trust the document

## Prompt Queue

Users can queue architecture change prompts from the web viewer, scoped to specific services.

### MCP Tools

- `list_prompts` — List all queued prompts (optionally filter by status: pending, claimed, done, failed)
- `claim_next_prompt` — Atomically claim the oldest pending prompt. Returns the prompt text and target service IDs.
- `ack_prompt` — Mark a claimed prompt as done or failed after execution.

### MCP Resource

- `architecture://prompts` — Read-only view of all queued prompts with summary counts.

### Workflow

1. User opens the viewer (`arkive serve`) and selects architecture nodes
2. User writes prompts scoped to those nodes
3. User clicks "Copy All" to paste into agent chat, OR the agent reads `architecture://prompts`
4. Agent calls `claim_next_prompt` to get the next prompt
5. Agent executes the prompt, updating architecture.json as needed
6. Agent calls `ack_prompt` with outcome "done" or "failed"
7. Repeat until queue is empty

## Reference

See `references/schema-guide.md` for the complete schema specification.
