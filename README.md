# arkive

> A living architecture document for AI-built projects.
> Your AI agent maintains it. You finally understand what was built.

[![npm version](https://img.shields.io/npm/v/arkive.svg)](https://www.npmjs.com/package/arkive)
[![license](https://img.shields.io/npm/l/arkive.svg)](./LICENSE)

---

## Why

AI coding agents (Claude Code, Cursor, Copilot, Codex, OpenCode) build entire projects from a single prompt. You ship fast — but you can't explain why your project uses Postgres over Mongo, microservices over a monolith, or REST over GraphQL. The agent decided. You accepted. Across sessions, the agent has no memory of what was built and re-derives (or hallucinates) the architecture every time.

arkive solves both problems with one artifact: a structured `architecture.json` that lives in your repo. The agent reads it on session start (instant onboarding, no context rot), updates it after every major change (always-current docs), and you browse it in an interactive web viewer (finally understand your own project).

## Quick Start

```bash
# Initialize a project
npx @ericjdz/arkive init

# Or with curl
curl -fsSL https://raw.githubusercontent.com/arkive/arkive/main/scripts/install.sh | bash

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
