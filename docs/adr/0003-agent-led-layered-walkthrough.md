# ADR-0003: Replace quiz-based Learning Mode with an agent-led layered walkthrough

## Status

Proposed

## Context

`docs/VISION.md:58-60` has already decided this: the previous implementation
"tests recall, it interrogates, and it is not how anyone learns a system." This
ADR specifies what replaces it. What follows is not a softening of the existing
mode; it is a deletion.

### What exists

Four generator modules and their type scaffolding:

- `src/learning/questions.ts:20-57` — `generateDecisionQuestions` builds a
  multiple-choice question whose correct answer is `dec.rationale` verbatim
  (`src/learning/questions.ts:23-25`) and whose distractors are the
  `alternatives[].whyNot` strings verbatim (`:28-32`). The learner is asked to
  recognise a string they could look up. When a decision has fewer than two
  alternatives, `src/learning/questions.ts:35-39` pads with *"It was the only
  option available."*
- `src/learning/questions.ts:59-102` — `generateTopologyQuestions` asks "which
  services depend on X?" with distractors drawn from every other service.
- `src/learning/questions.ts:104-142` — `generateConnectionQuestions` asks which
  protocol a connection uses, and when real options run out it invents
  candidates from the hardcoded list `["gRPC", "GraphQL", "AMQP", "MQTT"]`
  (`:121-127`). A learner can be marked wrong for picking a protocol that does
  not exist in the project.
- `src/learning/questions.ts:144-165` — `generateDataFlowQuestions` turns a flow
  into an ordering puzzle; the correct order is the order it was already written
  in.
- `src/learning/questions.ts:43` places the correct answer using
  `dec.id.charCodeAt(...) % (choices.length + 1)` — position derived from the
  id, not randomised and not seeded. The same decision always lands in the same
  slot, so answer position is a constant the learner can learn instead of the
  content.
- `src/learning/concepts.ts:10-49` enumerates every decision, service,
  connection, and flow as a "concept" to be mastered.
- `src/learning/progress.ts:39-73` scores a learner and marks a concept
  `mastered: true` on a single correct answer (`:53`).

Six React components render it:
`src/viewer/src/components/QuizPanel.tsx`, `QuestionCard.tsx`,
`ProgressTracker.tsx`, `ConceptMap.tsx`, plus `src/viewer/src/views/LearningView.tsx`.
Two HTTP endpoints persist it (`src/cli/commands/serve.ts:78-99`).

Five test files cover it: `tests/learning/{concepts,integration,progress,questions,types}.test.ts`,
one of which is `tests/learning/types.test.ts` — 89 lines of type guard
machinery for a question type that is being removed.

Two skills disagree about what the mode is.
`skills/learning/learning-mode/SKILL.md:3` describes it as *"Socratic
quizzing after architecture updates"* and `:28` instructs the agent to *"Wait
for the user's answer: Do NOT proceed with the next task until the user
answers."* The adjacent `skills/learning/explain-decisions/SKILL.md` is doing
something entirely different and considerably better: read the decision, present
decision / why / alternatives-rejected / related, and *"Do NOT fabricate
rationale that isn't in arkive/architecture.json"* (`:43-44`).

`explain-decisions` is the seed of what should replace the quiz. It already
encodes the right instinct — traverse to the fact, present it against what was
rejected, never invent — and it is currently the *optional* mode while the quiz
is the headline feature (`README.md:29`, `README.md:59`, `README.md:89`).

`src/learning/progress.ts:6` also writes to a `.arkive/` directory while the
document lives in `arkive/` (`src/io/architecture-file.ts:7`). Two conventions
for one product, and `skills/learning/learning-mode/SKILL.md:14` documents the
wrong one relative to the directory `init` actually creates
(`src/cli/commands/init.ts:69-72`).

## Decision

**Delete Learning Mode. Replace it with an agent-led layered walkthrough that runs
in the agent conversation, not in the viewer.**

