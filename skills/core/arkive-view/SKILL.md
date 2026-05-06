---
name: arkive-view
description: Open the arkive web viewer to browse the project's architecture interactively.
trigger: User says "show architecture", "open arkive", "view architecture", "arkive viewer", or invokes /arkive-view.
---

# /arkive-view — Open Architecture Viewer

## When to Use

Run this when the user wants to visually browse the project's architecture.

## Flow

### 1. Verify architecture exists

Check that `architecture.json` exists in the project root. If not, inform the user and suggest `/arkive-init`.

### 2. Start the viewer

**If MCP `open_viewer` tool is available:**
Call `open_viewer` with default port. It returns the URL.

**If MCP is not available:**
```bash
npx @ericjdz/arkive serve
```

### 3. Present to user

Tell the user:

> "Architecture viewer is running at **http://localhost:4567**. Open this URL in your browser.
>
> Available views:
> - **System Topology** — interactive graph of services and connections
> - **Data Flow** — step-by-step user-facing flows
> - **Decision Log** — all architectural decisions with rationale
> - **Component Tree** — hierarchical service view
> - **Stack Overview** — technology stack summary
> - **Learning Mode** — Socratic quizzes on architectural decisions"

## MUST NOT

- Do NOT open the browser programmatically without telling the user the URL first
- Do NOT start multiple viewer instances on the same port
