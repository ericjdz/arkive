# arkive

> A living architecture document for AI-built projects.
> Your AI agent maintains it. You finally understand what was built.

[![npm version](https://img.shields.io/npm/v/@ericjdz/arkive.svg)](https://www.npmjs.com/package/@ericjdz/arkive)
[![license](https://img.shields.io/npm/l/@ericjdz/arkive.svg)](./LICENSE)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot, Codex, OpenCode) build entire projects from a single prompt. You ship fast — but you can't explain why your project uses Postgres over Mongo, microservices over a monolith, or REST over GraphQL. The agent decided. You accepted. Across sessions, the agent has no memory of what was built and re-derives (or hallucinates) the architecture every time.

arkive solves both problems with one artifact: a structured `arkive/architecture.json` that lives in your repo. The agent reads it on session start (instant onboarding, no context rot), updates it after every major change (always-current docs), and you browse it in an interactive web viewer (finally understand your own project).

## Quick Start

```bash
# Initialize a project
npx @ericjdz/arkive init

# Or with curl
curl -fsSL https://raw.githubusercontent.com/ericjdz/arkive/main/scripts/install.sh | bash

# Start the MCP server + web viewer
npx @ericjdz/arkive serve

# Open Learning Mode (Socratic gating)
npx @ericjdz/arkive learn
```

After `init`, your repo gains:

- `arkive/` — contains `architecture.json` and `history/`
- A small tracking block injected into your existing `CLAUDE.md` and `AGENTS.md` (created if missing)
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
- **MCP server** — agents pull live architecture context via the Model Context Protocol (stdio + HTTP).
- **Interactive web viewer** — six views: System Topology, Data Flow, Decision Log, Component Tree, Stack Overview, Learning Mode.
- **Prompt queue** — select nodes in the viewer, write scoped architecture prompts, and your AI agent consumes them via MCP or clipboard.
- **Decisions are first-class** — every architectural choice records what was chosen, why, and what was rejected.
- **Drift detection** — `arkive reconcile` compares the doc against the actual code and flags mismatches.
- **Learning Mode** — Socratic gating that quizzes you on architectural decisions and tracks concept mastery.
- **Multi-platform** — Claude Code (marketplace + CLAUDE.md), Cursor (.cursor/rules), Codex / OpenCode / Copilot (AGENTS.md), or any agent via the MCP server.
- **Try before you install** — drop the standalone `CLAUDE.md` or `AGENTS.md` into any repo and your agent maintains the doc with no install.

## Prompt Queue

The prompt queue lets you direct your AI agent from the viewer.

1. Open the viewer (`npx @ericjdz/arkive serve`)
2. Click any service node to open its detail panel
3. Write an architecture change prompt scoped to that service
4. Click "Copy All" to paste into your agent's chat, or let the agent read `architecture://prompts` directly
5. The agent claims prompts via `claim_next_prompt`, executes them, and acknowledges with `ack_prompt`

Prompts are stored in `arkive/prompt-queue.json` and survive session resets.

## CLI Reference

| Command | Action |
|---|---|
| `npx @ericjdz/arkive init` | Scaffold `arkive/architecture.json`, inject tracking blocks, auto-detect platform, register MCP, install skills |
| `npx @ericjdz/arkive init --platform <p>` | Same as above, but explicitly specify the platform instead of auto-detecting |
| `npx @ericjdz/arkive init --standalone` | Generate full `AGENTS.md`/`CLAUDE.md` files (for platforms without MCP) |
| `npx @ericjdz/arkive install <platform>` | Register MCP server in your AI platform config |
| `npx @ericjdz/arkive install-skill <platform>` | Install arkive skills for your AI platform (7 skills: architecture tracking, init, import, view, learning, decisions, reconciliation) |
| `npx @ericjdz/arkive serve` | Start the MCP server and open the web viewer |
| `npx @ericjdz/arkive serve --stdio` | Run the MCP server in stdio mode (for direct agent integration) |
| `npx @ericjdz/arkive status` | Show architecture health (last updated, drift warnings, coverage) |
| `npx @ericjdz/arkive reconcile` | Run static analysis to detect drift and suggest fixes |
| `npx @ericjdz/arkive export <format>` | Export as `markdown`, `mermaid`, `png`, or `svg` |
| `npx @ericjdz/arkive learn` | Open the web viewer in Learning Mode |
| `npx @ericjdz/arkive hooks install` | Install post-commit git hook for auto-reconcile |
| `npx @ericjdz/arkive hooks uninstall` | Remove the auto-reconcile git hook |

Run `npx @ericjdz/arkive <command> --help` for command-specific options.

## Configuration

`init` accepts the following flags:

- `--name <name>` — project name (defaults to directory name)
- `--dir <path>` — target directory (defaults to current directory)
- `--description <text>` — project description
- `--platform <platform>` — AI platform (auto-detected if omitted): claude-desktop, claude-code, cursor, opencode, vscode, windsurf, cline
- `--skip-mcp` — skip MCP server registration
- `--skip-skills` — skip skill installation

`serve` accepts:

- `--stdio` — run MCP server over stdio (no HTTP, no viewer)
- `--port <n>` — HTTP/viewer port (default: 4317)
- `--no-open` — do not auto-open the browser

The architecture document lives at `./arkive/architecture.json` by default.

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

`arkive/architecture.json` is a structured, view-agnostic document:

- `project` — name, description, timestamps
- `stack` — language, runtime, framework, database, infrastructure
- `services` — every component (frontend, backend, db, cache, queue, ...) — each may carry optional `source` (`agent-scanned` | `human-verified` | `inferred`) and `confidence` (0–1) fields
- `connections` — how services communicate (HTTP, WebSocket, gRPC, ...) — also supports `source` and `confidence`
- `decisions` — what was chosen, why, and what was rejected — also supports `source` and `confidence`
- `dataFlows` — important user-facing flows step by step
- `history` — chronological change log

Validated by Zod. See `src/schema/architecture.ts` for the full schema.

## For Agents — Self-Install Guide

> **This section is written for AI coding agents.** If you are an agent reading this README, follow the steps below to install arkive and register its MCP server in your platform. All commands are idempotent and safe to re-run.

### Step 1: Ask which platform the user uses

Before running init, ask the user which AI platform they use: `opencode`, `claude-code`, `cursor`, `vscode`, `windsurf`, `cline`, or `claude-desktop`. This determines how MCP and skills are configured.

### Step 2: Initialize arkive (does everything)

```bash
npx -y @ericjdz/arkive init --platform <platform>
```

This single command:
- Creates `arkive/architecture.json` and `arkive/history/`
- Injects tracking blocks into `AGENTS.md` and `CLAUDE.md` (created if missing)
- Creates `.cursor/rules/architecture-tracker.mdc`
- **Registers the MCP server** in the platform's config file
- **Installs 7 arkive skills** (architecture-tracker, arkive-init, arkive-import, arkive-view, learning-mode, explain-decisions, reconciliation)
- **Optionally installs the git hook** — run `npx @ericjdz/arkive hooks install` after init to enable auto-reconcile on every commit

If files already exist, they are not overwritten. If `--platform` is omitted, arkive auto-detects by checking for `opencode.json`, `.mcp.json`, `.cursor/`, `.vscode/`, or environment variables.

### Step 3: Verify

After initializing, verify the setup:

```bash
# CLI health check
npx @ericjdz/arkive status

# Verify MCP server starts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx -y @ericjdz/arkive serve --stdio
```

The MCP response should list eight tools: `update_architecture`, `record_decision`, `check_drift`, `scaffold_project`, `open_viewer`, `list_prompts`, `claim_next_prompt`, `ack_prompt`.

### Step 4: Start maintaining the architecture

After init, **immediately scan the codebase** and populate `arkive/architecture.json`:

1. Read `package.json`, folder structure, and imports
2. Use the `update_architecture` MCP tool (or edit `arkive/architecture.json` directly) to populate `stack`, `services`, and `connections`
3. When adding services from a code scan, set `"source": "agent-scanned"` and `"confidence": 0.8`. Set `"source": "human-verified"` and `"confidence": 1.0` only when the user explicitly confirms a service. Entries with confidence below 0.6 are flagged as drift warnings.
4. Record any existing architectural decisions via `record_decision`

**From this point forward**, update `arkive/architecture.json` after every major change (adding/removing services, changing protocols, new frameworks, infrastructure changes).

### Step 5: Use session context on every session start

Read `architecture://session-context` at the start of every session instead of `arkive/architecture.json` directly. It returns a compact, token-efficient summary (stack, top services, recent decisions, active drift warnings) without dumping the full document into context.

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

The MCP response should list eight tools: `update_architecture`, `record_decision`, `check_drift`, `scaffold_project`, `open_viewer`, `list_prompts`, `claim_next_prompt`, `ack_prompt`.

### Fallback (no MCP)

If MCP registration is not possible in your environment, arkive still works:

- **Read/write `arkive/architecture.json` directly** — follow the schema in `AGENTS.md` or `CLAUDE.md`
- **CLI commands** — `npx @ericjdz/arkive status`, `reconcile`, `export`
- **No dependencies required** — the JSON file is self-contained

### MCP Tools Reference

| Tool | Description |
|---|---|
| `update_architecture` | Merge services, connections, data flows, and stack entries into `arkive/architecture.json`. Supports `removeServiceIds`, `removeConnectionKeys`, `removeDataFlowNames` for deletions. |
| `record_decision` | Append an architectural decision with rationale and at least one rejected alternative. |
| `check_drift` | Static analysis comparing `arkive/architecture.json` against `package.json` and source imports. Returns mismatches. |
| `scaffold_project` | Generate a project scaffold from the architecture document. |
| `open_viewer` | Open the web viewer in the default browser. |
| `list_prompts` | List queued architecture prompts from the viewer. Optionally filter by status. |
| `claim_next_prompt` | Atomically claim the oldest pending prompt. Returns prompt text and target services. |
| `ack_prompt` | Mark a claimed prompt as done or failed after execution. |

### MCP Resources Reference

| Resource | Description |
|---|---|
| `architecture://overview` | Project metadata, stack, and summary statistics. |
| `architecture://services` | All services with dependencies and connections. |
| `architecture://decisions` | Full decision log with rationale and alternatives. |
| `architecture://dataflows` | Data flow definitions with step-by-step sequences. |
| `architecture://history` | Chronological change log. |
| `architecture://hooks` | Lifecycle rules for maintaining the architecture document. |
| `architecture://prompts` | Queued architecture prompts with summary counts. |
| `architecture://session-context` | Token-efficient session summary with stack, top services, recent decisions, and drift warnings. |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
