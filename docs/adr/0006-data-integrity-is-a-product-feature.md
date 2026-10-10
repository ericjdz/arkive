# ADR-0006: Data integrity is a product feature

## Status

Proposed

## Context

arkive exists to preserve the reasoning behind a system that was built by an
agent that has since forgotten it. The tool destroyed some of that reasoning
inside itself.

### The incident, verified

Commit `62066bc` — *"feat: move architecture.json path into arkive/
subdirectory"* — changed two files:

```
 src/io/architecture-file.ts        | 12 +++++++++---
 tests/io/architecture-file.test.ts | 39 ++++++++++++++++++++++++++++++++------
```

The production change was four lines:

```diff
 export function architecturePath(dir: string): string {
-  return join(dir, ARCHITECTURE_FILENAME);
+  return join(dir, ARKIVE_DIR, ARCHITECTURE_FILENAME);
 }
...
   const path = architecturePath(dir);
+  mkdirSync(arkiveDirPath(dir), { recursive: true });
```

The code path moved. The data did not. Both files are in the repository today:

| File | Services | Decisions | dataFlows | history |
|---|---|---|---|---|
| `architecture.json` (root, orphaned) | **7** | **4** | **3** | 4 |
| `arkive/architecture.json` (active) | 3 | **0** | **0** | 5 |

The four destroyed decisions are `architecture.json:113-173`: packaging surface,
MCP+viewer in one package, React 19 vs 18 dedup, and MCP transport modes. Two of
them carry genuine rejected alternatives — `dec-003`
(`architecture.json:142-154`) records the React 18/19 duplicate-React bug and
why pinning to 18 would not have fixed it. That is exactly the class of knowledge
the product exists to keep. It is gone from the active document, replaced by a
scaffold that reads `"decisions": []`.

The root `architecture.json` is still in the repo because git still tracks it.
Nothing warned, because nothing could.

### Why it was possible

**There is no migration detection anywhere.** A search for `migrat`, `legacy`,
`deprecat` across `src/` returns nothing. The only path resolution is
`architecturePath` (`src/io/architecture-file.ts:21-23`), which knows exactly one
location.

**`init` cannot distinguish "fresh project" from "project with a document at the
old path".** `src/cli/commands/init.ts:74-81`:

```ts
const archPath = join(arkiveDir, ARCHITECTURE_FILENAME);
if (!existsSync(archPath)) {
  const architecture = createEmptyArchitecture(projectName, description);
  writeFileSync(archPath, JSON.stringify(architecture, null, 2) + "\n", "utf-8");
}
```

Not-exists means not-exists. A document one directory up is indistinguishable
from no document.

**The tests were updated to match the new behaviour, not to preserve the old
one.** The same commit added 39 lines to
`tests/io/architecture-file.test.ts`. A path change was tested. Data preservation
across a path change was not.

### Two more silent-destruction paths

**Unknown keys are deleted on every write.** `ArchitectureSchema` and every
nested object are built from plain `z.object()`
(`src/schema/architecture.ts:96-111`, `:26-94`), which strips unknown keys in
Zod v4. `package.json` pins `"zod": "^4.4.3"`; verified against the installed
4.4.3:

```
z.object({a}).safeParse({a:"x", custom:{deep:1}, other:"y"})
  → { a: "x" }        // custom survived: false
```

`readArchitecture` returns `validation.data`
(`src/io/architecture-file.ts:63`) and `writeArchitecture` serialises
`validation.data` (`src/io/architecture-file.ts:89`). So the pipeline is
read → strip → write. **Any key arkive does not know about is destroyed by the
next write** — user fields, fields written by a newer arkive that an older one
touched, anything added by hand.

**Prompt claiming is not atomic, and is documented as if it were.**
`src/io/prompt-queue.ts:121-140` is an unguarded read-modify-write: read the
queue, find the first pending, mutate its status, write the whole queue back.
Two agents claiming concurrently both read the same pending prompt, both return
it, and both execute it. `README.md:362` states *"`claim_next_prompt` —
**Atomically** claim the oldest pending prompt"* and
`skills/core/architecture-tracker/SKILL.md:166` repeats it. It has never been
atomic.

### Growth

`saveSnapshot` writes a full-document copy on **every** write
(`src/io/architecture-file.ts:97-101`, `:108-118`) with a timestamp filename, and
`handleUpdateArchitecture` appends a history entry on every call
(`src/server/tools.ts:233-238`). Unbounded.

