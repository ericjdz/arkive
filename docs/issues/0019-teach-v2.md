# 0019 — Teach v2, not v1

status: open
stream: docs
priority: high
blocked_by: 0005, 0006

## Context

Issues `0003` and `0004` replaced the v1 document with a v2 graph. The prose
that teaches agents how to use it was never updated, so **every shipped
instruction file currently describes a schema that no longer exists.**

This is not cosmetic. These files are what an agent reads to decide how to
maintain the document. An agent following `AGENTS.md` today writes `services[]`
and `relatedServices` into a v2 file, and per ADR-0001 those fields are
regenerated on write — so its work is silently discarded.

## Confirmed stale

| Location | Stale claim |
|---|---|
| `README.md:132-134` | Documents `services`, `connections`, and decisions carrying `source` / `confidence`. ADR-0002 deleted `confidence`; v2 has `nodes[]` / `edges[]`. |
| `README.md:184` | Instructs setting `"source": "agent-scanned"` and `"confidence": 0.8`. That field is gone, and `confidence` was rejected for a reason: a number an LLM assigns to itself is not evidence. |
| `AGENTS.md:48` | Decision shape lists `relatedServices[]`. ADR-0001 replaced it with `subjects[]`. |
| `CLAUDE.md:99` | Example JSON uses `relatedServices`. |
| `skills/core/architecture-tracker/` | Documents `services` / `relatedServices` as authored fields. |
| `skills/core/arkive-init/` | Same. |
| `skills/core/architecture-tracker/references/schema-guide.md` | Describes the v1 schema. |
| `src/templates/*.hbs` | The rendered bootstrap block teaches v1. |

## The behavioural reversal, again

`skills/core/architecture-tracker/SKILL.md:157` currently says:

> Do NOT re-derive the architecture from code if `arkive/architecture.json`
> exists - trust the document.

ADR-0002 requires the **opposite**: structure is never transcribed, it is
derived. Every agent running the currently-installed skill has been trained to
trust a document that, by design, drifts from the code.

ADR-0002 is explicit that this must be **deleted, not amended**. It is a
reversal of behaviour, not a wording fix, and it is the single highest-risk
change in the ADR set. It is still outstanding.

## Scope

1. Rewrite `README.md`'s schema section, the agent install guide, and the
   MCP tool/resource tables against v2. Remove every `confidence` reference and
   say why it is gone.
2. Update `AGENTS.md` and `CLAUDE.md` bootstrap blocks, and every
   `src/templates/*.hbs` that renders them.
3. Update all three skills and `references/schema-guide.md`.
4. **Delete the `trust the document` rule** and replace it with the
   derived-by-default rule: structure comes from derivation, the agent records
   intent only.
5. Update the viewer-facing prose if it describes the document shape.

## Acceptance criteria

- [ ] No file in `skills/`, `src/templates/`, or the root instruction files
      mentions `services[]`, `connections[]`, `relatedServices`, or
      `confidence` as a field to write. Grep proves it.
- [ ] The `trust the document` instruction is gone. Grep proves it.
- [ ] A fresh `arkive init` produces an agent that, given a repo, derives
      structure rather than transcribing it. Demonstrated in a transcript.
- [ ] The README's claims match what the code does. Spot-check every claim in
      the "For Agents" section against the running tool — several were already
      false in v0.2.1 and were never corrected.

## Note

Run this **after** `0005` and `0006`, so the documents can describe what the
derivation engine actually produces rather than what it was supposed to.
Writing them now would encode a second set of claims to correct later — which
is precisely how `SKILL.md:157` came to contradict ADR-0002 in the first place.