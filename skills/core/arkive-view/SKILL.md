---
name: arkive-view
description: Render the arkive architecture graph as a single self-contained HTML file and open it.
trigger: User says "show architecture", "open arkive", "view architecture", "arkive viewer", or invokes /arkive-view.
---

# /arkive-view — Open Architecture Graph

## When to Use

Run this when the user wants to see the project's architecture. The viewer
is one self-contained file — no build step, no dev server, no dependencies.

## Flow

### 1. Verify architecture exists

Check that `arkive/architecture.json` exists. If not, inform the user and suggest `/arkive-init`.

### 2. Generate the artifact

```bash
npx @ericjdz/arkive export html
```

This writes `arkive/graph.html` (use `--output <file>` to put it elsewhere).
Re-run it whenever the graph changes — the file is a snapshot, and a stale
snapshot is worse than none. It is git-ignored by default; do not commit it.

### 3. Open it

**From disk (preferred):** open `arkive/graph.html` directly — it works from
`file://`, with pan, zoom, text filter, and node selection built in.

**From the server:** if the user wants a URL (e.g. to share),

```bash
npx @ericjdz/arkive serve --no-open
```

then open the printed URL. The server serves the artifact at `/` and
`/graph.html`, but only if `arkive/graph.html` exists — otherwise it answers
404 with "Run `arkive export html` first." The URL it prints carries a
per-run access token in its fragment — open it as given.

**If MCP `open_viewer` tool is available:**
Call `open_viewer` with default port. It returns the URL and auto-opens the browser.

### 4. Present to user

Tell the user:

> "Architecture graph is ready — open **arkive/graph.html** in your browser.
>
> What you get:
> - **Topology** — every node and edge, laid out deterministically
> - **Node selection** — kind, inbound/outbound edges grouped by kind, data
>   shapes, and the decisions behind the node with their provenance
>   (authored vs derived, evidence, caveats)
> - **Text filter** — narrows nodes by name or id
> - **Deep links** — `?node=<id>` opens the graph with that node selected,
>   so the agent can hand you a URL to a decision's context
>
> What it does not do: prompt queue, walkthrough narration, editing, decision authoring.
> Those live in the agent conversation and the document, not the file."

### 5. If the graph looks empty

The artifact renders `nodes[]` / `edges[]`, so an empty topology means the
derived half has never been persisted — not that the project has no
architecture. Run `npx @ericjdz/arkive reconcile --apply`, re-run
`npx @ericjdz/arkive export html`, and reopen the file.

## MUST NOT

- Do NOT start multiple servers on the same port
- Do NOT leave a server running without telling the user how to stop it
  (`npx @ericjdz/arkive stop`)
- Do NOT edit `services[]` or `connections[]` to make the graph show what
  the user expected. They are a computed projection of `nodes[]` / `edges[]`
  and are rewritten from the graph on every write.
- Do NOT commit `arkive/graph.html`. Regenerate it instead.
