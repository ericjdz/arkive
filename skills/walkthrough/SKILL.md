---
name: walkthrough
description: Lead an agent-led layered architectural walkthrough over arkive/architecture.json — topology first, learner-chosen destinations, decisions on descent.
trigger: User asks "walk me through this system", "what is this codebase", "explain the architecture", "trace what happens when", or "why does X exist".
---

# Walkthrough

Agent-side procedure for the layered walkthrough. The frozen data shapes
are in `docs/walkthrough-contract.md`; narration reference for the
decision step is `skills/learning/explain-decisions/SKILL.md`.

## Procedure

1. **Start at System via topology.** Read the graph (`topology()`; today:
   `architecture://session-context` then `architecture://services` for
   the full node/edge lists). Present boundaries and directions as
   sub-concepts — no filenames, no paths, no rationale yet.
2. **Let the learner pick the destination.** Offer openings, never a
   script: "which boundary do you want to open?" / "want to trace a
   request, or open a service?" Wait for their choice. Record each
   learner-authored destination (needed for engagement test 3).
3. **Open / trace on demand.** `open(ref, depth)` for "open that one";
   `trace(entryRef, exitRef)` for "what happens when". Descend
   System → Subsystem → Module; ascend without losing place (keep
   current ref + level + trail). Never leak Module granularity into
   System narration.
4. **Decisions on descent, never as an opening move.**
   `decisionsAbout(ref)` (today: `why_does_this_exist` with the node
   id) when the learner asks "why" or reaches a boundary/module worth
   explaining. Narrate in the explain-decisions format — decision / why
   / alternatives-rejected / related — plus a derived-vs-authored line
   per claim ("the scan found this at `src/x.ts:42`" vs "recorded by
   the agent, unreviewed"). Unresolved subjects are reported, not
   dropped.
5. **Never fabricate rationale.** No matching decision: say what the
   graph shows, say plainly no rationale is recorded, offer to record
   one (`record_decision`). Never present inference with decision
   confidence. The MUST-NOT list in `docs/walkthrough-contract.md` §7
   applies to every step.

## Engagement tests (runnable, per session)

Run these after one walkthrough with a learner who has not read the
codebase. All three must pass; a satisfaction survey passes none of them.

1. **Transfer (≥ 80%).** Ask, with the document closed: "what depends
   on X?", "why does Y exist?", "what happens when a request hits Z?"
   (X/Y/Z drawn from nodes actually walked). Score correct answers;
   pass at ≥ 80%. This is `docs/VISION.md:129-130` made operational.
2. **Time to first correct answer (< 60s, above quiz-recognition
   baseline).** Time each answer from §1. Pass when median is under 60
   seconds AND slower than rote quiz-recognition answers — instant
   recall means the walkthrough tested recognition, not structure.
3. **Learner-authored destination (≥ 1 per session).** Count moves the
   learner chose that the agent did not propose. Zero means the session
   was a lecture, not a walkthrough — fail regardless of tests 1–2.

Supporting only (tracked, not gating): session abandonment rate,
revisit rate within seven days.

## MUST NOT

- No quiz questions, no concept-mastery scoring, no progress bar.
- No fixed tour order, no next/prev gating on answers.
- No Module-level detail (paths, imports) in the System opening.
