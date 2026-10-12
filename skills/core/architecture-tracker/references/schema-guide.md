# `arkive/architecture.json` — schema guide (v2)

The document is a **graph**: `nodes[]` and `edges[]` are the structure, and
everything a parser can read out of the code is derived from the code rather than
written by a person or an agent. What a human writes is intent.

## Top-level structure

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | integer | Yes | Must be exactly `2`. The only discriminator. |
| `project` | object | Yes | `{ name, description, created, lastUpdated }` |
| `stack` | object | Yes | Five string arrays — see below |
| `nodes` | array | Yes | The structure. Authoritative. |
| `edges` | array | Yes | The relationships. Authoritative. |
| `decisions` | array | Yes | What was chosen, why, and what was rejected |
| `dataFlows` | array | Yes | Important user-facing flows, step by step |
| `history` | array | Yes | Chronological change log |

```json
{
  "schemaVersion": 2,
  "project": {
    "name": "<project-name>",
    "description": "<one sentence>",
    "created": "<ISO 8601 now>",
    "lastUpdated": "<ISO 8601 now>"
  },
  "stack": { "language": [], "runtime": [], "framework": [], "database": [], "infrastructure": [] },
  "nodes": [],
  "edges": [],
  "decisions": [],
  "dataFlows": [],
  "history": [
    { "timestamp": "<ISO 8601 now>", "action": "initial_scaffold", "summary": "Architecture document created" }
  ]
}
```

`schemaVersion` has no default, so a v1 file fails to parse loudly instead of
being accepted by the wrong reader. The v1 `version` string (the semver
`1.0.0`) is gone — it was a defaulted value nothing branched on. `arkive`
migrates an old file to v2 in memory on read and persists the upgrade on the
next write.

## Node

```json
{
  "id": "kebab-case-id",
  "kind": "module",
  "name": "Human Readable Name",
  "summary": "What this node is for. Empty string is honest when nothing observed one.",
  "tech": "Specific tech (optional)",
  "path": "src/schema (meaningful for kind: module, optional)",
  "owner": "Free text, set by humans, read by nobody (optional)",
  "deletedAt": "<ISO 8601>",
  "provenance": { "derived": true, "rule": "ts-js/module-node", "evidence": ["src/schema/graph.ts:1"] }
}
```

| Key | Required | Notes |
|---|---|---|
| `id` | Yes | Unique. Ids are the join key for edges and decision subjects. |
| `kind` | Yes | One of the six below. |
| `name` | Yes | |
| `summary` | Yes | May be `""`. Derivation sets it empty rather than inventing prose. |
| `tech`, `path`, `ports`, `owner` | No | |
| `deletedAt` | No | A tombstone. Removal is soft, in one transactional write. |
| `provenance` | Yes | Exactly one of the two shapes below. |

### Node kinds

| Kind | What it is | Derived automatically? |
|---|---|---|
| `module` | A file or a directory that contains code | Yes — directory tree and import graph |
| `external` | A third-party package, per ecosystem | Yes — package identity from import specifiers |
| `datastructure` | A shape worth naming: fields, types, structure | Partly — the shape is read, the meaning is yours |
| `service` | A deployable boundary | Only where one is mechanically detectable |
| `datastore` | Persistent state | Only as evidence — "this is our primary datastore" is intent |
| `endpoint` | A route or exposed interface | Route registration only; public vs internal is yours |

The v1 `type` enum is deleted — the twelve deployment labels (a frontend, a
backend, a database, a cache, a queue, and so on). It was a taxonomy of
deployment concerns that overlapped `kind` and answered no structural question.
A cache is a `datastore`; a queue is a `datastore` with an `endpoint` on it.

## Edge

```json
{
  "id": "kebab-case-id",
  "from": "<node-id>",
  "to": "<node-id>",
  "kind": "imports",
  "label": "HTTP/REST",
  "note": "Human note. Not consumed by any traversal.",
  "provenance": { "derived": true, "rule": "ts-js/import-edge", "evidence": ["src/cli/index.ts:5", "src/cli/index.ts:9"] }
}
```

| Key | Required | Notes |
|---|---|---|
| `id` | Yes | Unique. Decision subjects can name edges too. |
| `from`, `to` | Yes | Both node ids. An endpoint that resolves to nothing is preserved as `dangling: true`, not dropped. |
| `kind` | Yes | One of the six below. |
| `label` | No | Transport naming only (`"HTTP/REST"`, `"stdio"`). Never semantic — `kind` is. |
| `note` | No | Human note. |
| `provenance` | Yes | |

### Edge kinds

