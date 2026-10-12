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
| arkive MCP server is connected | MCP resources (`architecture://session-context`, `architecture://overview`, …) | MCP tools (`update_architecture`, `record_decision`) |
| MCP not available | Read `arkive/architecture.json` directly | Edit `arkive/architecture.json` directly, validate manually |

To check if MCP is available: attempt to read `architecture://overview`. If it succeeds, use MCP for all reads/writes.

## The Two Rules

1. **Structure is derived. You author intent.**
2. **Read the document for context, never as an authority over the code.**

### 1. Structure is derived. You author intent.

`nodes[]` and `edges[]` that describe the module tree, the third-party packages,
and the import relationships between them are produced by static analysis —
`arkive reconcile --apply` once, `arkive watch` continuously. Every derived
element arrives carrying its own proof: `provenance: { derived: true, rule,
evidence: ["file:line"] }`.

What you write is what no rule can observe:

| You author | Why it is yours |
|---|---|
| `summary` on a node | What a module is *for*. Derivation sets it to `""` rather than invent prose. |
| `owner` | A person or team decided this. Nothing in the code says so. |
| `stack` | What you consider the technology stack, not what a manifest happens to contain. |
| `dataFlows` | A user-facing story across components. No parser reads intent. |
| `decisions` | The artifact the product exists to preserve: what was chosen, why, and **what was rejected**. |
| `service` / `datastore` / `endpoint` nodes | A boundary the code does not declare. |
| `derives_from` edges | "This came from that one" is a claim nothing observes. |
| `note` on any edge | Context a reader needs and a scan cannot supply. |

Author those with `provenance: { derived: false, authoredBy: "agent" }` (or
`"human"` when the user said it). `arkive` refuses an element that claims to be
derived without `evidence`, so the two branches cannot be confused.

**A transcribed edge is a claim nothing checks.** If you hand-write an `imports`
edge from reading the code, you have created a second source of truth that
drifts from the first one from the next commit onward, and nothing will tell you.
Run `arkive reconcile` instead and let the rule that read the import statement
write the edge with the line number attached.

### 2. Read the document for context, never as an authority over the code.

Read `arkive/architecture.json` at session start to learn what exists and why.
Then treat the code as the thing that is true.

- When the document and the code disagree, the code is right and the document
  has drifted. Run `arkive reconcile` and take the derived half from the scan.
- The authored half — decisions, rationale, rejected alternatives — is the part
  the code cannot tell you, and the reason to read the file at all.
- A decision whose `subjects` no longer resolve is not stale bookkeeping. It is
  a decision that explains something you just deleted. Read it before you
  delete, and record a new decision if the deletion was a choice.

## Lifecycle Hooks (NON-NEGOTIABLE)

These hooks govern your behavior for the ENTIRE session, not just during explicit architecture work.

### session_start (BEFORE anything else)
1. Check if `arkive/architecture.json` exists in the arkive/ directory.
2. If it exists: read `architecture://session-context` (MCP) or the file. This is your cross-session memory — the decisions, the rationale, the rejected alternatives.
3. If it does not exist: inform the user that arkive is not initialized. Suggest `/arkive-init`.
4. This step is NON-NEGOTIABLE. Do NOT skip it even if the user's first message seems urgent.

### post_major_change (IMMEDIATELY after any major change)
1. Re-read the document to get current state.
2. Run `npx @ericjdz/arkive reconcile --apply` so the derived half matches the code you just changed. Do NOT hand-edit `nodes[]` / `edges[]`.
3. Call `record_decision` for any architectural choice you made — with the alternative you rejected.
4. Append a `history` entry.

### pre_completion (BEFORE claiming work is done)
1. Run `npx @ericjdz/arkive reconcile --apply` once more.
2. Verify the derived half reflects the current code.
3. Verify the authored half reflects the current *intent* — any choice you made without a decision recorded.
4. Do NOT claim completion until both halves are current.

## What Counts as a Major Change

- Adding, removing, or replacing a service, datastore, or external API
- Changing how components communicate (new endpoints, protocol changes)
- Adding or modifying infrastructure (hosting, CI/CD, caching, CDN)
- Adopting a new library or framework for a significant function
- Refactoring that changes module boundaries or data flow

## Writing Path

### Via MCP tools
1. `update_architecture` with `nodes`, `edges`, `decisions`, `dataFlows`, or `stack`. Send a decision in the same call as the nodes it explains and it attaches to all of them — you never maintain the link by hand.
2. `record_decision` for a choice made outside a structural change. `subjects` names the nodes and edges it explains; omit them and the decision is recorded unattached, which `arkive reconcile` reports.
3. Never send `services`, `connections`, or `relatedServices`. They are computed from the graph and are overwritten on the next write.

