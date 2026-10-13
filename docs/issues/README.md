# arkive issue tracker

Issue format is one markdown file per issue: `NNNN-slug.md`. Each declares its
blocking edges in the header. A stream is a group of issues with no internal
blocking edges and may be worked in parallel.

Status: `open` · `in-flight` · `blocked` · `done`

## Waves

| Wave | Issues | Gate to start | Depends on |
|---|---|---|---|
| 0 | 0001, 0002 | — | — |
| 1 | 0003, 0013, ~~0016~~ | Wave 0 | 0001, 0002 |
| 1b | 0017, 0018 | 0016 done | 0016 |
| 2 | 0004 | Wave 1 | 0003, 0013 |
| 3 | 0005, 0006, 0011, 0012 | Wave 2 | 0004 |
| 4 | 0008, 0007 | Wave 3 | 0004 |
| 5 | 0009 | Wave 4 | 0008, 0011 |
| 6 | 0010 | Wave 5 | 0009 |
| 7 | 0015, 0014 | Wave 6 | — |

## Register

| # | Title | Stream | Status | Blocks |
|---|---|---|---|---|
| 0001 | Toolchain and CI green | foundations | done | — |
| 0002 | Vision and ADR set | docs | done | — |
| 0003 | Graph schema v2 | graph | done | 0004, 0005, 0006, 0008, 0010 |
| 0004 | Graph persistence and projections | graph | done | 0005, 0006, 0008 |
| 0005 | Module derivation engine | derive | done | 0007, 0014 |
| 0006 | Data structure extraction | derive | done | 0014 |
| 0007 | Continuous reconciliation | derive | done | 0014 |
| 0008 | Decision attachment to graph | record | done | 0009 |
| 0009 | Layered walkthrough engine | comprehend | done | 0010, 0015 |
| 0010 | Viewer re-architecture | view | open — next | — |
| 0011 | Harness hook substrate | enforce | done | 0009 |
| 0012 | Session context budget | context | done | — |
| 0013 | Data integrity | integrity | done | 0004 |
| 0014 | Self-dogfood arkive | meta | open | — |
| 0015 | Retire quiz learning mode | comprehend | open | 0009 |
| 0016 | Viewer server trust boundary | security | done | 0017 |
| 0017 | Close the auth follow-ups from 0016 | security | done | — |
| 0018 | Viewer build hygiene | view | open, low | 0010 |
| 0019 | Teach v2, not v1 | docs | done | — |

`0001` and `0002` have no issue files — they were the foundations and ADR
waves. Their scope is captured in `docs/VISION.md` and `docs/adr/`.

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

`0016` is **done**, verified with before/after evidence against a live server.
It produced `0017`, which carries its own two follow-ups — including a live
regression it could not fix inside its file boundary.

## Corrections log

Sub-agent claims that verification disproved. Recorded so the same claim is not
re-litigated later.

- **"The static viewer is never served in the packaged build"** (reported by the
  0016 agent). **False.** `serve.ts:346` resolves `resolve(__dirname,
  "../viewer")`, which from `dist/cli/index.js` is `dist/viewer` — exactly where
  Vite emits. Verified by running `npm run build:viewer` and listing the output
  (`dist/viewer/index.html`, `dist/viewer/assets/index-*.js`). The *directory
  contents* observation was accurate — only stray `.d.ts` files were present at
  that moment — but the causal claim was not. Split out as `0018`.
- **"`src/walkthrough/index.js` does not exist yet, so the fallback engine is
  live"** (reported by the 0009 server agent about the parallel engine agent).
  **False at wave end.** The engine module had landed with its named
  `topology` / `open` / `trace` exports; the passing `topology` / `trace`
  tests were already serving the real engine. Stale observation of parallel
  work in flight, not a wiring gap. The fallback (`src/server/tools.ts`) is
  removed; the loader fails loudly on a missing engine.
- **"`src/walkthrough/levels.ts` references an undefined `toDecisionEntry`,
  and `tests/walkthrough/` has implicit-`any` errors"** (same report).
  **False.** `tsc --noEmit` on both projects was clean with those files
  present. Same staleness as above.
- **"The 5 failing `tool-consolidation` walkthrough tests fail on items in the
  server agent's owned files"** (reported by the 0009 engine agent).
  **True, and a real seam bug, not an ownership dispute.** The engine speaks
  `{ found: false }` domain misses; the transport normaliser
  (`asEngineResult`) wrapped every non-`success` object as success, so bad
  refs surfaced without `isError`, and the engine groups `open` edges by
  kind while the MCP contract is flat arrays. Fixed in integration:
  `found: false` translates to `isError`, grouped edges flatten at the
  transport boundary, engine untouched.

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