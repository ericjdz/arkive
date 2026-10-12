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

**Template:** Which component depends on {node.name}?

**Correct answer:** The nodes that reach `{node.id}` by traversing `edges` outward from it — `imports`, `calls`, `reads`, `writes`. Use `from` → `to`.

**Wrong answers:** Nodes that do NOT reach it. Do not offer `kind: "external"` nodes as plausible answers for an internal dependency question — every module imports something third-party and the answer stops being discriminating.

**Example:**
```
Which components depend on the datastore node?

A) schema module, analysis module ✅
B) viewer
C) Nothing — it is only written by hand
```

## Edge Questions (Multiple Choice)

**Template:** What relationship does edge {from} → {to} represent?

**Correct answer:** The edge's `kind`, and its `label` if it has one. `label` is transport naming only (`"HTTP/REST"`, `"stdio"`) and never semantic — `kind` is the semantic answer.

**Wrong answers:** Other edge kinds used in the project, plus generic distractors (`derives_from`, `decided_by` are rarely right; `decided_by` is not stored at all).

**Example:**
```
What does the edge from the http-handler to the message-bus describe?

A) calls ✅
B) reads
C) derives_from
D) writes
```

## Provenance Questions (Multiple Choice)

**Template:** How did {node.name} come to be in this graph?

**Correct answers:**
- `derived` — a rule read the sites in `provenance.evidence`. Name one of them.
- `authored` — somebody recorded it; `provenance.authoredBy` says who.

**Wrong answers:** Any answer implying a confidence score, a percentage, or a probability. There is no `confidence` field, and an invented one would be a number nobody measured.

This is the one template that teaches the distinction the rest of the product rests on: structure is derived, intent is authored, and the two are not interchangeable.

## Stack Questions (Short Answer)

**Template:** What {category} does this project use? (e.g., "What database does this project use?")

**Acceptable answers:** Values from `stack.{category}`.
