# Architecture-Tracked Project (arkive — lightweight mode)

This repo uses a living architecture document, `arkive/architecture.json`. You — the AI coding agent (Codex, OpenCode, Copilot, or any AGENTS.md-aware tool) — are responsible for keeping it in sync with the code.

> **Lightweight mode.** No MCP server, no viewer. Just this file and the JSON. To upgrade, run `npx @ericjdz/arkive init`.

## The Two Rules

1. **Structure is derived. You author intent.** The module tree, the third-party packages, and the import graph are produced by static analysis (`npx @ericjdz/arkive reconcile --apply`). You record what the code cannot tell you: `summary`, `owner`, `stack`, `dataFlows`, and decisions with their rationale and rejected alternatives.
2. **Read the document for context, never as an authority over the code.** When it and the code disagree, the code is right — run `reconcile` and take the derived half from the scan.

## Bootstrap

If `arkive/architecture.json` is missing, create it with this structure:

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

`schemaVersion` must be exactly `2` and there is no v1 `version` string. A document carrying one is a v1 file that this build refuses to write over — keep the integer.

Then derive the structure from the code:

```bash
npx @ericjdz/arkive reconcile --apply
```

That reads the directory tree and the import graph and writes `nodes[]` and `edges[]` with provenance — `{"derived": true, "rule": "...", "evidence": ["src/x.ts:42"]}` — for every element it produces. You do not transcribe that part yourself.

Then record the intent the scan cannot see: what each significant component is *for* (`summary`), who owns it (`owner`), the `stack` as you understand it, and any decision that was made.

## Major Changes

Add/remove a service, datastore, or external API · change communication protocols · modify infrastructure · adopt a new framework · refactor module boundaries.

**Before any major change**, re-read `arkive/architecture.json` to learn what exists and why.

**After any major change**: run `npx @ericjdz/arkive reconcile --apply`, append a `history` entry, and record the decision if one was made.

## Schema (compact)

- **Node**: `{ id, kind, name, summary, provenance }`
  - `kind`: `module | service | datastore | external | datastructure | endpoint`
  - `tech`, `path`, `ports`, `owner`, `deletedAt` are optional.
- **Edge**: `{ id, from, to, kind, provenance }`
  - `kind`: `imports | calls | reads | writes | derives_from`. `decided_by` is computed from `decision.subjects` and is never stored. `label` is transport naming only, never semantic.
- **Provenance** (required on every node and edge, exactly one shape):
  - `{ "derived": true, "rule": "<rule-id>", "evidence": ["file:line"] }`
  - `{ "derived": false, "authoredBy": "agent | human", "reviewedAt": "<ISO 8601>" }`
  - **There is no `confidence` field.** It was declared and read but written by no code path; a number an LLM assigns to itself is not evidence. `evidence: ["file:line"]` is.
- **Decision**: `{ id, topic, decision, rationale, alternatives[{name, whyNot}], timestamp, subjects[{kind: "node|edge", ref}] }`
  - MUST include at least one rejected alternative with a non-empty `whyNot`.
  - `subjects` replaces the old `relatedServices` and can name edges as well as nodes.
- **DataFlow**: `{ name, steps[{actor, action}] }`
- **History entry**: `{ timestamp, action, summary, agent? }`

`services[]` and `connections[]` may appear in the file. They are a **derived view computed from `nodes[]` / `edges[]` on every read and rewritten from the graph on every write.** Never write to them — anything you put there is replaced on the next write without a warning.

## Rules of the Road

- Node and edge ids are unique. Every `edge.from` / `edge.to` names a node that exists.
- Every derived element cites `evidence` with a `file:line` someone can open.
- Every architectural choice records at least one rejected alternative with `whyNot`.
- A decision whose `subjects` no longer resolve is reported, never deleted.
- All timestamps are ISO 8601. `project.lastUpdated` updates on every write.
- `history[]` is capped at 50 entries; a truncated document says `"historyTruncated": true` and keeps saying so until a human removes it.

## CLI

- `npx @ericjdz/arkive reconcile --apply` — derive structure from the code and write it
- `npx @ericjdz/arkive reconcile` — report drift without writing anything
- `npx @ericjdz/arkive watch` — re-derive on every change
- `npx @ericjdz/arkive status` — counts, schema version, drift verdict
- `npx @ericjdz/arkive export <markdown|mermaid>` — export
- `npx @ericjdz/arkive serve` — MCP server + web viewer

## MCP Server (if arkive is installed)

If arkive is installed, prefer MCP tools over direct file editing:

- `update_architecture` — add/remove `nodes`, `edges`, `decisions`, `dataFlows`, `stack`. A decision in the same call attaches to everything that call created.
- `record_decision` — record a decision with rationale, a rejected alternative, and the nodes/edges it explains
- `why_does_this_exist` — resolve a node id to the decisions that explain it, with each claim's provenance
- `check_drift` — static analysis comparing the document against the code

Do not send `services`, `connections`, or `relatedServices`: they are computed from the graph and overwritten on write.

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