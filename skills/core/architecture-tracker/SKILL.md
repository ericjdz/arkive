---
name: architecture-tracker
description: Maintain the living architecture document as you build. This is the core skill — always active.
---

# Architecture Tracker

## The Rule

**Before any major change**: Read `architecture.json`.
**After any major change**: Update `architecture.json`.
**On every session start**: Read `architecture.json` first.

The architecture document is your memory. Not the context window. Not the chat history. The file.

## What Counts as a Major Change

- Adding, removing, or replacing a service, database, or external API
- Changing how services communicate (new endpoints, protocol changes)
- Adding or modifying infrastructure (hosting, CI/CD, caching, CDN)
- Adopting a new library or framework for a significant function
- Refactoring that changes module boundaries or data flow

## How to Update

### Services

Add or update entries in the `services` array:

```json
{
  "id": "unique-kebab-case-id",
  "name": "Human Readable Name",
  "type": "frontend|backend|database|cache|queue|gateway|cdn|storage|auth|search|monitoring|other",
  "technology": "The specific technology (e.g., 'Next.js', 'PostgreSQL', 'Redis')",
  "description": "What this service does in one sentence",
  "dependencies": ["ids-of-services-this-depends-on"]
}
```

### Connections

Add entries to `connections` when services communicate:

```json
{
  "from": "service-id-that-initiates",
  "to": "service-id-that-receives",
  "protocol": "HTTP/REST|GraphQL|WebSocket|gRPC|TCP/SQL|AMQP|etc",
  "description": "What data flows through this connection"
}
```

### Decisions (CRITICAL)

Every time you choose a technology, pattern, or approach, record it in `decisions`:

```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY you chose it — specific to this project's needs",
  "alternatives": [
    { "name": "Alternative A", "whyNot": "Why this was rejected" },
    { "name": "Alternative B", "whyNot": "Why this was rejected" }
  ],
  "timestamp": "ISO 8601 timestamp",
  "relatedServices": ["service-ids-affected"]
}
```

**Do not skip alternatives.** The learning value of this tool depends on understanding what was NOT chosen and why.

### Data Flows

Document important user-facing flows:

```json
{
  "name": "What the user is doing (e.g., 'User sends a message')",
  "steps": [
    { "actor": "service-id", "action": "What happens at this step" }
  ]
}
```

### History

Append to `history` on every update:

```json
{
  "timestamp": "ISO 8601",
  "action": "what_happened (e.g., 'added_service', 'architecture_decision', 'refactor')",
  "summary": "One-line summary of the change"
}
```

### Always

Update `project.lastUpdated` with the current timestamp on every change.

## Reference

See `references/schema-guide.md` for the complete schema specification.
