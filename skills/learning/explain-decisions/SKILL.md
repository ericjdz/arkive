---
name: explain-decisions
description: Answer "why" questions about architectural choices using arkive/architecture.json.
trigger: User asks "why did we choose X?", "why this database?", "why not use Y?", "explain the architecture", or clicks "Why this?" in the web viewer.
---

# Explain Decisions

> Reference narration for the walkthrough's `decisionsAbout` step. See
> `skills/walkthrough/SKILL.md` for the walkthrough procedure and
> `docs/walkthrough-contract.md` for the frozen data shapes.

## Behavior

1. **Read architecture data**:
   - Via MCP: read `architecture://decisions`, or call `why_does_this_exist` with the node id when the question is about a specific component
   - Via file: read `decisions[]` from `arkive/architecture.json`

2. **Find the relevant decision**: Search by `topic`, `decision`, or `subjects[].ref` matching the question. A `subject` names a node *or* an edge, so a decision about a relationship is findable too.

3. **Check provenance before you answer.** Every node and edge carries one of:
   - `{ "derived": true, "rule": "...", "evidence": ["file:line"] }` — a rule read those sites
   - `{ "derived": false, "authoredBy": "agent" | "human" }` — somebody said so

   Say which one you are relying on. "The scan found this at `src/x.ts:42`" and "the agent recorded this, nobody has reviewed it since" are different claims and the user needs to hear the difference. There is no confidence score to report — the evidence is the report.

4. **Explain with this structure**:

   ```
   ## {topic}

   **Decision:** {decision}

   **Why:** {rationale}

   **Alternatives considered:**
   - **{alternative.name}**: Rejected because {alternative.whyNot}

   **What it explains:** {subjects — node and edge ids}
   ```

5. **If no matching decision exists**:
   - Check `nodes`, `edges`, and `stack` for context the derivation already provides
   - Explain what is available, and say plainly that no rationale is recorded
   - Suggest recording one:
     - Via MCP: "I can call `record_decision` to document this choice"
     - Via file: "I can add an entry to `arkive/architecture.json`"

6. **If a decision's `subjects` no longer resolve**, say so. That decision explains something that has since been deleted, and the user probably wants to know that the deletion was a choice or an accident.

7. **Connect to the bigger picture**: After explaining, briefly mention how this decision relates to other architectural choices in the project.

## MUST NOT

- Do NOT fabricate rationale that isn't in `arkive/architecture.json`
- Do NOT guess at alternatives that weren't recorded
- Do NOT present a derived element as if a person chose it, or an authored element as if a scan found it
- Do NOT cite `services[]` or `connections[]` — they are a computed view of `nodes[]` / `edges[]`, so a claim about them is really a claim about the graph
- Do NOT invent a `confidence` figure to characterise how sure a decision is. There is no such field, and a number nobody measured is not evidence.