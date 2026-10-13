# 0012 — Session context budget

status: done
stream: context
blocked_by: 0004

## Context

The README calls `architecture://session-context` "token-efficient" (README:191,
README:376). It is token-*measured*, not token-*bounded*.

`src/server/session-context.ts:31-53` pushes **every service and every
connection with no budget check**. The `maxTokens = 2000` guard
(`session-context.ts:15`) is applied only to decisions (`:58-68`) and history
(`:70-78`) — and only *after* the unbounded sections have already been built. A
project with 300 services returns 300 service lines regardless of `maxTokens`.
The budget math is structurally incapable of bounding the sections that grow.

This is vision layer 1 failing at its own stated goal. The document exists to
reduce context load and instead it grows without limit inside the one call the
agent makes every session.

## Scope

1. **Budget everything.** Apply `maxTokens` to services and edges, not just
   decisions and history. Build sections in priority order and truncate the
   tail.
2. **Priority ranking.** Type-rank nodes — `datastore`, `gateway`, `auth`,
   `queue` before `module` — and truncate the long tail first. The top of the
   graph is what a session needs; the leaves are a lookup, not a load.
3. **Progressive disclosure, honestly.** If the budget cannot fit the graph,
   return the summary plus an explicit pointer to the MCP resource or tool that
   returns more. Never silently truncate — a learner or agent that believes it
   has the full picture and does not is worse than one that knows it is partial.
4. **Bound the unbounded.** `history[]` appends forever with no pruning.
   Archiving is 0004; excluding the archive from session context is here.
5. **Measure it.** Report actual token counts per section. If the claim
   "token-efficient" stays in the README, it should be a measured number.

## Out of scope

Prompt-queue budgeting. The walkthrough engine's own context budget (0009).

## Acceptance criteria

- [ ] Output is under `maxTokens` for a 300-node, 500-edge fixture. Asserted.
- [ ] Truncation is visible in the output — never silent.
- [ ] High-priority nodes survive truncation; low-priority ones drop first.
- [ ] `history` archive is excluded from session context.
- [ ] Token counts reported per section.
- [ ] `npm run lint` and `npm test` pass.