### Consent

`init` writes, with no prompt and no `--dry-run`:

- `CLAUDE.md` and `AGENTS.md`, via `injectArkiveBlock`
  (`src/cli/commands/init.ts:106-114`)
- `.cursor/rules/architecture-tracker.mdc` (`src/cli/commands/init.ts:117-126`)
- **User home-directory config**, via `installMcp`
  (`src/cli/commands/init.ts:132-139` → `src/cli/commands/install.ts:131-141`),
  reaching `~/Library/Application Support/Claude/claude_desktop_config.json`
  (`install.ts:32`), `~/.config/Claude/claude_desktop_config.json` (`:39`),
  `~/.cursor/mcp.json` (`:93`), `~/.codeium/mcp_config.json` (`:90`),
  `~/.cline/data/settings/cline_mcp_settings.json` (`:105`)
- Skills under `.opencode/`, `.claude/`, `.cursor/rules/`
  (`src/cli/commands/install-skill.ts:39-43`, `:105`)
- A git `post-commit` hook (`src/cli/commands/init.ts:156` →
  `src/cli/commands/hooks.ts:18-47`)

`README.md:39` claims *"arkive extends your existing instruction files — it never
overwrites them."* That is true of `injectArkiveBlock`
(`src/cli/commands/inject.ts:19-26` rewrites only between the markers), and
false of `install-skill.ts:155-160`, which **appends** to `AGENTS.md` without
markers — so repeated `install-skill` runs duplicate the block.

### A network-exposed write surface

`src/cli/commands/serve.ts:25` sets `Access-Control-Allow-Origin: *` and
`src/cli/commands/serve.ts:160` calls `server.listen(port)` with no host, which
binds `::`/`0.0.0.0`. On the same server: `GET /api/architecture` (`:101`),
`POST /api/prompts` (`:42`), `DELETE /api/prompts/:id` (`:57`),
`PUT /api/learning/progress` (`:87`), and `POST /api/shutdown` (`:132`). No
authentication on any of them. Anyone who can route to the port can enqueue
prompts that a connected agent will later claim and execute, read the project's
architecture document, or kill the server.

This is a security decision as much as an integrity one, and it is out of scope
here, but it is recorded because `POST /api/prompts` is an unauthenticated write
path into the agent's work queue. **It warrants its own ADR.**

## Decision

**Invariant: no path, schema, or configuration change may destroy user data
silently.** Four mechanisms.

### 1. Mandatory migration detection

Every entry point — `init`, `status`, `reconcile`, `serve`, `readArchitecture` —
runs a probe **before** anything else:

```
probe(<root>):
  current = <root>/arkive/architecture.json
  legacy  = <root>/architecture.json       # known historical locations
```

- **legacy exists, current does not** → hard stop. Print both paths and the
  legacy document's service and decision counts. Do not scaffold. Exit non-zero
  with: run `arkive migrate`.
- **both exist** → hard stop. Print both paths and a count diff. Do not
  scaffold, do not overwrite, do not pick. Require
  `arkive migrate --from <path>`.
- **neither exists** → normal fresh-init path.

**Never infer which document is newer.** `62066bc` produced a scaffold that is
*newer by mtime* than the real document it destroyed. mtime is not evidence.

`arkive migrate` is atomic: read the source, validate, write the new document,
read it back, verify counts, and only then remove the `.bak`. The original is
preserved as `architecture.json.bak` indefinitely until the user deletes it.

Every known historical location is registered as a `LEGACY_PATHS` entry with
the version range it served. Adding a path constant with no `LEGACY_PATHS`
entry fails the build.

### 2. Transactional writes

`src/io/architecture-file.ts:88-89` is a bare `writeFileSync`; a crash, a full
disk, or a concurrent reader sees a truncated document. Replaced with:

```
write <tmp in the same directory> → fsync → rename (atomic on POSIX and NTFS) → fsync(dir)
```

The rename is the commit point. A reader never sees a partial document and a
crash never destroys the previous one.

**Growth is bounded by construction:**

- `history[]` capped at 50 entries, with an explicit `historyTruncated: true`
  flag so truncation is visible rather than silent.
- Snapshots deduplicated by content hash, capped at 10 distinct states. The
  current full-copy-on-every-write behaviour
  (`src/io/architecture-file.ts:108-118`) is deleted.

