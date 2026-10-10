# ADR review feedback — Wave 1

Findings raised by implementation agents while building `0003` (graph schema)
against ADRs 0001 and 0002. Recorded before either ADR moves from `Proposed` to
`Accepted`. An ADR that survives contact with an implementer without
correction was not a real decision record.

---

## 1. ADR-0002's derivation table reads as a spectrum; it is a binary

**Challenge.** ADR-0002's node/edge table is presented as
derived → hybrid → authored, which reads as a completeness axis. It is not.
Three of six edge kinds are mechanically derivable. The other three require
someone to have understood something. `derives_from` and `decided_by` sit at
the same level of effort — both are assertions a derivation cannot confirm —
but the table's layout invites a reader to think the middle column is cheaper
work than the right-hand end.

**Verdict: accepted.** The table should not imply a gradient.

**Action.** Reformat as a two-column split — *mechanically derived* vs
*requires human or agent understanding* — with `service`, `datastore`,
`endpoint`, `reads`/`writes` appearing on both sides with an explicit
"derived evidence, authored intent" split. `decided_by` is not the weakest
edge kind because it is derived last; it is not derived at all.

---

## 2. ADR-0006 rejects `.passthrough()` for the wrong reason

**Challenge.** ADR-0006's alternatives section rejects passthrough objects on
the grounds that `.default()` values get materialised into the user's file on
write. That is correct, but it is a property of *the code using it*, not of
the mechanism. As written, the rule gives a future author no way to know when
it stops applying — it reads as "never use `looseObject`," which would block
the very fix that solves ADR-0006's §3 problem.

**Verdict: accepted, and the rule is now falsifiable.**

**Action.** Restate as: *the document schema contains no `.default()` anywhere;
`parse(x)` must be deep-equal to `x`; given that, `looseObject` is free and is
the correct choice.* The implementer proved this constructively — v2 has no
defaults, the first test asserts `parse(input) === input` by reference
identity, and adding any default fails the suite immediately. The guarantee
that matters is now enforced rather than advised.

---

## 3. ADR-0006 §3 is ranked too high

**Challenge.** The ADR calls writing the original parsed object "the single
highest-leverage change in this ADR." It is one line, and it prevents a class
of loss — but only within a single process. A crash between temp-write and
rename still truncates the document, which is ADR-0006's own §2. And it says
nothing about two concurrent writers, which ADR-0005's hooks make likely. On
the actual risk ordering, transactional writes matter more than unknown-key
preservation.

**Verdict: accepted.**

**Action.** Re-rank. The ordering becomes: (1) transactional writes,
(2) concurrent-writer serialisation, (3) unknown-key preservation,
(4) dry-run and consent. Unknown-key preservation remains worth doing and
remains nearly free — it is just not the one to build first when the others are
missing.

---

## 4. Confirmed and carried forward

- **ADR-0001's `decided_by` exclusion from `StorableEdgeKind`.** Implemented as
  a compile-time constraint rather than a runtime check, which is stronger than
  the ADR specified. A stored `decided_by` validates but warns.
- **Migrated elements are `authoredBy: "agent"`, not `derived: true`.** A
  migration runs no analysis, so claiming a derivation rule produced something
  no rule ever saw would be a fabrication. Correct, and worth stating
  explicitly in ADR-0001.
- **Decision subjects as `Array<{kind, ref}>` rather than parallel string
  arrays.** Correctly supersedes issue `0003` §4 — parallel arrays reintroduce
  exactly the ambiguity that discriminators remove.
- **v1 remains readable and lossy.** v1 documents still strip unknown keys, and
  that is deliberate: loosening v1 would materialise its defaults into every
  existing user's file on the next write. The fix belongs on the write side,
  not the schema side. Carried into issue `0004`.