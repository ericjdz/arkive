# Architecture-Tracked Project (arkive — lightweight mode)

This repo uses a living architecture document, `architecture.json`. You — the AI coding agent — are responsible for keeping it in sync with the code.

> **You are using the lightweight, drop-in version of arkive.** No MCP server, no web viewer, no Learning Mode — just this file and the JSON. To upgrade, run `npx @ericjdz/arkive init` (see "Upgrade" at the bottom).

## The Three Rules

1. **On every session start**: Read `architecture.json` first. It is your memory across sessions, compaction, and model switches. Do not re-derive the architecture from the codebase if this file exists.
2. **Before any major change**: Re-read `architecture.json` to align your changes with the existing system.
3. **After any major change**: Update `architecture.json` to reflect what changed and why. Append a `history` entry. Update `project.lastUpdated`.

## What Counts as a Major Change

- Adding, removing, or replacing a service, database, or external API
- Changing how services communicate (new protocols, new endpoints)
- Adding or modifying infrastructure (hosting, CI/CD, caching, CDN, queues)
- Adopting a new framework or major library for a significant function
- Refactoring that changes module boundaries or data flow

## Bootstrapping `architecture.json` From Scratch

If `architecture.json` does not exist yet, create it with this exact structure:

```json
{
  "version": "1.0.0",
  "project": {
    "name": "<project-name>",
    "description": "<one sentence>",
    "created": "<ISO 8601 now>",
    "lastUpdated": "<ISO 8601 now>"
  },
  "stack": {
    "language": [],
    "runtime": [],
    "framework": [],
    "database": [],
    "infrastructure": []
  },
  "services": [],
  "connections": [],
  "decisions": [],
  "dataFlows": [],
  "history": [
    {
      "timestamp": "<ISO 8601 now>",
      "action": "initial_scaffold",
      "summary": "Architecture document created"
    }
  ]
}
```

If the project already has code, scan it and populate the file:
- `package.json` / `requirements.txt` / `go.mod` → `stack`
- Folder structure + entry points → `services`
- Import statements + API calls → `connections`
- Docker/compose/IaC files → `infrastructure`

## Schema Reference

### Service entry

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

### Connection entry

```json
{
  "from": "service-id-that-initiates",
  "to": "service-id-that-receives",
  "protocol": "HTTP/REST|GraphQL|WebSocket|gRPC|TCP/SQL|AMQP|...",
  "description": "What data flows through this connection"
}
```

### Decision entry (the most important — never skip)

```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY you chose it — specific to this project's needs",
  "alternatives": [
    { "name": "Alternative A", "whyNot": "Why this was rejected" }
  ],
  "timestamp": "<ISO 8601>",
  "relatedServices": ["service-ids-affected"]
}
```

Always include at least one rejected alternative. Decisions without alternatives are not decisions — they are defaults.

### History entry (append on every change)

```json
{
  "timestamp": "<ISO 8601>",
  "action": "added_service|architecture_decision|refactor|reconciliation|...",
  "summary": "One-line summary"
}
```

## Validation Rules

1. Every `connection.from` and `connection.to` must reference an existing `service.id`.
2. Every `service.dependencies[]` entry must reference an existing `service.id`.
3. All timestamps must be ISO 8601.
4. Update `project.lastUpdated` on every change.

## MCP Server (if arkive is installed)

If arkive is installed in this project, prefer MCP tools over direct file editing:

- `update_architecture` — add, modify, or remove services, connections, data flows, and stack entries
- `record_decision` — record an architectural decision with rationale and rejected alternatives
- `check_drift` — verify architecture.json matches the codebase

To check: attempt to read `architecture://overview`. If it succeeds, use MCP for all reads/writes.

To install arkive and enable MCP:

```bash
npx @ericjdz/arkive init
```

## Upgrade to the Full Experience

To get the MCP server (richer agent context), interactive web viewer, and Learning Mode:

```bash
npx @ericjdz/arkive init
npx @ericjdz/arkive serve
```

Documentation: https://github.com/arkive/arkive
