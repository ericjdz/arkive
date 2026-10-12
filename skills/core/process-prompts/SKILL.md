---
name: process-prompts
description: Process queued architecture prompts from the web viewer. Drains the prompt queue by claiming, executing, and acknowledging each prompt.
trigger: User says "process prompts", "check prompt queue", "run queued prompts", "drain prompt queue", or invokes /process-prompts.
---

# /process-prompts — Process Architecture Prompt Queue

## When to Use

Run this when the user has queued architecture change prompts from the arkive web viewer and wants the agent to execute them.

## Flow

### 1. Check for pending prompts

**If MCP is available:**
Call `list_prompts` with status filter `pending`. If no pending prompts, inform the user and stop.

**If MCP is not available:**
Read `arkive/prompt-queue.json` directly. Filter entries with `"status": "pending"`.

### 2. Process each prompt

Loop until no pending prompts remain:

1. Call `claim_next_prompt` — this atomically claims the oldest pending prompt and returns:
   - `id` — the prompt ID
   - `prompt` — the text of the architecture change request
   - `targetServices` — array of node ids this prompt is scoped to (the tool's field name predates v2; the ids are node ids)
2. Read `arkive/architecture.json` (or `architecture://session-context`) to understand current state
3. Execute the prompt:
   - If it requests a structural change (a new module, a removed dependency, a new package) → make the code change first, then `npx @ericjdz/arkive reconcile --apply`. The derived half comes from the code; do not hand-edit `nodes[]` / `edges[]`.
   - If it requests a boundary, a `summary`, `owner`, or a data flow → `update_architecture`, with `"provenance": { "derived": false, "authoredBy": "agent" }`
   - If it requests an architectural decision → `record_decision`, with `subjects` naming the nodes/edges it explains and at least one rejected alternative with a non-empty `whyNot`
4. Call `ack_prompt` with the prompt `id` and outcome:
   - `"done"` — if successfully executed
   - `"failed"` — if the prompt cannot be executed (explain why in the message)
5. Move to the next prompt

### 3. Report summary

After draining the queue, tell the user:
- How many prompts were processed
- How many succeeded vs failed
- What architectural changes were made

## MUST DO

- Process prompts **one at a time** in FIFO order — do not skip or reorder
- Always `ack_prompt` after each prompt, even if it failed
- Run `reconcile --apply` after any prompt that changed the code's structure
- Append a `history` entry for each architectural change

## MUST NOT

- Do NOT process prompts without claiming them first (prevents race conditions)
- Do NOT leave prompts in `claimed` state — always ack as done or failed
- Do NOT batch multiple prompts into a single architecture update — process individually so each has its own ack
- Do NOT execute prompts that are ambiguous or dangerous without asking the user first
- Do NOT write `services[]`, `connections[]`, or `relatedServices`. They are a derived view of `nodes[]` / `edges[]`, regenerated from the graph on every write, so an edit to them is lost without a warning
