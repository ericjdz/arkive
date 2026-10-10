# Vision — arkive

> The authoritative statement of what arkive is for. Everything else is
> implementation. If a change contradicts this document, this document is wrong
> or the change is. Resolve that explicitly, never silently.

## The problem

AI coding agents build entire projects from a single prompt. The result is
fast, and largely incomprehensible to the person who now owns it.

Two distinct failures, often confused:

1. **Nobody can explain the system.** The agent chose Postgres over Mongo,
   REST over GraphQL, a monolith over services. It had reasons — some of them
   good, many of them accidents of context. Those reasons were never written
   down. The agent that made the choice has forgotten them by the next session.
2. **Nobody understands the system.** Engineers increasingly do not read the
   code. They describe intent, an agent writes the implementation, and they
   accept it. This is a legitimate way to work — until the system gets big
   enough that you cannot debug it, extend it, or hand it to someone else.

arkive exists to close both. The first is a **record** problem. The second is a
**comprehension** problem. They have one shared prerequisite: a structural
memory of the system that is accurate, connected, and survives the agent that
wrote the code.

## The three layers

arkive is one substrate and two experiences built on it.

### 1. Graph — structural memory (the substrate)

The project is represented as a **connected graph**, not a list of services.

A service list answers "what are the pieces." A graph answers "what are the
pieces, how do they depend on each other, what data shapes flow between them,
and which decision created each edge." The second question is the one that
matters and the one no agent retains across sessions.

Nodes are typed: `module`, `service`, `datastore`, `external`,
`datastructure`, `endpoint`. Edges are typed: `imports`, `calls`, `reads`,
`writes`, `derives_from`, `decided_by`. Decisions attach to the nodes and
edges they created, so "why does this exist" is a traversal, not a search.

The graph is **derived first, authored second**. Structure comes from static
analysis of the actual code, because structure is a fact and facts should not
be transcribed by an LLM. What static analysis cannot produce — intent,
rationale, rejected alternatives — is what the agent and the human author. This
split is the single most important design decision in the system, and it is why
the graph can be trusted when a hand-maintained list cannot.

### 2. Comprehend — the learning layer

A learner, or a hands-off builder who wants to understand what they shipped,
traverses the graph at a level of abstraction that matches their question.

**This is not a quiz.** The previous implementation generated Socratic
questions and tracked concept mastery. That was wrong: it tests recall, it
interrogates, and it is not how anyone learns a system. It is being replaced.

What replaces it is an **agent-led architectural walkthrough**. The system is
presented in abstract form first — topology, boundaries, data shapes — and
probed on demand for specifics: a request traced end to end, a service opened
into its modules, a decision explained against what was rejected. The AI
decides how to present; the learner decides where to go. Progressive disclosure
in both directions, from "what is this system" down to "why this boundary."

This serves two audiences with one mechanism:

- **Hands-off builders** who need to grasp what they shipped well enough to
  trust it and talk about it.
- **Learning engineers** who need to study system design against a real,
  specific system rather than a textbook diagram.

### 3. View — the lightweight surface

The viewer renders the graph and the walkthrough. It is deliberately the
smallest of the three layers. It exists so a human can *see* the structure
without a terminal, not as a product in its own right.

The current viewer is six React views built on React Flow and D3. That is too
heavy for what it does, and it is the largest source of build and test
breakage in the repository. It is being re-engineered downward — the target is
a build-free artifact that renders the graph and nothing else. See ADR-0004.

## What the previous version got wrong

Recorded here so the failure is not repeated.

- **Enforcement was prose.** The three lifecycle rules — read on session start,
  update before a major change, update after — existed in five duplicated
  markdown files and were enforced by nothing. The agent was asked to remember.
  The harness now hands the agent what it needs (ADR-0005).
- **The artifact grew without bound.** History appended forever, a full-document
  snapshot written on every single write. The cure for context rot reproduced
  it. Growth is now bounded by construction.
- **A path migration silently destroyed four recorded decisions.** Changing the
  document location from `architecture.json` to `arkive/architecture.json`
  scaffolded an empty document at the new path and orphaned the real one at the
  old path. Both files are still in the repository. Nothing warned. This is the
  failure the product exists to prevent, and it happened inside the product.
  Migrations are now a first-class, tested concern (ADR-0006).
- **It was not used by its author.** The strongest evidence about a tool's
  value is whether the person who built it uses it. This repository should be
  the worked example, not the counterexample.

## Non-goals

These are decided. Do not re-litigate them in issues without new evidence.

- **Not a hosted service.** No accounts, no sync, no telemetry. The moat is
  local, vendor-neutral, and git-committed. Hosting converts a trust asset
  into a liability.
- **Not an LLM-judged drift detector.** Calling a model to compare the document
  to the code produces confidently wrong repairs and destroys the determinism,
  cost profile, and offline operation that make the system trustworthy.
- **Not an agent framework.** arkive does not orchestrate agents, spawn them, or
  compete with their harnesses. It is memory and comprehension, and it should
  work with whatever agent the user already runs.
- **Not a documentation generator.** Prose documentation is a solved problem and
  a worse one. Structure is the artifact.

## Definition of done for v0.3

1. `npm run lint` and `npm test` pass in CI. No exceptions, no skips.
2. The graph is derived from the code automatically and reconciles continuously,
   not on demand.
3. A fresh user can complete a guided walkthrough of a real project and
   explain its architecture afterwards. Measurable, not assumed.
4. arkive's own repository is a complete, current, honest worked example —
   every node, edge, and decision real.
5. No path, schema, or configuration change can destroy user data silently.