---
name: setup
description: Initialize architecture tracking in a project. Run this once per project.
trigger: User says "set up arkive", "init architecture tracking", or project has no architecture.json.
---

# Setup — Architecture Tracking

## When to Use

Run this when starting a new project or adding architecture tracking to an existing one.

## Steps

### 1. Initialize

Run: `npx @ericjdz/arkive init --name <project-name>`

This creates:
- `architecture.json` — the living architecture document
- A small tracking block injected into existing `CLAUDE.md` and `AGENTS.md` (created if missing)
- `.cursor/rules/architecture-tracker.mdc` — Cursor auto-apply rule

> **Note:** By default, `init` injects a small tracking block into existing AGENTS.md/CLAUDE.md files without overwriting them. Use `--standalone` to generate full instruction files instead (for platforms without MCP/skills support).

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

### 3. Register MCP server

**Ask the user which AI platform they use**, then run:

```bash
npx @ericjdz/arkive install <platform>
```

Supported platforms: `claude-desktop`, `claude-code`, `cursor`, `opencode`, `vscode`, `windsurf`, `cline`

The command auto-writes the correct MCP config entry. Tell the user to restart their agent session afterward.

**Claude Code plugin users:** MCP is configured automatically via `.claude-plugin/plugin.json` — skip this step.

### 4. Verify

Run: `npx @ericjdz/arkive status`

MUST show project name, counts, and zero drift warnings.

## After Setup

The `architecture-tracker` skill governs ongoing maintenance. You MUST read `architecture.json` before major changes and update it after.

## MUST NOT

- Do NOT commit generated files without user confirmation
- Do NOT skip the "populate from existing code" step on non-empty projects