The durable record is git. The JSON file is a working document, not an archive.

### 3. Unknown-key preservation

**Validate into a side channel; write the original object.** The Zod parse
exists to produce warnings, not to produce the document.

```
read:   parsed = JSON.parse(raw); result = ArchitectureSchema.safeParse(parsed)
        → store BOTH. warnings from `result`, document from `parsed`.
write:  patch known fields into `parsed`; serialise `parsed`, not `result.data`.
```

Every key arkive does not recognise round-trips byte-for-byte through an
arbitrary number of read/write cycles. This also fixes forward compatibility for
free: a v2 document read by a v1 arkive keeps its unknown v2 fields instead of
destroying them.

Two schema changes follow:

- `src/io/architecture-file.ts` never writes `validation.data` (`:63`, `:89`,
  `:169`).
- The `test` suite gains a round-trip assertion on a fixture containing unknown
  keys at every level of the document.

This is the single highest-leverage change in this ADR. It is one line of
discipline and it prevents an entire class of loss.

### 4. `--dry-run` and explicit consent

- `--dry-run` is supported by **every** command that touches the filesystem:
  `init`, `migrate`, `install`, `install-skill`, `hooks`, `export --output`.
  It prints the complete plan — every path, every diff — and writes nothing.
- `init` prints a plan and requires `--yes` to proceed. **The only file created
  without consent is `arkive/architecture.json` itself.** Writing `CLAUDE.md`,
  `AGENTS.md`, `.cursor/rules/`, `.git/hooks/`, or anything under `$HOME`
  requires explicit confirmation.
- Prompting happens before any write, not after. If stdin is not a TTY and
  `--yes` was not passed, `init` refuses and tells the user which flag to add.
  This makes CI and scripted installs deterministic rather than hanging.
- `README.md:39` is corrected: `install-skill` does append to `AGENTS.md`, and
  it is changed to use the same `<!-- arkive:start -->` markers as
  `injectArkiveBlock` (`src/cli/commands/inject.ts:4-5`) so repeated installs
  replace rather than duplicate.
- `installMcp` writing outside the project directory (`src/cli/commands/install.ts:32-105`)
  is always consent-gated, regardless of `--yes` for project files.

### 5. Single-writer on the prompt queue

`claimNextPrompt` (`src/io/prompt-queue.ts:121-140`) becomes
write-to-temp-and-rename with a compare-and-swap on the queue hash. A claim
fails cleanly if the queue changed between read and write. `README.md:362` and
`SKILL.md:166` become true rather than being deleted.

## Regression test strategy

The fixture is the incident. Both files from this repository, byte-for-byte, are
committed under `tests/fixtures/62066bc/`: the root `architecture.json` (7
services, 4 decisions, 3 dataFlows) and the `arkive/architecture.json` (3
services, 0 decisions, 0 dataFlows).

| # | Test | Assertion |
|---|---|---|
| A | `init` in a dir containing **only** the legacy file | does not scaffold; exits non-zero; names both paths; `arkive/architecture.json` absent afterwards |
| B | `init` in a dir containing **both** files | refuses; exits non-zero; prints a count diff; neither file modified (byte hash) |
| C | `arkive migrate` on the fixture | new document has 7 services, 4 decisions with every `alternatives[].whyNot` intact, 3 dataFlows, 4 history entries; validates; `.bak` is byte-identical to the original |
| D | **Loss guard** (property) | for every registered migration: the count of `decisions`, `services`, `connections`, `dataFlows`, and `history` before and after is **equal**, or the migration fails loudly. Asserted for every `migrate(vN)`. |
| E | **Unknown-key round-trip** | write a document with `x-custom` at document, service, connection, decision, and alternative level; read → write → read → write; assert byte-identical, including after a `update_architecture` call |
| F | **Torn write** | inject a failure between temp-write and rename; assert the original file is byte-intact and no partial file remains |
| G | **`--dry-run`** | snapshot a recursive hash of the whole tree, run `--dry-run` on a dirty repo, assert the hash is unchanged |
| H | **Consent** | `init` without `--yes` and without a TTY writes `arkive/architecture.json` and **nothing else** — no `CLAUDE.md`, no `AGENTS.md`, no `.cursor/`, no `.git/hooks`, no `$HOME` file |
| I | **Migration idempotence** (property) | `migrate(migrate(doc)) == migrate(doc)` for N random valid documents |
| J | **Prompt queue CAS** | two concurrent claims against a one-prompt queue: exactly one succeeds; the loser gets `success: false` |
| K | **History bound** | 200 sequential updates produce ≤ 50 history entries and `historyTruncated: true` |
| L | **Snapshot bound** | 200 distinct writes produce ≤ 10 snapshot files |