### Via direct file editing
1. Read `arkive/architecture.json`.
2. Add or update `nodes[]` / `edges[]` **only** where derivation cannot reach — and give them `provenance: { derived: false, authoredBy: "agent" }`.
3. Add entries to `decisions[]` with `id`, `topic`, `decision`, `rationale`, `alternatives` (min 1, at least one with a non-empty `whyNot`), `timestamp`, `subjects`.
4. Append to `history` with `timestamp`, `action`, `summary`.
5. Leave `schemaVersion` at `2` and do not add a `version` string.
6. Write the complete valid JSON back.

## Schema Quick Reference

Full specification: `references/schema-guide.md`.

### Document
`{ schemaVersion: 2, project, stack, nodes, edges, decisions, dataFlows, history }`

### Node
```json
{
  "id": "kebab-case-id",
  "kind": "module|service|datastore|external|datastructure|endpoint",
  "name": "Human Readable Name",
  "summary": "What this is for. \"\" is honest.",
  "tech": "optional",
  "path": "optional",
  "owner": "optional",
  "provenance": { "derived": true, "rule": "ts-js/module-node", "evidence": ["src/x.ts:1"] }
}
```

### Edge
```json
{
  "id": "kebab-case-id",
  "from": "<node-id>",
  "to": "<node-id>",
  "kind": "imports|calls|reads|writes|derives_from",
  "label": "HTTP/REST",
  "note": "optional",
  "provenance": { "derived": true, "rule": "ts-js/import-edge", "evidence": ["src/x.ts:42"] }
}
```

`decided_by` is a projection of `decision.subjects` and is never stored.

### Provenance — exactly one of
```json
{ "derived": true,  "rule": "<rule-id>", "evidence": ["file:line"] }
{ "derived": false, "authoredBy": "agent|human", "reviewedAt": "optional ISO 8601" }
```

**No `confidence` field exists.** It was declared, read by two call sites, and
written by no code path — a number an LLM assigns to itself is not evidence.
`evidence: ["file:line"]` is. Do not add it back.

### Decision
```json
{
  "id": "dec-NNN",
  "topic": "What the decision is about",
  "decision": "What you chose",
  "rationale": "WHY — specific to this project's needs",
  "alternatives": [{ "name": "Alternative A", "whyNot": "Why this was rejected" }],
  "timestamp": "ISO 8601",
  "subjects": [{ "kind": "node|edge", "ref": "<id>" }]
}
```

At least one alternative with a non-blank `whyNot` is required. A decision
without one is an observation, not a decision.

### Data flow
```json
{ "name": "What the user is doing", "steps": [{ "actor": "node-id", "action": "What happens" }] }
```

### History (append on every update)
```json
{ "timestamp": "ISO 8601", "action": "reconciliation", "summary": "One line", "agent": "optional" }
```

## MUST NOT

- Do NOT write `services[]`, `connections[]`, or `decisions[].relatedServices`. They are a computed view of `nodes[]` / `edges[]`, regenerated from the graph on every write — anything you put there is silently replaced.
- Do NOT transcribe the module tree, the dependency list, or the import graph by hand. Run `npx @ericjdz/arkive reconcile --apply`.
- Do NOT assert `derived: true` on something you inferred. Derivation means a rule read a specific site, and the site is named in `evidence`.
- Do NOT add `confidence` or `source`. Neither exists in v2.
- Do NOT author a `decided_by` edge. It is computed from `decision.subjects`.
- Do NOT delete a decision because its subjects stopped resolving. Report it and ask.
- Do NOT update the document for non-architectural changes (typos, formatting, variable renames, test-only changes, comment edits).
- Do NOT record decisions without a rejected alternative — a decision with no `whyNot` is a default, not a decision.

## Prompt Queue

Users can queue architecture change prompts from the web viewer, scoped to specific nodes.

### MCP Tools

- `list_prompts` — List all queued prompts (optionally filter by status: pending, claimed, done, failed)
- `claim_next_prompt` — Atomically claim the oldest pending prompt. Returns the prompt text and target node IDs.
- `ack_prompt` — Mark a claimed prompt as done or failed after execution.

### MCP Resource

- `architecture://prompts` — Read-only view of all queued prompts with summary counts.

### Workflow

1. User opens the viewer (`arkive serve`) and selects nodes
2. User writes prompts scoped to those nodes
3. User clicks "Copy All" to paste into agent chat, OR the agent reads `architecture://prompts`
4. Agent calls `claim_next_prompt` to get the next prompt
5. Agent executes the prompt, running `reconcile --apply` and recording decisions as needed
6. Agent calls `ack_prompt` with outcome "done" or "failed"
7. Repeat until queue is empty

## Reference

See `references/schema-guide.md` for the complete schema specification.