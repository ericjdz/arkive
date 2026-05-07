# Question Templates

Templates for generating architecture comprehension questions. The AI agent uses these patterns to create questions from `arkive/architecture.json` data.

## Decision Questions (Multiple Choice)

**Template:** Why did this project choose "{decision}" for {topic}?

**Correct answer:** The decision's `rationale` field.

**Wrong answers:** 
- The `whyNot` reasons from rejected `alternatives` (these explain why alternatives were BAD, not why the choice was GOOD — users often confuse these)
- Generic distractors: "It was the only option", "It's the most popular choice", "It's the cheapest option"

**Example from chat app:**
```
Why did this project choose "PostgreSQL over MongoDB" for Database Choice?

A) Relational data model fits chat. Strong consistency for message ordering. ✅
B) Document model adds complexity for relational queries.
C) Not suitable as primary persistent store.
D) It was the only option available.
```

## Data Flow Questions (Ordering)

**Template:** What happens when "{dataFlow.name}"? Arrange the steps in order.

**Items:** Each step from `dataFlow.steps`, formatted as `[actor] action`.

**Example from chat app:**
```
What happens when "User sends a message"? Arrange the steps:

1. [web-client] User types message, hits send
2. [web-client] Emits 'send_message' via WebSocket
3. [websocket-server] Receives message, validates, persists to DB
4. [database] INSERT into messages table
5. [websocket-server] Broadcasts 'new_message' to all room members
6. [web-client] Receives broadcast, appends to chat UI
```

## Topology Questions (Multiple Choice)

**Template:** Which services depend on {service.name}?

**Correct answer:** List of services whose `dependencies` array includes this service's ID.

**Wrong answers:** Services that do NOT depend on this service.

**Example from chat app:**
```
Which services depend on PostgreSQL?

A) REST API, WebSocket Server ✅
B) Web Client
C) No other services
```

## Connection Questions (Multiple Choice)

**Template:** What protocol does the connection from {from} to {to} use?

**Correct answer:** The connection's `protocol` field.

**Wrong answers:** Other protocols used in the project, plus generic protocols (gRPC, GraphQL, AMQP).

**Example from chat app:**
```
What protocol does the connection from web-client to websocket-server use?

A) HTTP/REST
B) WebSocket ✅
C) TCP/SQL
D) gRPC
```

## Stack Questions (Short Answer)

**Template:** What {category} does this project use? (e.g., "What database does this project use?")

**Acceptable answers:** Values from `stack.{category}`.