Tests D, E, and I are the ones that matter. D is the direct regression test for
`62066bc` — it asserts the invariant the incident violated, for every migration
that will ever exist, not just this one. E is the class the Zod strip opened.

**Every fixture-based test asserts on the absence of a file**, not only on the
content of a present one. `62066bc` did not corrupt anything; it wrote something
new and left the old thing alone. Only an assertion about what does *not* exist
catches that.

## Consequences

### Positive

- The product stops being the thing that destroys architectural memory. Without
  this, every other ADR in this set makes the tool worse: ADR-0001 introduces a
  breaking schema migration, which is precisely the class of change that caused
  `62066bc`.
- The unknown-key fix is small and removes an entire silent-destruction class.
- `README.md:39`, `:41`, `:362` become true.
- Bounded growth means the document is readable in full, which is what
  `architecture://session-context` assumed all along.
- `--dry-run` on `init` makes consent reviewable instead of a prompt the user
  reflexively accepts.

### Negative

- **`init` now requires a flag or a TTY.** Existing scripted setups break. This
  is a one-time cost and it is the correct trade.
- **`--dry-run` on every command doubles the CLI surface.** Every command with a
  write path needs the branch.
- **The migration fixture commits a stale document into the repo.** It is
  test data with a confusing name; it needs a README in its directory explaining
  that it is a preserved artifact of a real incident and must not be updated.
- **Writes are slower** — fsync plus rename on every write. Irrelevant at
  architecture-document scale; relevant if the write path is ever used in a
  loop.
- **`.bak` files never get cleaned up.** Deliberate; deleting a backup is worse
  than an extra file, and git ignores the pattern.
- **Writing to `$HOME` requires consent that some users will refuse**, which
  means MCP registration does not happen and the product is weaker for them.
  That is the correct outcome.

## Alternatives considered

**Emit a warning instead of failing.** Rejected. A warning at the exact moment
a user is running `init` is the moment they are least likely to read it, and the
scaffold is already written by the time a warning could be printed. The
`62066bc` document would have been overwritten anyway.

**Use mtime to pick the newer document automatically.** Rejected, and this one is
specifically refuted by the evidence: in this repository the *blank scaffold* is
newer than the *real document* it destroyed. Automatic selection would have
chosen wrong and then deleted the backup.

**Auto-migrate on read.** Rejected, and `docs/issues/0004` already reached this
conclusion: a read that rewrites the file loses data to a tool someone ran while
curious. Migration persists on write, never as a side effect of a read.

**Use `.passthrough()` / `z.looseObject()` on the schemas.** Rejected. It stops
the strip, but the read still returns a Zod-reconstructed object with defaulted
fields materialised into it, so a future schema default silently writes itself
into the user's document. Keeping `parsed` as the document and using Zod only
for diagnostics is both simpler and more honest.

**Keep full-document snapshots, just cap the count.** Rejected. A snapshot of
the whole document per write is the growth problem; capping it keeps the wrong
mechanism. Content-hash dedup with a 10-state cap is both smaller and more
useful — it stores genuine state transitions, not the same file 200 times.

**Make the prompt queue a lockfile or a SQLite database.** Rejected for now. The
compare-and-swap rename is atomic on the filesystem already, adds no dependency,
and keeps the queue as a file a human can read. Revisit if contention ever
matters.

**Scope this to `readArchitecture` only; leave `installMcp` alone.** Rejected.
Writing to `~/Library/Application Support/Claude/claude_desktop_config.json`
during `init` without asking is not a smaller version of the same problem, it is
the same problem in a directory the user cares more about.

## Related

- ADR-0001 — v2 is a breaking schema change and depends on this ADR landing
  first (`docs/issues/0013` blocks `0004`).
- ADR-0004 — deletes five permanently-failing viewer test files by deleting the
  viewer, which is the correct repair rather than materialising
  `src/viewer/node_modules`.
- ADR-0005 — hooks write to `.git/hooks` and agent settings; consent rules here
  apply to them.
- `docs/issues/0013`.