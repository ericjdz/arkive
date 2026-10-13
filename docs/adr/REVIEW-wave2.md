# ADR review feedback — Wave 2

Findings raised while implementing `0009` (narration contract + skills +
docs half) against ADR-0003. Recorded before the ADR moves from
`Proposed` to `Accepted`. Corrections are PROPOSED here — ADR-0003
itself is not edited.

---

## 1. Issue 0009 cites an ADR filename that does not exist

**Challenge.** `docs/issues/0009-walkthrough-engine.md:7` gives
`adr: docs/adr/0003-replace-quiz-with-agent-led-walkthrough.md`. The
actual file is `docs/adr/0003-agent-led-layered-walkthrough.md`.

**Verdict: accepted (typo).**

**Action.** Fix the `adr:` line in issue 0009 to the real filename.
Owner: whoever holds 0009 (outside this half's file boundary — reported,
not fixed).

---

## 2. ADR-0003 §What is deleted belongs to 0015/0010, not 0009

**Challenge.** The ADR's deletion list (learning sources, viewer quiz
components, CLI command, endpoints, `tests/learning/`, the quiz skill)
is scoped by issue 0009 itself as out of scope: "The viewer (0010).
Deleting the old quiz code (0015)." An implementer working 0009 against
the ADR as written would delete code another issue owns.

**Verdict: accepted.**

**Action.** Annotate ADR-0003 §What is deleted with owning issues per
line (0015 for sources/tests/skill, 0010 for viewer components), or
move the list to 0015. The frozen contract (`docs/walkthrough-contract.md`)
describes a flow with no quiz and no deletion step either way.

---

## 3. The five primitives are named but not typed

**Challenge.** §The mechanism names `topology()`, `open(ref, depth)`,
`trace(entryRef, exitRef)`, `decisionsAbout(ref)`, `dataShapes(ref)`,
but none exists in the repo — the closest are `why_does_this_exist`
(`src/server/tools.ts`) and the `architecture://` resources
(`src/server/resources.ts`: overview, services, decisions, dataflows,
history, hooks, prompts, session-context). Three signatures are
under-specified: `open`'s `depth` has no semantics (levels? hops?);
`trace`'s relation to authored `dataFlows[]` ("surfaced through `trace`"
in §What is kept) is unstated — query over real edges, authored flow,
or both; `dataShapes(ref)` has no backing store named (datastructure
nodes exist, but no shape-detail schema is referenced).

**Verdict: accepted.**

**Action.** The frozen contract (`docs/walkthrough-contract.md` §2)
pins the typed inputs/outputs for 0010; the engine half of 0009 must
implement to that contract and resolve the three gaps (depth semantics,
trace-vs-dataFlows, shape backing) explicitly. Do not cite
`architecture://topology` or similar URIs — they do not exist.

---

## 4. `open()` returns "`decided_by` decisions" — `decided_by` is not stored

**Challenge.** §Layered abstraction says `open` returns "its `decided_by`
decisions". `decided_by` is a projection computed from
`decision.subjects` at read time (`src/io/decisions.ts:192-216`,
`projectDecidedBy`; AGENTS.md: never stored). An implementer reading the
ADR literally would author or persist `decided_by` rows.

**Verdict: accepted.**

**Action.** Restate as "its decisions via the `decided_by` projection
(computed, never stored); subjects that no longer resolve are reported,
never dropped." The contract already says this (§2, §4).

---

## 5. Engagement test 2 contradicts its own baseline sentence

**Challenge.** §"Engaging" test 2 requires time-to-answer to RISE versus
the quiz baseline (fast recall = recognition = failure), but the closing
sentence requires the walkthrough to BEAT `src/learning/questions.ts`
"on transfer *and* on time-to-answer" — beating on time reads as faster,
which is exactly what the test above calls failure.

**Verdict: accepted, needs a ruling.**

**Action.** Proposed ruling, already encoded in
`skills/walkthrough/SKILL.md`: beat = higher transfer AND median time
under 60s AND above rote-recognition speed. If the ADR intends
"faster than the quiz", test 2 as written is unimplementable.

---

## 6. Three levels vs four, and who picks the start

**Challenge.** Issue 0009 and the contract specify three levels; the
ADR's §Layered abstraction lists four bullets (System, Subsystem,
Module, Decision). Related: the ADR says "the agent chooses the starting
layer" while 0009/the contract say "AI chooses presentation, learner
chooses destination" — an implementer cannot tell whether the opening
move is agent-chosen or learner-chosen.

**Verdict: accepted (wording).**

**Action.** Treat Decision as a step reached by descent, not a level
(contract §2 does this: `explainDecision` is a traversal, and decisions
are "never offered as an opening move"). Clarify that choosing the
starting layer IS the AI's presentation choice; every move after the
opening is the learner's destination.

---

## 7. "Every node walkable at Module level" vs pathless authored nodes

**Challenge.** Issue 0009 requires every node walkable at all three
levels, but `src/io/decisions.ts:59-63` records a real limit: an
authored node with no `path` reaches nothing, and containment is path
containment. A pathless `service` node has no honest Module-level
content — real paths cannot be produced for it.

**Verdict: accepted as an edge case, not a blocker.**

**Action.** Contract §1 (Module) and §5 cover it: a module with no path
is reported, never invented. The engine half should define what Module
level shows for a pathless node (children? edges? decisions only?)
rather than leave "walkable" absolute.

---

## 8. Confirmed and carried forward

- **`whyDoesThisExist` already returns the provenance shape the contract
  needs.** `gate` + `evidence` + `caveats` per claim
  (`src/io/decisions.ts:317-349`) — the contract's §4 is a restatement,
  not a new design.
- **`architecture://session-context` is the right System-layer backing.**
  Budgeted, truncation-visible (`src/server/session-context.ts`) — matches
  the "no prose dump" requirement better than raw `architecture://services`.
- **No quiz, quiz-skill, or progress-bar code was touched.** The
  `skills/learning/learning-mode/` directory is intact; deletion is
  0015's scope. `explain-decisions` gained a header pointer only.
