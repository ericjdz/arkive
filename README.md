# arkive

> A living architecture document for AI-built projects.
> Your AI agent maintains it. You finally understand what was built.

[![npm version](https://img.shields.io/npm/v/@ericjdz/arkive.svg)](https://www.npmjs.com/package/@ericjdz/arkive)
[![license](https://img.shields.io/npm/l/@ericjdz/arkive.svg)](./LICENSE)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot, Codex, OpenCode) build entire projects from a single prompt. You ship fast — but you can't explain why your project uses Postgres over Mongo, microservices over a monolith, or REST over GraphQL. The agent decided. You accepted. Across sessions, the agent has no memory of what was built and re-derives (or hallucinates) the architecture every time.

arkive solves both problems with one artifact: a structured `architecture.json` that lives in your repo. The agent reads it on session start (instant onboarding, no context rot), updates it after every major change (always-current docs), and you browse it in an interactive web viewer (finally understand your own project).

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

- `architecture.json` — the living architecture document
- `CLAUDE.md`, `AGENTS.md` — instructions for AI agents
- `.cursor/rules/architecture-tracker.mdc` — Cursor auto-apply rule

Your AI agent will now read and maintain `architecture.json` automatically.

## Features

- **Cross-session memory for AI agents** — the architecture file survives compaction, session resets, and model switches.
- **MCP server** — agents pull live architecture context via the Model Context Protocol (stdio + HTTP).
- **Interactive web viewer** — five views: System Topology, Data Flow, Decision Log, Component Tree, Stack Overview.
- **Decisions are first-class** — every architectural choice records what was chosen, why, and what was rejected.
- **Drift detection** — `arkive reconcile` compares the doc against the actual code and flags mismatches.
- **Learning Mode** — Socratic gating that quizzes you on architectural decisions and tracks concept mastery.
- **Multi-platform** — Claude Code (marketplace + CLAUDE.md), Cursor (.cursor/rules), Codex / OpenCode / Copilot (AGENTS.md), or any agent via the MCP server.
- **Try before you install** — drop the standalone `CLAUDE.md` or `AGENTS.md` into any repo and your agent maintains the doc with no install.

## CLI Reference

| Command | Action |
|---|---|
| `npx @ericjdz/arkive init` | Scaffold `architecture.json` and instruction files into a project |
| `npx @ericjdz/arkive serve` | Start the MCP server and open the web viewer |
| `npx @ericjdz/arkive serve --stdio` | Run the MCP server in stdio mode (for direct agent integration) |
| `npx @ericjdz/arkive status` | Show architecture health (last updated, drift warnings, coverage) |
| `npx @ericjdz/arkive reconcile` | Run static analysis to detect drift and suggest fixes |
| `npx @ericjdz/arkive export <format>` | Export as `markdown`, `mermaid`, `png`, or `svg` |
| `npx @ericjdz/arkive learn` | Open the web viewer in Learning Mode |

Run `npx @ericjdz/arkive <command> --help` for command-specific options.

## Configuration

`init` accepts the following flags:

- `--name <name>` — project name (defaults to directory name)
- `--dir <path>` — target directory (defaults to current directory)
- `--description <text>` — project description

`serve` accepts:

- `--stdio` — run MCP server over stdio (no HTTP, no viewer)
- `--port <n>` — HTTP/viewer port (default: 4317)
- `--no-open` — do not auto-open the browser

The architecture document lives at `./architecture.json` by default.

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

`architecture.json` is a structured, view-agnostic document:

- `project` — name, description, timestamps
- `stack` — language, runtime, framework, database, infrastructure
- `services` — every component (frontend, backend, db, cache, queue, ...)
- `connections` — how services communicate (HTTP, WebSocket, gRPC, ...)
- `decisions` — what was chosen, why, and what was rejected
- `dataFlows` — important user-facing flows step by step
- `history` — chronological change log

Validated by Zod. See `src/schema/architecture.ts` for the full schema.

## For Agents — Self-Install Guide

> **This section is written for AI coding agents.** If you are an agent reading this README, follow the steps below to install arkive and register its MCP server in your platform. All commands are idempotent and safe to re-run.

### Step 1: Initialize arkive in the project

```bash
npx -y @ericjdz/arkive init
```

This creates `architecture.json`, `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/architecture-tracker.mdc`. If these files already exist, they are not overwritten.

### Step 2: Register the MCP server

arkive exposes three MCP tools via stdio: `update_architecture`, `record_decision`, and `check_drift`. To use them natively, register arkive as an MCP server in your platform's config.

Pick your platform and add the config block to the corresponding file.

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

### Step 3: Verify

After registering, restart your agent session and verify the MCP tools are available:

```bash
# CLI health check (works without MCP)
npx @ericjdz/arkive status

# Verify MCP server starts
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx -y @ericjdz/arkive serve --stdio
```

The MCP response should list three tools: `update_architecture`, `record_decision`, `check_drift`.

### Fallback (no MCP)

If MCP registration is not possible in your environment, arkive still works:

- **Read/write `architecture.json` directly** — follow the schema in `AGENTS.md` or `CLAUDE.md`
- **CLI commands** — `npx @ericjdz/arkive status`, `reconcile`, `export`
- **No dependencies required** — the JSON file is self-contained

### MCP Tools Reference

| Tool | Description |
|---|---|
| `update_architecture` | Merge services, connections, data flows, and stack entries into `architecture.json`. Supports `removeServiceIds`, `removeConnectionKeys`, `removeDataFlowNames` for deletions. |
| `record_decision` | Append an architectural decision with rationale and at least one rejected alternative. |
| `check_drift` | Static analysis comparing `architecture.json` against `package.json` and source imports. Returns mismatches. |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