### The mechanism

The walkthrough is not a UI. It is a set of **traversal primitives** exposed over
MCP, plus a narration contract the agent follows. The viewer renders the result
if the user wants to see it (ADR-0004); the understanding happens in the
conversation.

Three traversal primitives, each a pure query over the graph:

1. **`topology()`** — every node and edge with no prose. The answer to "what is
   this system". Compresses to a few hundred tokens because structure is derived
   and needs no narration (ADR-0002).
2. **`open(ref, depth)`** — one node or edge opened into what it contains: its
   inbound and outbound edges by kind, its `module` children, its data shapes,
   and its `decided_by` decisions. The answer to "what is this boundary".
3. **`trace(entryRef, exitRef)`** — a path through the graph, annotated with the
   edge kind at each hop. The answer to "what happens when a request arrives".
   This is what `dataFlows[]` was reaching for and never achieved
   (ADR-0001 records this as a wart); `trace` is a query over real edges, not a
   separately-maintained narrative.

Two additional read primitives the primitives depend on:
`decisionsAbout(ref)` (the decision plus its rejected alternatives, which is
`explain-decisions` turned into a tool) and `dataShapes(ref)`.

### Layered abstraction

The agent chooses the starting layer; the learner chooses the destination.

- **System** — `topology()`. Boundaries and directions, no detail.
- **Subsystem** — `open(service)` or `open(endpoint)`. Modules, edges by kind,
  data shapes.
- **Module** — `open(module)`. What it imports, what imports it, what it reads
  and writes.
- **Decision** — `decisionsAbout(ref)`. The choice, the rationale, and what was
  rejected. Reached by descent, never offered as an opening move.

Progressive disclosure in both directions: the AI decides how to present, the
learner decides where to go. "Open that one" and "why is this boundary here" are
both first-class moves.

### "Engaging", as a testable property

Three measurements. None of them is a satisfaction survey.

1. **Transfer.** After a walkthrough, the learner answers questions of the form
   "what depends on X", "why does Y exist", "what happens when a request hits Z"
   **without opening the document**. Pass ≥ 80%. This is `docs/VISION.md:129-130`
   made operational.
2. **Time to first correct answer.** Under 60 seconds per question. Recall of a
   quiz answer is fast; recall of structure is not. If time-to-answer does not
   rise versus a quiz baseline, the walkthrough is testing recognition and has
   failed.
3. **Learner-authored destination.** In at least one session the learner asks to
   go somewhere the agent did not propose. This is the measurable form of "AI
   chooses presentation, learner chooses destination" — a walkthrough in which
   every move is agent-chosen is a lecture, and this counter catches it.

Supporting metrics, tracked but not gating: session abandonment rate, and
revisit rate within seven days.

The single-question baseline for comparison is the existing quiz: if the
walkthrough cannot beat `src/learning/questions.ts` on transfer *and* on
time-to-answer, it has not earned its place.

### What is deleted

- `src/learning/questions.ts`, `concepts.ts`, `progress.ts`,
  `progress.shared.ts`, and the question half of `types.ts`
  (`src/learning/types.ts:14-69`).
- `src/viewer/src/components/QuizPanel.tsx`, `QuestionCard.tsx`,
  `ProgressTracker.tsx`, `ConceptMap.tsx`,
  `src/viewer/src/views/LearningView.tsx`, and the `activeView === "learning"`
  branch at `src/viewer/src/App.tsx:27-30, 174-179`.
- `src/cli/commands/learn.ts` and the HTTP endpoints at
  `src/cli/commands/serve.ts:78-99`.
- `tests/learning/` in full — five files.
- `skills/learning/learning-mode/` in full, including
  `references/question-templates.md`.
- `README.md:29`, `README.md:59`, `README.md:89`, and the `ViewId` entry for
  `learning` in `src/viewer/src/components/ViewSwitcher.tsx`.

### What is kept

