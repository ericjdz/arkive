---
name: setup
description: Initialize architecture tracking in a project. Run this once per project.
trigger: User says "set up archlearn", "init architecture tracking", or project has no architecture.json.
---

# Setup — Architecture Tracking

## When to Use

Run this when starting a new project or adding architecture tracking to an existing one.

## Steps

### 1. Initialize

Run: `npx archlearn init --name <project-name>`

This creates:
- `architecture.json` — the living architecture document
- `CLAUDE.md` — instructions for Claude Code agents
- `AGENTS.md` — instructions for Codex/OpenCode/Copilot agents
- `.cursor/rules/architecture-tracker.mdc` — Cursor auto-apply rule

### 2. Populate from existing code (if project already has code)

After `init`, scan the existing codebase and update `architecture.json`:

**Use MCP tools if available:**
- Call `update_architecture` with discovered services, connections, and stack entries
- Call `record_decision` for any architectural choices evident in the code

**If MCP is not available, edit `architecture.json` directly:**
- Check `package.json` / `requirements.txt` / `go.mod` → populate `stack`
- Check folder structure and entry points → populate `services`
- Check config files (Docker, nginx, CI) → populate `infrastructure` in stack
- Check import statements → populate `connections`

### 3. Configure MCP server (for full experience)

**Claude Code plugin users:** MCP is configured automatically via `.claude-plugin/plugin.json`.

**Other platforms — add to your MCP config:**

```json
{
  "mcpServers": {
    "archlearn": {
      "command": "npx",
      "args": ["-y", "archlearn", "serve", "--stdio"]
    }
  }
}
```

- **Cursor:** Add to `.cursor/mcp.json`
- **OpenCode:** Add to `mcp.json` or equivalent config
- **Copilot:** Add to agent MCP configuration

### 4. Verify

Run: `npx archlearn status`

MUST show project name, counts, and zero drift warnings.

## After Setup

The `architecture-tracker` skill governs ongoing maintenance. You MUST read `architecture.json` before major changes and update it after.

## MUST NOT

- Do NOT commit generated files without user confirmation
- Do NOT skip the "populate from existing code" step on non-empty projects
