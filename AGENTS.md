# Architecture-Tracked Project (arkive — lightweight mode)

This repo uses a living architecture document, `architecture.json`. You — the AI coding agent (Codex, OpenCode, Copilot, or any AGENTS.md-aware tool) — are responsible for keeping it in sync with the code.

> **Lightweight mode.** No MCP server, no viewer. Just this file and the JSON. To upgrade, run `npx @ericjdz/arkive init`.

## Rules

1. **On every session start**: Read `architecture.json` first. It is your cross-session memory.
2. **Before any major change**: Re-read `architecture.json`.
3. **After any major change**: Update `architecture.json` and append a `history` entry.

## Major Changes

Add/remove a service, database, or external API · change communication protocols · modify infrastructure · adopt a new framework · refactor module boundaries.

## Bootstrap

If `architecture.json` is missing, create it with this structure:

```json
{
  "version": "1.0.0",
  "project": {
    "name": "<project-name>",
    "description": "<one sentence>",
    "created": "<ISO 8601 now>",
    "lastUpdated": "<ISO 8601 now>"
  },
  "stack": { "language": [], "runtime": [], "framework": [], "database": [], "infrastructure": [] },
  "services": [],
  "connections": [],
  "decisions": [],
  "dataFlows": [],
  "history": [
    { "timestamp": "<ISO 8601 now>", "action": "initial_scaffold", "summary": "Architecture document created" }
  ]
}
```

Then scan the existing codebase (`package.json`, folder structure, imports, infra configs) and populate `stack`, `services`, `connections`.

## Schema (compact)

- **Service**: `{ id, name, type, technology, description, dependencies[] }`
  - `type`: `frontend | backend | database | cache | queue | gateway | cdn | storage | auth | search | monitoring | other`
- **Connection**: `{ from, to, protocol, description }`
- **Decision**: `{ id, topic, decision, rationale, alternatives[{name, whyNot}], timestamp, relatedServices[] }`
- **DataFlow**: `{ name, steps[{actor, action}] }`
- **History entry**: `{ timestamp, action, summary }`

## Rules of the Road

- Every `connection.from`/`to` must reference an existing `service.id`.
- Every `service.dependencies[]` entry must reference an existing `service.id`.
- Every architectural choice records at least one rejected alternative with `whyNot`.
- All timestamps are ISO 8601.
- Update `project.lastUpdated` on every change.

## MCP Server (if arkive is installed)

If arkive is installed, prefer MCP tools over direct file editing:

- `update_architecture` — add/modify/remove services, connections, data flows, stack
- `record_decision` — record decisions with rationale and rejected alternatives
- `check_drift` — verify doc matches code

To install: `npx @ericjdz/arkive init`

To register MCP in your platform: `npx @ericjdz/arkive install <platform>`
Supported platforms: `claude-desktop`, `claude-code`, `cursor`, `opencode`, `vscode`, `windsurf`, `cline`

## Upgrade

For MCP server, web viewer, and Learning Mode:

```bash
npx @ericjdz/arkive init
npx @ericjdz/arkive serve
```

Docs: https://github.com/arkive/arkive