- `Decision.alternatives[].whyNot` (`src/schema/architecture.ts:47-50`). This is
  the spine. A decision without a rejected alternative is a default, not a
  decision — `skills/core/architecture-tracker/SKILL.md:155` already says so, and
  that rule is correct and stays.
- `skills/learning/explain-decisions/SKILL.md`, promoted from optional mode to
  the reference implementation of the `decisionsAbout` narration. Its `MUST NOT`
  section (`:43-44`) is lifted into the system prompt for every traversal.
- `dataFlows[]` as authored data, surfaced through `trace` (ADR-0001).
- `src/server/session-context.ts` — it is already a layered summary and is the
  right shape for the System layer.

### Progress

There is no progress file. The learner's progress is that they can answer the
questions. `.arkive/` (`src/learning/progress.ts:6`) goes away with the rest.

## Consequences

### Positive

- The feature matches how people actually learn a system, and stops punishing
  the hands-off builder who wants to understand what they shipped
  (`docs/VISION.md:69-74`).
- 5 learning source modules, 6 React components, 5 test files, 1 CLI command,
  2 HTTP endpoints, and 2 skills deleted. This is the largest single reduction in
  the repository's surface.
- Four of the five `tests/learning/` files test machinery that exists to build
  questions. Their removal retires the problem, not the tests.
- `README.md` stops describing Socratic gating and starts describing something
  that works.
- Removes the protocol-invention defect at `src/learning/questions.ts:121-127`
  entirely — a learner can no longer be marked wrong for choosing gRPC.

### Negative

- **Loses a working feature.** Quiz mode functions today, has tests, and has
  users who opted in (`skills/learning/learning-mode/SKILL.md:11-14`). This is a
  removal, not a deprecation.
- **The walkthrough depends on the agent.** Quality varies with the model and the
  prompt, and it is not unit-testable the way `tests/learning/questions.test.ts`
  is. The traversal primitives *are* testable, deterministically, because they
  are queries. The narration is not, and that is a real loss of test coverage.
- **Transfer measurement requires real users.** The success criterion in
  `docs/VISION.md:129-130` cannot be met by the author alone. It needs five
  outside users on projects they did not write.
- The prompt-queue walkthrough entry point (README "Prompt Queue") survives, but
  its natural pairing with the quiz UI does not.

## Alternatives considered

**Keep the quiz, add the walkthrough alongside.** Rejected.
`docs/VISION.md:58-60` rules the framing out, and two mechanisms to learn one
thing is worse than one good mechanism. The quiz also carries real defects —
fabricated protocol options, position derived from id, mastery granted on one
correct answer — that would survive and keep being wrong.

**Rewrite the quiz into better questions — ordering, short-answer, free recall.**
Rejected. This improves the instrument without changing the premise. The premise
is that the learner is being examined. They should not be.

**Build the walkthrough as a viewer feature — a guided tour UI with next/prev.**
Rejected. It re-creates the viewer as a product (`docs/VISION.md:76-80`) and
requires the agent's participation to be simulated in the UI. The AI-chosen /
learner-chosen split is a conversational property; a wizard cannot express it.

**Let the agent read the raw document and narrate freely, no traversal
primitives.** Rejected. This is today's `architecture://session-context` path,
and `src/server/session-context.ts:31-53` shows why it does not scale: services
and connections are pushed in full before any budget is applied, so a large
project either blows the context window or is truncated in a way the agent cannot
detect. Primitives make the budget explicit and the traversal observable.

**Keep progress tracking, measure differently — topics visited rather than
concepts mastered.** Rejected. It preserves the file, the endpoints, and the
components to solve a problem that no longer exists.

## Related

- ADR-0001 — `trace` and `decisionsAbout` query the v2 graph.
- ADR-0002 — derived structure makes `topology()` cheap.
- ADR-0004 — the walkthrough renders through a much smaller viewer.
- `docs/issues/0009`, `0015`.