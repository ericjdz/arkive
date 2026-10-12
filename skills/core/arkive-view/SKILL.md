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

Check that `arkive/architecture.json` exists in the arkive/ directory. If not, inform the user and suggest `/arkive-init`.

### 2. Start the viewer

**If MCP `open_viewer` tool is available:**
Call `open_viewer` with default port. It returns the URL and auto-opens the browser.

**If MCP is not available:**
```bash
npx @ericjdz/arkive serve
```

The `serve` command auto-opens the browser by default. Use `--no-open` to suppress. The default port is `4567` (`--port <n>` to change it), and the URL it prints carries a per-run access token in its fragment — open it as given.

### 3. Present to user

Tell the user:

> "Architecture viewer is running at **http://localhost:4567** and should have opened in your browser.
>
> Available views:
> - **System Topology** — interactive graph of components and how they connect
> - **Data Flow** — step-by-step user-facing flows
> - **Decision Log** — all architectural decisions with rationale and rejected alternatives
> - **Component Tree** — hierarchical component view
> - **Stack Overview** — technology stack summary
> - **Learning Mode** — Socratic quizzes on architectural decisions
>
> To stop the viewer, click the **Stop** button in the viewer header, or run `npx @ericjdz/arkive stop`."

### 4. If the graph looks empty

The viewer renders the derived view of `nodes[]` / `edges[]`, so an empty topology means the derived half has never been persisted — not that the project has no architecture. Run `npx @ericjdz/arkive reconcile --apply` and restart the viewer.

## MUST NOT

- Do NOT start multiple viewer instances on the same port
- Do NOT leave the viewer running without telling the user how to stop it
- Do NOT edit `services[]` or `connections[]` to make a view show what the user expected. They are a computed projection of `nodes[]` / `edges[]` and are rewritten from the graph on every write.
