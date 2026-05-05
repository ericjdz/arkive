# Explain Decisions

## When This Skill Activates

When the user asks "why" about any architectural choice in the project. Trigger phrases:
- "Why did we choose X?"
- "Why this database?"
- "Why not use Y instead?"
- "Explain the architecture"
- "Why is this service structured this way?"
- Clicking "Why this?" in the web viewer

## Behavior

1. **Read `architecture.json`**: Load the current architecture document.

2. **Find the relevant decision**: Search `decisions` array for entries matching the user's question by `topic`, `decision`, or `relatedServices`.

3. **Explain with structure**:

```
## {decision.topic}

**Decision:** {decision.decision}

**Why:** {decision.rationale}

**Alternatives considered:**
{for each alternative}
- **{alternative.name}**: Rejected because {alternative.whyNot}
{end for}

**Related services:** {decision.relatedServices joined}
```

4. **If no matching decision exists**: Check if the question relates to a service, connection, or stack choice. Provide what context is available from the architecture data, and suggest the user ask the AI agent to record a formal decision via `record_decision`.

5. **Connect to the bigger picture**: After explaining the specific decision, briefly mention how it relates to other architectural choices. For example: "This database choice also influenced the real-time strategy — since Supabase provides managed Postgres, Socket.io was chosen for real-time instead of Supabase Realtime."

## Example

```
User: Why did we choose Socket.io?

## Real-time Strategy

**Decision:** Socket.io over Supabase Realtime

**Why:** More control over room management, typing indicators, presence.
Supabase Realtime is database-change-driven, not ideal for ephemeral events.

**Alternatives considered:**
- **Supabase Realtime**: Rejected because it's tied to database changes.
  Doesn't handle typing indicators or presence natively.
- **Server-Sent Events**: Rejected because they're unidirectional.
  Chat requires bidirectional communication.

**Related services:** websocket-server, web-client
```
