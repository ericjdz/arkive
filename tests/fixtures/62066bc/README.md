# Fixture: incident 62066bc

**Do not update these files.** They are a preserved artifact of a real data-loss
incident inside this repository, committed byte-for-byte so the regression tests
that guard against it have something real to assert on.

## What happened

Commit `62066bc` — *"feat: move architecture.json path into arkive/
subdirectory"* — changed the code path and not the data:

```diff
 export function architecturePath(dir: string): string {
-  return join(dir, ARCHITECTURE_FILENAME);
+  return join(dir, ARKIVE_DIR, ARCHITECTURE_FILENAME);
 }
```

A blank scaffold was written at `arkive/architecture.json`. The real document
stayed at the repository root. Both files existed at once and nothing warned,
because nothing could warn: `init` tested only whether the *new* path existed.

Four recorded architectural decisions were destroyed. `dec-003` recorded the
React 18/19 duplicate-React bug and why pinning to 18 would not have fixed it —
exactly the class of knowledge this product exists to preserve.

## The two files

| File | What it is | Services | Decisions | dataFlows |
|---|---|---|---|---|
| `legacy-root-architecture.json` | The **real** document, orphaned at the old path. Recovered verbatim as `arkive/legacy-architecture.json`. | 7 | **4** | 3 |
| `orphan-arkive-architecture.json` | The **scaffold** that shadowed it. `"decisions": []`. | 3 | **0** | 0 |

Counts are asserted by `tests/io/legacy-paths.test.ts`. If someone "fixes" a
fixture to make a test pass, the test is what is wrong.

## How the tests use them

- `tests/io/legacy-paths.test.ts` — reproduction of the incident, driven through
  the real `init` entry point.
- `tests/cli/init-integrity.test.ts` — the same thing through the CLI, including
  the refusal, the exit code, and the recursive tree hash that must not change.

Both assert on the **absence** of files as well as the content of files that are
present. `62066bc` did not corrupt anything. It wrote something new and left the
old thing alone, and only an assertion about what does *not* exist catches that.

See `docs/adr/0006-data-integrity-is-a-product-feature.md` and
`docs/legacy-architecture.md`.
