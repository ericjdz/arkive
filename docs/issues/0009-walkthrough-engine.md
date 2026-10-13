# 0009 — Layered walkthrough engine

status: done
stream: comprehend
blocks: 0010, 0015
blocked_by: 0008, 0011
adr: docs/adr/0003-agent-led-layered-walkthrough.md

## Context

This is vision layer 2, and it replaces something the maintainer has explicitly
rejected.

The current Learning Mode generates Socratic questions from architecture data,
tracks concept mastery, renders a concept map and a progress bar
(`src/learning/`, `skills/learning/learning-mode/`,
`skills/learning/explain-decisions/`). The verdict on it: **it tests recall, it
interrogates, and it is not how anyone learns a system.** The maintainer wants
"an engaging experience that allows user to go through what they're building in
an abstract form... to understand all of the intrinsics and specifics... and
letting the AI decide."

The two audiences are real and distinct, and one mechanism should serve both:

- **Hands-off builders** who describe intent, let the agent write code, and
  accept it — and need to grasp what they shipped well enough to trust it and
  discuss it.
- **Learning engineers** who need to study system design against a real,
  specific system rather than a textbook diagram.

## Scope

1. **Layered abstraction.** Three levels over the graph from 0003:
   - **System** — topology, boundaries, data shapes. What are the pieces and
     how do they relate. Answers "what is this."
   - **Subsystem** — one service or cluster opened up: its modules, inbound and
     outbound edges, the decisions that shaped it.
   - **Module** — specific files, their imports, the data shapes they touch.

   Every node must be reachable at all three, and any walk must be able to move
   up and down without losing the reader's place.
2. **Traversals.** Named, repeatable paths through the graph, not freeform
   tours:
   - trace a request or event end to end through `calls`/`reads`/`writes`
   - explain a boundary — why these modules are grouped
   - explain a decision — against what was rejected, at the node it created
   - follow a data structure — where it is defined, written, read, transformed
3. **AI chooses presentation, learner chooses destination.** The agent decides
   how to narrate a level given the graph and the learner's stated goal; the
   learner picks where to go. No fixed script, no linear progression.
4. **Abstraction honesty.** At System level, a learner should see concepts, not
   filenames. At Module level, real paths. The engine must not leak the wrong
   granularity into the wrong level — that is the failure mode that makes
   abstractions feel like homework.
5. **Provenance surfaced.** Derived nodes are inferences from code; authored
   ones are decisions. The walkthrough must not present an inference with the
   same confidence as a decision.

## Out of scope

The viewer (0010). Deleting the old quiz code (0015).

## Acceptance criteria

- [ ] Every graph node is walkable at system, subsystem, and module level.
- [ ] At least four named traversals work end to end against a fixture repo.
- [ ] Upward and downward navigation preserves position and context.
- [ ] Provenance is visible at every level — the learner can always tell
      inference from decision.
- [ ] **"Engaging" is measured, not assumed.** Define the test: a learner who
      has never read the codebase can, after one walkthrough, correctly answer
      "what are the main boundaries and why" and "trace what happens when X".
      Run it against three real repos. If they fail, the engine is not done —
      do not ship on a demo that works.
- [ ] No quiz, no concept-mastery score, no progress bar anywhere in the flow.

## Design note

This is the issue most likely to be judged on ambition. Resist. The bar is
that a real learner walks away able to explain their own system. A traversal
engine with four good named paths beats an AI that improvises a tour and
loses the reader in module-level detail on the first question.