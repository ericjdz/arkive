# The `services` projection: kept, bounded, and not an authoring surface

> Decision record for `docs/issues/0004-graph-persistence.md` §4, which asks:
> "Maintain the deprecated top-level `services[]` / `connections[]` as a derived
> view ... **Decide honestly whether this projection survives v0.3 or is deleted
> once consumers migrate** — and if it survives, it must never be authored
> directly, because a hand-editable derived field is a drift source."
>
> Status: decided. Not an ADR — it implements ADR-0001 rather than competing
> with it.

## Decision

**The projection is kept, it is persisted, and it is never an authoring
surface.** Three parts, and the third is the one that matters.

1. **Kept**, because seven consumers still read it and none of them are in this
   change. `handleUpdateArchitecture` mutates `arch.services` and writes it back
   (`src/server/tools.ts:184-219`); `buildSessionContext`, `questions.ts`,
   `generateMarkdown`, `generateMermaid`, `App.tsx` and `detectDrift` all read
   it. A projection that existed only at the MCP boundary would break the
   `arkive-init` and `architecture-tracker` skills outright, because those read
   `arkive/architecture.json` as a file.

2. **Persisted**, because those two skills read the file directly and an agent
   following `architecture-tracker/SKILL.md` will edit `services[]` by hand. If
   the field were absent, the skill would tell the agent to create it, and the
   agent would create a *second* source of truth. That is worse than having a
   derived one.

3. **Never an authoring surface.** This is the part ADR-0001 insists on and the
   part that needs defending, so it is enforced in four places:

   | Rule | Where |
   |---|---|
   | The read path recomputes it from the graph and never reads it from disk | `projectOnto`, `src/io/architecture-file.ts` |
   | The write path regenerates it from the folded graph and never from the input | `withDerivedView`, `src/io/architecture-file.ts` |
   | A v1 edit is folded onto the graph *before* validation, so the stored copy is always derived from the graph it ships with | `foldV1ViewOntoGraph`, `src/io/v1-authoring.ts` |
   | A node or edge is only *removable* through the view if the v1 document could have produced it (`legacyType` / `legacyEdge`) | `foldV1ViewOntoGraph`, `src/io/v1-authoring.ts` |

The last row is the one that took the most work to get right, and it is worth
recording why it exists. Without it, the deprecated view can **delete the graph
it is derived from**: a caller adds a node to `nodes` and does not also update
the `services[]` array sitting next to it, the fold sees a node the view does
not contain, and concludes the author deleted it. The node is tombstoned. No
error, no warning, a successful write. A derived view that can delete its own
source is exactly the "hand-editable derived field is a drift source" failure
the issue warns about, reproduced through the back door.

`legacyType` and `legacyEdge` are markers, not semantics. Nothing traverses on
them. `legacyType` additionally holds the v1 deployment label verbatim so the
projection round-trips a v1 document byte-for-byte; `legacyEdge` marks only
"this edge came from `dependencies[]` or `connections[]`".

## What it costs, stated plainly

- **The document on disk is roughly 60% larger.** Seven nodes, six connections
  and fourteen edges, with the projection alongside. That is the price of
  ADR-0001's "never stored" being wrong about the file-reading audience.
- **Two code paths can disagree.** `projectDocument` (on read) and
  `foldV1ViewOntoGraph` (on write) are inverses of each other, and only tests
  keep them so. `tests/io/legacy-roundtrip.test.ts` asserts
  `onDisk.services === projectDocument(onDisk).services` directly, which is the
  check that catches a divergence the moment one appears.
- **One module is load-bearing for the whole transition.** `src/io/project.ts`
  is the only place allowed to produce the v1 shape. A second one is the ADR's
  "two writers, no reconciler" failure arriving on schedule.

## What it loses, and whether that is acceptable

| Lost | Why acceptable |
|---|---|
| `Service.type` as a *semantic* field | ADR-0001 deletes it because it overlaps `kind` and answers no structural question. The value survives as `legacyType`, so nothing is lost — it is just not load-bearing. |
| `source` / `confidence` | ADR-0002 deletes both as inert. They are carried verbatim anyway, because `drift.ts` reads `confidence` and dropping it would silently *reduce* the warnings a migrated document emits. A drift detector that goes quiet is worse than one that nags. |
| `kind: "edge"` decision subjects | v1 has no way to express "this decision explains an edge". They stay in `subjects`, which is authoritative, and `relatedServices` reports only the node subjects. |
| The distinction between `calls` and `reads` | Not lost — the projected connection carries `kind` alongside `protocol`. Only a consumer that ignores `kind` cannot tell them apart, and that consumer was already unable to. |

## Does it survive v0.3?

**No.** ADR-0001:201-203 already sets the end date: "The projection layer is
code that exists to serve legacy shapes. It has an end date: delete it when
`docs/issues/0010` completes." Nothing found here argues for extending it.

The deletion is mechanical once the consumers are migrated, and the work is
listed in `src/server/tools.ts` — see the follow-ups in the 0004 report. When it
happens:

1. `writeArchitecture` stops calling `withDerivedView`; the file holds the graph
   and nothing else.
2. `foldV1ViewOntoGraph` and `legacyType`/`legacyEdge` go with it. So do
   `validateV1Authoring` and `validateV1View`.
3. `readArchitecture` returns `ArchitectureDocumentV2` with no v1 fields, and
   every consumer that reaches for `.services` fails to compile — which is the
   point, and the reason the projection was kept derived rather than kept
   authored.

The date is a dependency, not a preference. The projection cannot be deleted
before `src/server/tools.ts` stops writing through it, because until then
`update_architecture` would become a silent no-op.

## What would make this decision wrong

- **If `0005` derives module nodes at scale and they all appear in
  `services[]`.** `projectServices` includes every live node, and it must —
  a projection that hid node kinds would let the fold read them as deletions.
  For a repository with a thousand directories, the v1 view becomes a thousand
  "services", which is noise in the skills' instructions and in `status`.
  If that turns out to hurt, the fix is to teach `architecture-tracker` about
  `nodes`/`edges` rather than to filter the projection: a filtered projection
  reintroduces exactly the deletion bug the `legacyType` guard prevents.
- **If a second writer ever appears.** The whole argument is that there is one
  writer and it regenerates the field. A second writer is what ADR-0001
  predicts, and it is the moment this decision should be revisited rather than
  patched.