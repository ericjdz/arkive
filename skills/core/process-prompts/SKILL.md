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
   - `targetServices` — array of service IDs this prompt is scoped to
2. Read `arkive/architecture.json` (or `architecture://session-context`) to understand current state
3. Execute the prompt:
   - If it requests adding/modifying services → call `update_architecture`
   - If it requests an architectural decision → call `record_decision`
   - If it requests code changes → make the changes, then update architecture
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
- Update `arkive/architecture.json` after each prompt that changes the architecture
- Append a `history` entry for each architectural change

## MUST NOT

- Do NOT process prompts without claiming them first (prevents race conditions)
- Do NOT leave prompts in `claimed` state — always ack as done or failed
- Do NOT batch multiple prompts into a single architecture update — process individually so each has its own ack
- Do NOT execute prompts that are ambiguous or dangerous without asking the user first
