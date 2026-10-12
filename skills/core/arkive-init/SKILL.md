---
name: arkive-init
description: Initialize arkive architecture tracking in the current project. Handles MCP registration and skill installation.
trigger: User says "init arkive", "set up arkive", "initialize architecture tracking", or invokes /arkive-init.
---

# /arkive-init — Initialize Architecture Tracking

## When to Use

Run this to set up arkive in a new or existing project.

## Flow

### 1. Check existing state

Check if `arkive/architecture.json` exists in the arkive/ directory.
- If it exists: inform the user arkive is already initialized. Offer to run `/arkive-import` to populate from existing code, or re-initialize (destructive — requires explicit confirmation).
- If it does not exist: proceed.

### 2. Ask: global or project-only?

Ask the user:

> "Do you want arkive available globally (in all projects) or just this project?"
>
> - **Global** — installs arkive skills globally so you can invoke `/arkive-init` in any new project without re-installing
> - **Project only** — installs arkive only in this project

### 3. Ask: which AI platform?

Ask the user which AI platform they use:
- Claude Desktop
- Claude Code
- Cursor
- OpenCode
- VS Code Copilot
- Windsurf
- Cline

### 4. Execute initialization

Run the following commands:

```bash
# Initialize architecture tracking
npx -y @ericjdz/arkive init --name <project-name>

# Register MCP server
npx -y @ericjdz/arkive install <platform>

# Install skills (if global was chosen, add --global)
npx -y @ericjdz/arkive install-skill <platform> [--global]
```

**If MCP tools are available**, prefer calling `scaffold_project` instead of the CLI `init` command.

### 5. Populate from existing code (if project has code)

If the project already contains source code (check for `package.json`, `src/`, `app/`, or similar):

- Inform the user: "This project already has code. Want me to analyze it and populate the architecture document?"
- If yes: invoke `/arkive-import`
- If no: leave `arkive/architecture.json` with empty `nodes[]` / `edges[]` — `reconcile --apply` fills them as you build.

### 6. Verify

Run: `npx @ericjdz/arkive status`
Must show the project name, `Schema: v2`, and a **conclusive** verdict line. `INCONCLUSIVE` means the scan did not cover the project — that is not a clean bill of health.

Tell the user to restart their agent session to pick up the MCP server.

## MUST DO

- Always ask global vs project-only BEFORE executing
- Always ask which platform BEFORE executing
- Always verify with `status` after init
- If project has existing code, offer `/arkive-import`
- Read the `architecture.json` that `init` wrote and confirm it carries `schemaVersion: 2`. A document carrying the v1 `version` string is a v1 file; `init` does not write one.

## MUST NOT

- Do NOT skip the platform question — MCP registration is platform-specific
- Do NOT commit generated files without user confirmation
- Do NOT re-initialize if `arkive/architecture.json` exists without explicit user confirmation
- Do NOT transcribe the module tree, the dependency list, or the import graph into the document. `npx @ericjdz/arkive reconcile --apply` derives them from the code, and every derived element arrives carrying the `file:line` it came from. Hand-written structure drifts from the first commit and nothing reports it.
