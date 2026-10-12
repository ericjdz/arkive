# Architecture-Tracked Project (arkive — lightweight mode)

This repo uses a living architecture document, `arkive/architecture.json`. You — the AI coding agent — are responsible for keeping it in sync with the code.

> **You are using the lightweight, drop-in version of arkive.** No MCP server, no web viewer, no Learning Mode — just this file and the JSON. To upgrade, run `npx @ericjdz/arkive init` (see "Upgrade" at the bottom).

## The Two Rules

1. **Structure is derived. You author intent.**
2. **Read the document for context, never as an authority over the code.**

### 1. Structure is derived. You author intent.

The module tree, the third-party packages, and the import graph are read out of the code by static analysis. Run it:

```bash
npx @ericjdz/arkive reconcile --apply
```

It writes `nodes[]` and `edges[]`, each carrying its own proof:
`"provenance": { "derived": true, "rule": "ts-js/module-node", "evidence": ["src/x.ts:1"] }`.

Hand-transcribing that same structure creates a second source of truth that
drifts from the first one on the next commit, and nothing will report the drift.
The code is the source of truth. The document is a record of it, plus the things
the code cannot say.

What you write is what no rule can observe:

| You author | Why it is yours |
|---|---|
| `summary` on a node | What a module is *for*. Derivation sets it to `""` rather than invent prose. |
| `owner` | A person or team decided this. Nothing in the code says so. |
| `stack` | What you consider the stack, not what a manifest happens to contain. |
| `dataFlows` | A user-facing story across components. |
| `decisions` | What was chosen, why, and **what was rejected**. |
| `service` / `datastore` / `endpoint` nodes | A boundary the code does not declare. |
| `derives_from` edges | "This came from that one" is a claim nothing observes. |
| `note` on any element | Context a reader needs and a scan cannot supply. |

Give each of those `"provenance": { "derived": false, "authoredBy": "agent" }`.
Use `"authoredBy": "human"` when the user told you directly.

### 2. Read the document for context, never as an authority over the code.

Read it at session start to learn what exists and why. Then treat the code as
what is true.

- When the document and the code disagree, the code is right. Run `reconcile --apply`.
- The authored half — decisions, rationale, rejected alternatives — is what the code cannot tell you, and the reason to read the file at all.
- A decision whose `subjects` no longer resolve is a decision that explains something you just deleted. Read it before you delete, and record a new decision if the deletion was a choice.

## The Three Rules

1. **On every session start**: Read `arkive/architecture.json` — it is your memory across sessions, compaction, and model switches.
2. **Before any major change**: re-read `arkive/architecture.json` to learn what already exists and why, and read the decisions attached to the part you are about to touch.
3. **After any major change**: run `npx @ericjdz/arkive reconcile --apply`, append a `history` entry, and record the decision if one was made.

**Before claiming any task is complete**: re-run `reconcile --apply`. Confirm the derived half matches the code and the authored half carries every choice you made. If either does not, you are not done.

## What Counts as a Major Change

- Adding, removing, or replacing a service, datastore, or external API
- Changing how components communicate (new protocols, new endpoints)
- Adding or modifying infrastructure (hosting, CI/CD, caching, CDN)
- Adopting a new framework or major library for a significant function
- Refactoring that changes module boundaries or data flow

After any of them: run `reconcile --apply`, append a `history` entry, and record the decision.

## Bootstrapping `arkive/architecture.json` From Scratch

If `arkive/architecture.json` does not exist yet, create it with this exact structure:

```json
{
  "schemaVersion": 2,
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
  "nodes": [],
  "edges": [],
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

`schemaVersion` must be exactly `2`, and there is no `version` string — that field
is from v1, and its absence is what makes a v1 file fail loudly rather than
being read by the wrong parser.

If the project already has code, derive the structure rather than describing it:

```bash
npx @ericjdz/arkive reconcile --apply
```

Then fill in what the scan cannot know: a `summary` for each significant node, the `stack`, and any decision the code makes obvious (`package.json` → a framework choice; a Dockerfile → a deployable boundary; a migration folder → a datastore).

## Schema Reference

### Node

```json
{
  "id": "kebab-case-id",
  "kind": "module|service|datastore|external|datastructure|endpoint",
  "name": "Human Readable Name",
  "summary": "What this node is for. \"\" is honest when nothing observed one.",
  "tech": "Specific tech (optional)",
  "path": "src/schema (meaningful for module, optional)",
  "owner": "optional",
  "provenance": { "derived": true, "rule": "ts-js/module-node", "evidence": ["src/schema/graph.ts:1"] }
}
```

`tech`, `path`, `ports`, `owner`, `deletedAt` are optional. `summary` is required
and may be an empty string.

### Edge

```json
{
  "id": "kebab-case-id",
  "from": "<node-id>",
  "to": "<node-id>",
  "kind": "imports|calls|reads|writes|derives_from",
  "label": "HTTP/REST",
  "note": "optional human note",
  "provenance": { "derived": true, "rule": "ts-js/import-edge", "evidence": ["src/cli/index.ts:5", "src/cli/index.ts:9"] }
}
```

`label` is transport naming only (`"HTTP/REST"`, `"stdio"`) and is never used for
semantics — `kind` is.

`decided_by` is a projection: it is computed by joining `decision.subjects`
against the graph and is never stored. Writing one produces a validation warning.

### Provenance — exactly one shape, required on every node and edge

```json
{ "derived": true,  "rule": "<rule-id>", "evidence": ["src/x.ts:42"] }
{ "derived": false, "authoredBy": "agent|human", "reviewedAt": "<ISO 8601>" }
```

Mixing the two branches' keys is a hard parse error. Claiming `derived: true`
without `evidence` is refused.

**There is no `confidence` field and you must not add one.** It existed in v1 on
every service and connection. Two call sites read it; no code path in the
repository ever wrote it — the drift warning it triggered could only fire if an
agent voluntarily followed a markdown instruction. A number an LLM assigns to
itself is not evidence. `evidence: ["src/x.ts:42"]` is: anyone can open it and
check.

### Decision (the most important — never skip)

```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY you chose it — specific to this project's needs",
  "alternatives": [
    { "name": "Alternative A", "whyNot": "Why this was rejected" }
  ],
  "timestamp": "2026-01-01T00:00:00.000Z",
  "subjects": [
    { "kind": "node", "ref": "kebab-case-id" }
  ]
}
```

At least one alternative must carry a non-empty `whyNot`. A record with no
rejected alternative is an observation, not a decision.

`subjects` names **nodes and edges**, so a decision can explain a relationship as
well as a component. The ids are the same strings the old field used, so a
`relatedServices` list moves across mechanically. A subject that no longer
resolves is reported, never deleted.

### History entry (append on every change)

```json
{
  "timestamp": "<ISO 8601>",
  "action": "reconciliation|architecture_decision|refactor|...",
  "summary": "One-line summary",
  "agent": "optional"
}
```

Capped at 50 entries. When entries are dropped the document carries
`"historyTruncated": true` and keeps saying so until a human removes it.

## The fields you must not write

`services[]` and `connections[]` may appear in the file. They are a **derived
view**, computed from `nodes[]` / `edges[]` on every read and rewritten from the
graph on every write. `decisions[].relatedServices` is likewise computed from the
`kind: "node"` subjects.

Anything you put in them is folded back into the graph, then replaced by the
recomputed projection on the next write — silently. Send `nodes` and `edges`
instead.

## Validation Rules

1. Node, edge, and decision ids are unique.
2. Every `edge.from` / `edge.to` names a node that exists. An endpoint that resolves to nothing is preserved as `dangling: true` and reported, not dropped.
3. Every derived element cites `evidence` with a `file:line` someone can open.
4. All timestamps are ISO 8601. `project.lastUpdated` is set on every write.

## MCP Server (if arkive is installed)

If arkive is installed in this project, prefer MCP tools over direct file editing:

- `update_architecture` — add or remove `nodes`, `edges`, `decisions`, `dataFlows`, `stack`. A decision sent in the same call attaches to everything that call created.
- `record_decision` — record a decision with rationale, a rejected alternative, and the nodes/edges it explains.
- `why_does_this_exist` — resolve a node id to the decisions that explain it, and the provenance of each claim.
- `check_drift` — static analysis comparing the document against the code.

To check: attempt to read `architecture://overview`. If it succeeds, use MCP for all reads/writes.

To install arkive and enable MCP:

```bash
npx @ericjdz/arkive init
npx @ericjdz/arkive install <platform>
```

Supported platforms: `claude-desktop`, `claude-code`, `cursor`, `opencode`, `vscode`, `windsurf`, `cline`

## Upgrade to the Full Experience

To get the MCP server (richer agent context), interactive web viewer, and Learning Mode:

```bash
npx @ericjdz/arkive init
npx @ericjdz/arkive serve
```

Documentation: https://github.com/arkive/arkive