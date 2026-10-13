# arkive

> A living architecture document for AI-built projects.
> Your AI agent maintains it. You finally understand what was built.

[![npm version](https://img.shields.io/npm/v/@ericjdz/arkive.svg)](https://www.npmjs.com/package/@ericjdz/arkive)
[![license](https://img.shields.io/npm/l/@ericjdz/arkive.svg)](./LICENSE)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot, Codex, OpenCode) build entire projects from a single prompt. You ship fast — but you can't explain why your project uses Postgres over Mongo, microservices over a monolith, or REST over GraphQL. The agent decided. You accepted. Across sessions, the agent has no memory of what was built and re-derives (or hallucinates) the architecture every time.

arkive solves both problems with one artifact: a structured `arkive/architecture.json` that lives in your repo. The agent reads it on session start (instant onboarding, no context rot), updates it after every major change (always-current docs), and you browse it in a single-file graph viewer (finally understand your own project).

## Quick Start

```bash
# Initialize a project
npx @ericjdz/arkive init

# Or with curl
curl -fsSL https://raw.githubusercontent.com/ericjdz/arkive/main/scripts/install.sh | bash

# Derive the structure from the code and write it
npx @ericjdz/arkive reconcile --apply

# Start the MCP server + web viewer
npx @ericjdz/arkive serve

# Open Learning Mode (Socratic gating)
npx @ericjdz/arkive learn
```

After `init`, your repo gains:

- `arkive/architecture.json` — the document
- `arkive/history/` — content-hashed snapshots, capped at 10 distinct states
- `arkive/context/sessions/` — bounded session context
- A tracking block injected into your existing `CLAUDE.md` and `AGENTS.md` (created if missing)
- `.cursor/rules/architecture-tracker.mdc` — Cursor auto-apply rule

arkive extends your existing instruction files — it never overwrites them. Use `--standalone` to generate full instruction files instead.

Your AI agent will now read and maintain `arkive/architecture.json` automatically.

## Get Started with Your AI Agent

Copy and paste this into your AI agent (Claude Code, Cursor, Copilot, OpenCode, etc.):

```
Install arkive for architecture tracking in this project. Read the instructions at https://github.com/ericjdz/arkive and follow the "For Agents — Self-Install Guide" section. Ask me which AI platform I use, then set up MCP and skills.
```

## Features

- **Cross-session memory for AI agents** — the architecture file survives compaction, session resets, and model switches.
- **Derived structure, authored intent** — the module tree, the dependency set, and the import graph are read out of the code by static analysis. Your agent records what the code cannot say: what a component is *for*, who owns it, and what was chosen over what.
- **Provenance you can open** — every node and edge carries either the rule that derived it and the `file:line` it read, or the name of whoever authored it.
- **MCP server** — agents pull live architecture context via the Model Context Protocol (stdio + HTTP).
- **Single-file graph viewer** — `arkive export html` writes one self-contained `arkive/graph.html`: topology with deterministic layout, node selection (edges by kind, data shapes, decisions with provenance), text filter, and `?node=<id>` deep links. No build step, no runtime dependencies, opens from `file://`.
- **Decisions are first-class** — every architectural choice records what was chosen, why, what was rejected, and which nodes and edges it explains.
- **Honest diagnostics** — `arkive reconcile` reports what derivation would change and what a human's claim no longer supports, and prints the scan's own coverage so a partial scan never reads as a clean bill of health.
- **Continuous reconciliation** — `arkive watch` re-derives on every change.
- **Learning Mode** — Socratic gating that quizzes you on architectural decisions and tracks concept mastery.
- **Multi-platform** — Claude Code (marketplace + CLAUDE.md), Cursor (.cursor/rules), Codex / OpenCode / Copilot (AGENTS.md), or any agent via the MCP server.
- **Try before you install** — drop the standalone `CLAUDE.md` or `AGENTS.md` into any repo and your agent maintains the doc with no install.

## Prompt Queue

The prompt queue lets you direct your AI agent with scoped architecture prompts.

1. Queue a prompt via the MCP `prompts` tool or `POST /api/prompts` on a running server (`npx @ericjdz/arkive serve`)
2. Let the agent read `architecture://prompts` directly, or paste the prompt into its chat
3. The agent claims prompts via the `prompts` tool (`claim`), executes them, and acknowledges with `prompts` (`ack`)

Prompts are stored in `arkive/prompt-queue.json` and survive session resets.

## CLI Reference

| Command | Action |
|---|---|
| `npx @ericjdz/arkive init` | Scaffold `arkive/architecture.json`, inject tracking blocks, auto-detect platform, register MCP, install skills |
| `npx @ericjdz/arkive init --platform <p>` | Same as above, but explicitly specify the platform instead of auto-detecting |
| `npx @ericjdz/arkive init --standalone` | Generate full `AGENTS.md`/`CLAUDE.md` files (for platforms without MCP) |
| `npx @ericjdz/arkive install <platform>` | Register MCP server in your AI platform config |
| `npx @ericjdz/arkive install-skill <platform>` | Install arkive skills for your AI platform (8 skills: architecture tracking, init, import, view, prompt queue, learning, decisions, reconciliation) |
| `npx @ericjdz/arkive serve` | Start the MCP server and serve the graph artifact (`arkive/graph.html`) |
| `npx @ericjdz/arkive serve --stdio` | Run the MCP server in stdio mode (for direct agent integration) |
| `npx @ericjdz/arkive status` | Counts, schema version, drift warnings, and a conclusive/inconclusive verdict |
| `npx @ericjdz/arkive reconcile` | Derive the graph from the code, report the delta and the authored findings, write nothing |
| `npx @ericjdz/arkive reconcile --apply` | The same, and persist the derived half |
| `npx @ericjdz/arkive watch` | Re-derive on every change and report the delta |
| `npx @ericjdz/arkive export <format>` | Export as `markdown`, `mermaid`, or self-contained `html` (writes `arkive/graph.html`) |
| `npx @ericjdz/arkive learn` | Open the web viewer in Learning Mode |
| `npx @ericjdz/arkive stop` | Stop a running viewer |
| `npx @ericjdz/arkive hooks` | Install the git hooks (not installed by `init`) |
| `npx @ericjdz/arkive hooks --remove` | Remove them |
| `npx @ericjdz/arkive hooks --claude` | Install the Claude Code agent hooks in `.claude/settings.json` |

Run `npx @ericjdz/arkive <command> --help` for command-specific options.

`arkive status` and `arkive reconcile` exit non-zero when the scan is
inconclusive. That is the intended behaviour — it is what stops a partial scan
from reporting as a clean one — but it will surface in CI that gates on their
exit code.

## Configuration

`init` accepts the following flags:

- `--name <name>` — project name (defaults to directory name)
- `-d, --dir <path>` — target directory (defaults to current directory)
- `--description <text>` — project description
- `--standalone` — write full instruction files instead of injecting a block
- `--platform <platform>` — AI platform (auto-detected if omitted): claude-desktop, claude-code, cursor, opencode, vscode, windsurf, cline
- `--skip-mcp` — skip MCP server registration
- `--skip-skills` — skip skill installation
- `--skip-hooks` — skip git hook installation (hooks are not installed by default)
- `--dry-run` — print every path `init` would write, and write nothing

`serve` accepts:

- `--stdio` — run the MCP server over stdio (no HTTP, no viewer)
- `-p, --port <n>` — HTTP/viewer port (default: 4567)
- `--no-open` — do not auto-open the browser

`reconcile` accepts:

- `--apply` — persist the derived half. Off by default: `reconcile` is a diagnostic, and `arkive watch` is where continuous persistence belongs.
- `--include <path>` / `--exclude <path>` — narrow or prune the scan. Repeatable, and overrides `arkive.config.json`.
- `--no-graph` — suppress the derived-graph summary

The architecture document lives at `./arkive/architecture.json` by default. A
document at `./architecture.json` is a v1 file at a path arkive no longer
reads, and `init` refuses to run rather than scaffolding a second one beside
it.

## Distribution Surfaces

| Surface | Install path |
|---|---|
| npm | `npx @ericjdz/arkive init` |
| Claude Code marketplace | Add `arkive` from the Claude Code plugin marketplace |
| Cursor | `init` writes `.cursor/rules/architecture-tracker.mdc` |
| Codex / OpenCode / Copilot | `init` writes `AGENTS.md` |
| Claude Code (manual) | `init` writes `CLAUDE.md` |
| curl | `curl -fsSL .../install.sh \| bash` |
| Lightweight (no install) | Drop the root `CLAUDE.md` or `AGENTS.md` from this repo into yours |

## Architecture Document Schema

`arkive/architecture.json` is a **graph**. Structure is derived from the code;
intent is authored. Validated by Zod. See `src/schema/graph.ts` and
`src/schema/provenance.ts` for the full schema.

```json
{
  "schemaVersion": 2,
  "project": { "name": "...", "description": "...", "created": "...", "lastUpdated": "..." },
  "stack": { "language": [], "runtime": [], "framework": [], "database": [], "infrastructure": [] },
  "nodes": [],
  "edges": [],
  "decisions": [],
  "dataFlows": [],
  "history": []
}
```

| Field | What it holds |
|---|---|
| `schemaVersion` | Must be exactly `2`. The only discriminator, and it has no default — a v1 file fails to parse loudly rather than being read by the wrong parser. |
| `project` | Name, description, timestamps. |
| `stack` | Five string arrays. |
| `nodes` | The structure. **Authoritative.** |
| `edges` | The relationships. **Authoritative.** |
| `decisions` | What was chosen, why, what was rejected, and which elements it explains. |
| `dataFlows` | User-facing flows, step by step. |
| `history` | Chronological change log, capped at 50 entries. |

### Nodes

`{ id, kind, name, summary, provenance }`, plus optional `tech`, `path`, `ports`,
`owner`, `deletedAt`.

Six kinds: `module` · `service` · `datastore` · `external` · `datastructure` · `endpoint`.

The v1 `type` enum is gone — the twelve deployment labels (a frontend, a
backend, a database, a cache, a queue, and so on). It was a taxonomy of
deployment concerns that overlapped `kind` and answered no structural question.
A cache is a `datastore`; a queue is a `datastore` with an `endpoint` on it.

### Edges

`{ id, from, to, kind, provenance }`, plus optional `label` (transport naming
only — never semantic), `note`, `dangling`.

Six kinds: `imports` · `calls` · `reads` · `writes` · `derives_from` ·
`decided_by`. `decided_by` is a **projection** of `decision.subjects` computed by
joining against the graph; it is never stored and never authored.

### Provenance — required on every node and edge

Exactly one of two shapes, discriminated on `derived`. Mixing the branches' keys
is a hard parse error, and claiming `derived: true` with no `evidence` is
refused.

```json
{ "derived": true,  "rule": "ts-js/module-node", "evidence": ["src/schema/graph.ts:1"] }
{ "derived": false, "authoredBy": "agent", "reviewedAt": "2026-01-01T00:00:00.000Z" }
```

**`confidence` is gone, and there is no replacement for it.** v1 declared
`source` and `confidence` on every service and connection. Two call sites read
them; **no code path in the repository ever wrote them.** They survived only
because a markdown instruction told agents to set them, so the drift warning
they triggered could fire only if an agent voluntarily obeyed prose. A number an
LLM assigns to itself is not evidence. `evidence: ["src/x.ts:42"]` is, because
anyone can open it and check.

### Decisions

`{ id, topic, decision, rationale, alternatives[{name, whyNot}], timestamp, subjects[{kind, ref}] }`

`subjects` replaces v1's `relatedServices` and names **nodes and edges**, so a
decision can explain a relationship as well as a component. The ids are the same
strings, so a `relatedServices` list moves across mechanically. At least one
alternative must carry a non-empty `whyNot`: a record with no rejected
alternative is an observation, not a decision.

A subject that no longer resolves is reported, never deleted. A decision that
explains something which no longer exists is the thing you most want to know.

### `services[]` and `connections[]` — read them, never write them

These fields still appear in the file. They are a **derived view**: computed
from `nodes[]` / `edges[]` on every read and rewritten from the graph on every
write. `decisions[].relatedServices` is likewise computed from the `kind: "node"`
subjects. They exist so a pre-v2 reader — an older arkive, the viewer, a human
in an editor — still gets a usable document.

An edit to a stored copy is folded back into the graph and then replaced by the
recomputed projection. **It disappears on the next write without a warning.** Send
`nodes` and `edges` instead.

### The rule this encodes

**Structure is derived. Agents and humans own intent. Anything structurally
derivable from the code is derived, never transcribed.**

An agent that hand-writes an `imports` edge has created a second source of truth
that drifts from the first one on the next commit, and nothing reports the
drift. An agent that runs `arkive reconcile --apply` gets an edge carrying the
line number it came from.

## For Agents — Self-Install Guide

> **This section is written for AI coding agents.** If you are an agent reading this README, follow the steps below to install arkive and register its MCP server in your platform. All commands are idempotent and safe to re-run.

### Step 1: Ask which platform the user uses

Before running init, ask the user which AI platform they use: `opencode`, `claude-code`, `cursor`, `vscode`, `windsurf`, `cline`, or `claude-desktop`. This determines how MCP and skills are configured.

### Step 2: Initialize arkive (does everything)

```bash
npx -y @ericjdz/arkive init --platform <platform>
```

This single command:
- Creates `arkive/architecture.json` (an empty v2 scaffold), `arkive/history/` and `arkive/context/sessions/`
- Injects tracking blocks into `AGENTS.md` and `CLAUDE.md` (created if missing)
- Creates `.cursor/rules/architecture-tracker.mdc`
- **Registers the MCP server** in the platform's config file
- **Installs 8 arkive skills** (architecture-tracker, arkive-init, arkive-import, arkive-view, process-prompts, learning-mode, explain-decisions, reconciliation)
- **Does not install git hooks.** Run `npx @ericjdz/arkive hooks` to opt in

If files already exist, they are not overwritten. If `--platform` is omitted, arkive auto-detects by checking for `opencode.json`, `.mcp.json`, `.cursor/`, `.vscode/`, or environment variables.

### Step 3: Verify

After initializing, verify the setup:

```bash
# CLI health check
npx @ericjdz/arkive status

# Verify MCP server starts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx -y @ericjdz/arkive serve --stdio
```

`status` must report `Schema: v2` and a **conclusive** verdict. The MCP response
should list eight tools: `update_architecture`, `record_decision`, `check_drift`,
`scaffold_project`, `open_viewer`, `prompts`, `why_does_this_exist`, `walkthrough`.

### Step 4: Derive the structure, then record the intent

After init, derive the document from the code — do not transcribe it.

```bash
npx @ericjdz/arkive reconcile --apply
```

This reads the directory tree and the import graph and writes `nodes[]` and
`edges[]`, each carrying `{"derived": true, "rule": "...", "evidence": ["file:line"]}`.
It prints the scan's coverage and the per-language breakdown, so you can see
what it did not read.

Then record what the scan cannot observe:

1. **Read** `package.json`, the folder structure, and the imports to understand the project
2. **Author intent**, via the `update_architecture` MCP tool (or by editing `arkive/architecture.json` directly): a `summary` for each significant node saying what it is *for*, `owner` where you know it, and the `stack` as you understand it
3. **Author boundaries** the code does not declare — a `service`, a `datastore`, an `endpoint`, a `derives_from` edge — with `"provenance": { "derived": false, "authoredBy": "agent" }`, or `"authoredBy": "human"` when the user confirmed it
4. **Record existing architectural decisions** via `record_decision`, each with at least one rejected alternative and a non-empty `whyNot`, and with `subjects` naming the nodes or edges it explains
5. **Do not write `services[]`, `connections[]`, or `relatedServices`.** They are a derived view of `nodes[]` / `edges[]` and anything you put in them is overwritten on the next write without a warning
6. **Do not write a `confidence` number.** There is no such field. Evidence is `["file:line"]`

**From this point forward**, after every change to the code's structure run `npx @ericjdz/arkive reconcile --apply`, and record the decision if one was made. `npx @ericjdz/arkive watch` does the re-derivation continuously if the user wants it on.

### Step 5: Use session context on every session start

Read `architecture://session-context` at the start of every session instead of `arkive/architecture.json` directly. It returns a ranked summary **bounded at 2,000 tokens — typically ~1,700 for a large project** — and prints its own measurement per section. It names what it dropped and points at the resource that returns the rest.

### Manual MCP Registration (if auto-detection fails)

If `init --platform` didn't register MCP correctly, you can register manually:

#### Claude Desktop

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "arkive": {
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"]
    }
  }
}
```

#### Claude Code

| Scope | Config path |
|---|---|
| Project | `.mcp.json` in repo root |
| User | `~/.claude.json` (Windows: `%USERPROFILE%\.claude.json`) |

```json
{
  "mcpServers": {
    "arkive": {
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"]
    }
  }
}
```

#### Cursor

| Scope | Config path |
|---|---|
| Project | `.cursor/mcp.json` |
| User | `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`) |

```json
{
  "mcpServers": {
    "arkive": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"]
    }
  }
}
```

#### OpenCode

| Scope | Config path |
|---|---|
| Project | `opencode.json` in repo root |
| User | `~/.config/opencode/opencode.json` |

```json
{
  "mcp": {
    "arkive": {
      "type": "local",
      "command": ["npx", "-y", "@ericjdz/arkive", "serve", "--stdio"],
      "enabled": true
    }
  }
}
```

#### VS Code Copilot

| Scope | Config path |
|---|---|
| Workspace | `.vscode/mcp.json` |
| User (macOS) | `~/Library/Application Support/Code/User/mcp.json` |
| User (Linux) | `~/.config/Code/User/mcp.json` |
| User (Windows) | `%APPDATA%\Code\User\mcp.json` |

```json
{
  "servers": {
    "arkive": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"]
    }
  }
}
```

#### Windsurf

| OS | Config path |
|---|---|
| macOS / Linux | `~/.codeium/mcp_config.json` |
| Windows | `%USERPROFILE%\.codeium\mcp_config.json` |

```json
{
  "mcpServers": {
    "arkive": {
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"]
    }
  }
}
```

#### Cline

| OS | Config path |
|---|---|
| All | `~/.cline/data/settings/cline_mcp_settings.json` |

```json
{
  "mcpServers": {
    "arkive": {
      "command": "npx",
      "args": ["-y", "@ericjdz/arkive", "serve", "--stdio"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Verify after manual registration

After registering, restart your agent session and verify the MCP tools are available:

```bash
# CLI health check (works without MCP)
npx @ericjdz/arkive status

# Verify MCP server starts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx -y @ericjdz/arkive serve --stdio
```

The MCP response should list eight tools: `update_architecture`, `record_decision`, `check_drift`, `scaffold_project`, `open_viewer`, `prompts`, `why_does_this_exist`, `walkthrough`.

### Fallback (no MCP)

If MCP registration is not possible in your environment, arkive still works:

- **Read/write `arkive/architecture.json` directly** — follow the schema in `AGENTS.md` or `CLAUDE.md`
- **Derive the structure with the CLI** — `npx @ericjdz/arkive reconcile --apply` writes `nodes[]` / `edges[]` from the code, with provenance, and does not need MCP
- **CLI commands** — `npx @ericjdz/arkive status`, `reconcile`, `watch`, `export`
- **No dependencies required** — the JSON file is self-contained

### MCP Tools Reference

| Tool | Description |
|---|---|
| `update_architecture` | Add or remove `nodes`, `edges`, `decisions`, `dataFlows`, and `stack` entries. A decision passed in the same call attaches to everything that call created, so the link is never maintained by hand. `removeServiceIds` takes **node** ids; `removeConnectionKeys` and `removeDataFlowNames` handle deletions. The `services` / `connections` inputs still exist for pre-v2 callers but are folded into the graph and then recomputed — prefer `nodes` / `edges`. |
| `record_decision` | Append a decision with rationale and at least one rejected alternative carrying a non-empty `whyNot`. `subjects` names the nodes and edges it explains; omit them and the decision is recorded unattached, which `arkive reconcile` reports. Sending `relatedServices` is **refused with an error naming its replacement** rather than silently stripped. |
| `why_does_this_exist` | Resolve a node id to the decisions that explain it: rationale, rejected alternatives, and the provenance of every claim — derived by a rule with evidence, authored, or no longer resolving. A decision on a parent path is found from its module children. |
| `check_drift` | Static analysis comparing `arkive/architecture.json` against `package.json` and source imports. Returns mismatches, plus the scan's own coverage so a partial scan is never reported as "in sync". |
| `scaffold_project` | Generate a project scaffold from the architecture document. |
| `open_viewer` | Open the web viewer in the default browser. The returned URL carries a per-run access token in its fragment and must be opened as given. |
| `prompts` | Queued architecture prompts from the viewer, one tool with three actions: `list` (optionally filter by status), `claim` (atomically claim the oldest pending prompt; returns prompt text and the node ids it is scoped to), `ack` (mark a claimed prompt as done or failed after execution). |
| `walkthrough` | Layered architectural walkthrough over the graph, one tool with three actions: `topology` (every node and edge, no prose), `open` (one node or edge into inbound/outbound edges by kind, children, data shapes, decisions; `depth` default 1, max 3), `trace` (a path through real edges, annotated per hop — a bad ref or a missing path is an error, never an invented answer). |

### MCP Resources Reference

| Resource | Description |
|---|---|
| `architecture://overview` | Project metadata, stack, and summary statistics. |
| `architecture://services` | The derived view of `nodes[]` / `edges[]` — every node and how they connect. Computed, not stored. |
| `architecture://decisions` | Full decision log with rationale and alternatives. |
| `architecture://dataflows` | Data flow definitions with step-by-step sequences. |
| `architecture://history` | Chronological change log. |
| `architecture://hooks` | Lifecycle rules for maintaining the architecture document. |
| `architecture://prompts` | Queued architecture prompts with summary counts. |
| `architecture://session-context` | Token-bounded session summary (≤ 2,000 tokens, measured and printed per section) with ranked nodes, edges, decisions and recent changes. Truncation is always disclosed. |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
