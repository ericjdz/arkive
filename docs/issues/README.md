# arkive issue tracker

Issue format is one markdown file per issue: `NNNN-slug.md`. Each declares its
blocking edges in the header. A stream is a group of issues with no internal
blocking edges and may be worked in parallel.

Status: `open` · `in-flight` · `blocked` · `done`

## Waves

| Wave | Issues | Gate to start | Depends on |
|---|---|---|---|
| 0 | 0001, 0002 | — | — |
| 1 | 0003, 0013, 0016 | Wave 0 | 0001, 0002 |
| 2 | 0004 | Wave 1 | 0003, 0013 |
| 3 | 0005, 0006, 0011, 0012 | Wave 2 | 0004 |
| 4 | 0008, 0007 | Wave 3 | 0004 |
| 5 | 0009 | Wave 4 | 0008, 0011 |
| 6 | 0010 | Wave 5 | 0009 |
| 7 | 0015, 0014 | Wave 6 | — |

## Register

| # | Title | Stream | Status | Blocks |
|---|---|---|---|---|
| 0001 | Toolchain and CI green | foundations | in-flight | 0003, 0013, 0016 |
| 0002 | Vision and ADR set | docs | in-flight | 0003 |
| 0003 | Graph schema v2 | graph | open | 0004, 0005, 0006, 0008, 0010 |
| 0004 | Graph persistence and projections | graph | open | 0005, 0006, 0008 |
| 0005 | Module derivation engine | derive | open | 0007, 0014 |
| 0006 | Data structure extraction | derive | open | — |
| 0007 | Continuous reconciliation | derive | open | — |
| 0008 | Decision attachment to graph | record | open | 0009 |
| 0009 | Layered walkthrough engine | comprehend | open | 0010, 0015 |
| 0010 | Viewer re-architecture | view | open | — |
| 0011 | Harness hook substrate | enforce | open | 0009 |
| 0012 | Session context budget | context | open | — |
| 0013 | Data integrity | integrity | open | 0004 |
| 0014 | Self-dogfood arkive | meta | open | 0005, 0006, 0008 |
| 0015 | Retire quiz learning mode | comprehend | open | 0009 |
| 0016 | Viewer server trust boundary | security | open | — |

## Critical path

```
0001 ─┬─ 0003 ─ 0004 ─┬─ 0005 ─ 0007 ─┐
      ├─ 0013 ────────┤               │
0002 ─┘               ├─ 0008 ─┐      ├─ 0009 ─ 0010 ─ 0015
0016 ─────────────────┴─ 0006  └──────┘
```

`0013` (data integrity) and `0016` (server trust boundary) are both on the
critical path. They exist because the product has already destroyed user data
silently, and currently exposes an unauthenticated server on every interface.

## Parallelism constraints

These issues touch overlapping files. Assign them to different agents, or run
them serially.

- `0003` and `0004` both touch `src/schema/` — serialise.
- `0005` and `0006` both touch `src/analysis/scanner.ts` — serialise, or split
  the file first.
- `0009` and `0010` both touch the walkthrough data contract — `0010` must not
  start until `0009` has frozen it.
- `0016` and `0001` both touch `serve.ts` and `tests/cli/serve.test.ts` —
  serialise. `0016` starts after `0001` lands.
- `0001` must finish before any agent writes feature code. Parallel agents
  cannot verify work against a red suite.

## Cross-references

Every issue with an `adr:` header links to a decision record in `docs/adr/`.
Where an issue and an ADR disagree, the ADR wins and the issue is corrected —
that already happened once: issue `0003` originally specified extending the
existing `source`/`confidence` provenance pair, and ADR-0002 supersedes it by
deleting `confidence` in favour of `derived` / `rule` / `evidence[]`.