| Kind | Meaning | Derived? |
|---|---|---|
| `imports` | Importer → imported | Yes. Evidence is every site it came from. |
| `calls` | A static call site | Yes. Dynamic dispatch is an acknowledged limit. |
| `reads` / `writes` | Datastore access visible at a call site | Partly. Access hidden behind an ORM is yours. |
| `derives_from` | "This came from that one" | No. No parser observes it. |
| `decided_by` | A decision explains this node | **Never stored.** It is computed by joining `decision.subjects` against the graph. Authoring one is a validation warning, not an edge. |

## Provenance — required on every node and edge

Exactly one of two shapes, discriminated on `derived`. Mixing the branches'
keys is a hard parse error.

```json
{ "derived": true,  "rule": "<rule-id>", "evidence": ["src/x.ts:42"] }
{ "derived": false, "authoredBy": "agent" | "human", "reviewedAt": "<ISO 8601>" }
```

**There is no `confidence` field, and adding one back is a mistake.** It existed
in v1, was declared on every service and connection, read by two call sites, and
written by no code path in the repository — the drift warning it triggered could
only fire if an agent voluntarily obeyed a markdown instruction. A number an
LLM assigns to itself is not evidence. `evidence: ["src/x.ts:42"]` is: anyone
can open it.

Evidence is an array because one import edge between two directories has many
sites. An evidence entry without a `:line` produces an
`evidence-without-location` warning — provenance is only evidence if whoever
reads it can open it.

Rule ids are `"<extractor>/<rule>"`, e.g. `ts-js/module-node`,
`directory/module-node`, `ts-js/import-edge`, `python/external-node`.

## Decision

```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY you chose it — specific to this project's needs",
  "alternatives": [{ "name": "Alternative A", "whyNot": "Why this was rejected" }],
  "timestamp": "2026-01-01T00:00:00.000Z",
  "subjects": [{ "kind": "node", "ref": "kebab-case-id" }]
}
```

- `alternatives` needs at least one entry **with a non-empty `whyNot`**. A record
  with no rejected alternative is an observation, not a decision.
- `subjects` replaces v1's `relatedServices`. It names **nodes and edges**, so a
  decision can explain a relationship as well as a component. Ids are the same
  strings, so a v1 list moves across mechanically.
- A subject that no longer resolves is a warning (`unresolved-subject`), never a
  delete. A decision that explains something which no longer exists is reported,
  because silently dropping it is the same class of loss as destroying a file.
- `relatedServices` is now a computed projection of the `kind: "node"` subjects,
  kept only so pre-v2 readers keep working. Send `subjects`.

## The deprecated view — read it, never write it

`services[]` and `connections[]` still appear in the file. They are **computed
from `nodes[]` / `edges[]` on every read and rewritten from the graph on every
write.** An edit to a stored copy is folded back into the graph and then
overwritten by the recomputed projection, so your change disappears on the next
write without a warning.

Same for `decisions[].relatedServices`, which is the `kind: "node"` subjects.

If a tool asks you for `services` or `connections`, send `nodes` and `edges`.

## Validation rules

Hard errors — the write is refused:

1. Duplicate `nodes[].id`, `edges[].id`, or `decisions[].id`.
2. An edge endpoint that names no node, or names a tombstoned one.
3. An authored element with no `provenance`, or with a `provenance` that mixes
   the derived and authored branches.
4. An element that claims to be derived with no `evidence`.

Warnings — the write succeeds and the finding is reported:

1. `dangling-edge` — an edge preserved from before, pointing at something gone.
2. `unresolved-subject` — a decision explaining something that no longer exists.
3. `evidence-without-location` — an evidence string with no `file:line`.
4. `tombstoned-node` — a node removed but kept.
5. `decided-by-stored` — a `decided_by` edge written into the file. Recompute
   it from `subjects`; it is not stored.

## Stack categories

| Category | Examples |
|---|---|
| `language` | TypeScript, Python, Go, Rust |
| `runtime` | Node.js, Bun, Deno, Browser |
| `framework` | Next.js, Express, Django, FastAPI |
| `database` | PostgreSQL, MongoDB, Redis, SQLite |
| `infrastructure` | Vercel, AWS, Docker, Cloudflare |

All five keys are required and may be empty arrays. There are no defaults, so a
stack with no `database` key has no `database` key and a write does not invent
one.

## History

```json
{ "timestamp": "ISO 8601", "action": "reconciliation", "summary": "One line", "agent": "optional" }
```

Capped at 50 entries. When entries are dropped the document carries
`"historyTruncated": true` and the flag is sticky: once a document says it was
truncated, it says so until a human removes it. The durable record is git.