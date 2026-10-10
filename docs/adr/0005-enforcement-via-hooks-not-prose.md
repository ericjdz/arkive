# ADR-0005: Enforcement via harness hooks, not markdown prose

## Status

Proposed

## Context

arkive's entire value proposition is enforcement, and it currently has none. The
agent is *asked* to maintain the document, and asking is not a mechanism.

### The rules are duplicated in six places and have already drifted

The three lifecycle rules — read on session start, re-read before a major change,
update after — appear in at least six places:

| # | Location | Content |
|---|---|---|
| 1 | `AGENTS.md:9-11` | three rules, no mention of `architecture://session-context` |
| 2 | `CLAUDE.md:9-11` | three rules, *"your memory across sessions, compaction, and model switches"* |
| 3 | `README.md:15, 187, 189` | session-start instruction + *"updates it after every major change"* |
| 4 | `skills/core/architecture-tracker/SKILL.md:22-24` and `:26-48` | three rules, plus a section headed *"Lifecycle Hooks (**NON-NEGOTIABLE**)"* with `### session_start` |
| 5 | `src/server/resources.ts:157-180` (`architecture://hooks`) | `## session_start`, `## post_major_change`, `## pre_completion` |
| 6 | `src/templates/arkive-block.md.hbs`, `CLAUDE.md.hbs`, `AGENTS.md.hbs` | three separate hand-maintained templates (`src/cli/commands/init.ts:88, 96, 104`) |

They have already contradicted each other. `SKILL.md:22` says *"read it
completely"*; `CLAUDE.md:9` and `README.md:191` say read
`architecture://session-context` instead because the full document *"dumps the
full document into context"*. Same step, opposite instructions, both
authoritative, no mechanism to detect the disagreement.

`SKILL.md:30` writes `### session_start` and `:34` writes *"This step is
NON-NEGOTIABLE."* These describe a conceptual lifecycle. **No `SessionStart` hook
exists. No `PreToolUse` guard exists. No `PreCompact` flush exists. No `Stop`
verification exists.** The word "hook" in a markdown heading is the rhetorical
tell for the absence of one.

### The only real hook has never run successfully

`src/cli/commands/hooks.ts:7-10` installs a `post-commit` block:

```sh
npx -y @ericjdz/arkive reconcile --quiet 2>/dev/null || true
```

`--quiet` is not an option. `src/cli/index.ts:73-79` registers `reconcile` with
exactly one option, `-d, --dir <path>`. Commander rejects the unknown flag, the
command exits non-zero, and `2>/dev/null || true` discards both the error and the
exit code. **This hook has never reconciled anything.** It also runs *after* the
commit, so it cannot gate anything, and `npx -y` fetches unpinned remote code on
every commit in every repo that installed it.

### The claim in the README is false

`README.md:41`: *"Your AI agent will now read and maintain
`arkive/architecture.json` automatically."* Nothing about `init`
(`src/cli/commands/init.ts:60-167`) installs anything that reads or writes the
document on the agent's behalf. It scaffolds the file, injects markdown
(`:106-114`), writes platform config (`:132-139`), copies skills (`:142-153`),
and installs the broken post-commit hook (`:156`). Automatic maintenance requires
agent compliance, and compliance is exactly what is missing.

## Decision

**Enforcement moves from prose into the harness. The harness delivers context;
the agent is never asked to retrieve it.**

### Principle

> Harness-delivered context requires zero agent compliance.

A rule delivered as markdown is executed only if the model chooses to. A rule
delivered by `SessionStart` is in the context window before the agent's first
token, which is not the same kind of thing and cannot be skipped by forgetting.
This is the whole thesis. Every design decision below follows from it.

### Hook substrate

| Hook | Fires | Action | Blocks? |
|---|---|---|---|
| `SessionStart` | session begins | Inject `architecture://session-context` output, bounded | no |
| `PreToolUse` | `Edit`/`Write`/`MultiEdit` on a source path | If the path resolves to a known module node, inject one line: the node's inbound edges and its most recent decisions | no |
| `PreCompact` | context about to be compacted | Flush any pending derived delta to the document, then inject the graph delta that occurred during the session | no |
| `Stop` | agent finishes a turn | Run derivation; if the graph is stale or a decision dangles, return a message with the specific gap | no |
| `pre-commit` | `git commit` | Fail on: document missing, unreadable, schema-invalid, or derived graph stale beyond tolerance | **yes** |

**`Stop` returns a message, it does not block.** A blocking `Stop` makes the
agent unable to end its turn, which produces loops and is hostile. It reports.

**`pre-commit` is the only blocking hook, and that is deliberate.** It is the one
point where the user can afford a hard failure — they are about to create a
commit they can inspect and discard. Every other hook is advisory, because every
other hook can fire in a context where a block would strand the agent.

### Hook contract

Every hook is a separate process:

- **stdin:** JSON on a single fd.
- **stdout:** JSON on a single fd, or nothing. Any diagnostic text goes to
  stderr. A hook that prints a stray line to stdout corrupts the agent's context.
- **exit 0:** allow. **exit non-zero:** block — used by `pre-commit` only.
- **Time budget: 200ms.** A hook that slows down every tool call is a hook the
  user removes. Derivation must be incremental and cached by mtime to fit.
- **Absent document: exit 0, silently.** No document means arkive is not
  installed here, and that is not an error worth showing anyone.
- **Never write during `SessionStart` or `PreToolUse`.** Reads only. Writes
  happen in `PreCompact`, `Stop`, and `pre-commit`, where the timing is
  deliberate and observable.

### `pre-commit` replaces `post-commit`

The existing hook is removed. `pre-commit` is the correct event: it can block,
and it runs before the commit so the document is current *in* the commit rather
than dirtying the tree after it. `src/cli/commands/hooks.ts` is rewritten
around it, and `--quiet` and `|| true` go away.

### Prose is generated, never hand-maintained

The three lifecycle rules currently live in three hand-maintained templates plus
three hand-maintained markdown files, and have drifted. Now:

- One source: `src/templates/lifecycle.md.hbs`.
- Rendered into `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and the
  `architecture-tracker` skill by a single code path, on every install.
- **Hand-editing the generated block is a merge conflict, not a customisation.**
  The block is delimited (`<!-- arkive:start -->` / `<!-- arkive:end -->`,
  `src/cli/commands/inject.ts:4-5`) and re-rendered on install, exactly as
  `injectArkiveBlock` already does (`src/cli/commands/inject.ts:7-26`).

The generated prose is reduced to a *pointer*, not a rule: "arkive delivers
context automatically; you record intent via `record_decision`." It no longer
tells the agent to read the file, because the harness already did.

`architecture://hooks` (`src/server/resources.ts:157-180`) is **deleted**. It is
a sixth copy of the rules, served as prose, opt-in (the agent must know to read
it in order to be told anything). If a harness has no hook substrate, there is
nothing to serve it to.

### Fallback when hooks are unavailable

Hook surfaces are platform-specific. Claude Code has `SessionStart`,
`PreToolUse`, `PreCompact`, `Stop`. Other agents have different or no
equivalents. **The fallback is MCP, which already exists** —
`skills/core/architecture-tracker/SKILL.md:11-18` already establishes MCP-first
as the primary path with file editing as fallback.

| Hook | Fallback | Degradation |
|---|---|---|
| `SessionStart` | read `architecture://session-context` on demand | **agent-complied** — the exact problem, minus the duplicate copies |
| `PreToolUse` | none | no equivalent exists; `check_drift` at Stop covers the same ground late |
| `PreCompact` | `arkive check` before ending | relies on the agent choosing to run it |
| `Stop` | `arkive check` after the turn | same |
| `pre-commit` | the git `pre-commit` hook — a git hook is not harness-specific and works everywhere | **full fidelity** |

This table is honest about what degrades. Three of the five degrade to
compliance and two degrade to nothing. **That is the point:** the fallback is
documented as degraded, and `README.md:41` stops claiming automatic maintenance
when only the MCP fallback is present. The README says which mechanism the user
actually has.

### Session context gets a real budget

`src/server/session-context.ts:31-53` pushes every service and every connection
before any budget is applied; `maxTokens` (default 2000, `:15`) is first
consulted at `:56`, and only decisions (`:58-68`) and history (`:70-78`) are
truncated to fit. A project with 200 services produces a `SessionStart` payload
several times over budget. Since this payload is now *injected automatically
into every session*, it must fit by construction: rank by graph centrality, cap
node count, and mark the truncation explicitly so the agent knows it is seeing a
summary rather than a complete list.

## Consequences

### Positive

- Session start requires zero agent behaviour. The context is present.
- The lifecycle rules exist in exactly one place and cannot drift from a
  hand-edited copy, because there are no hand-edited copies.
- `pre-commit` is the first mechanism in arkive's history that can actually
  prevent anything.
- The README claim at `README.md:41` becomes true — but only for users on a
  harness with hooks, and the README now says which users those are.
- The unpinned `npx -y` execution on every commit (`src/cli/commands/hooks.ts:9`)
  is gone.
- `PreCompact` targets the exact moment memory is lost, which no amount of
  markdown addressed.

### Negative

- **Hook support is uneven across agents.** Users on Cursor, Windsurf, Cline, or
  plain Codex get the MCP fallback only, which is compliance-based and therefore
  weak. The product is strongest exactly where the author's own harness is. This
  is a real limitation, not a solved problem, and it should be stated in the
  README rather than papered over.
- **Hook installation writes into the user's repo and agent config.**
  `.claude/settings.json`, `.git/hooks`, `CLAUDE.md`, `AGENTS.md`,
  `.cursor/rules/`. That requires consent — see ADR-0006.
- **`PreToolUse` on source paths adds latency to every edit.** 200ms budget,
  mtime-cached derivation, and the hook must fail open. A hook that fires on
  every `Edit` and is slow will be removed by the user within a day.
- **The harness is a dependency.** A substrate arkive does not control, with
  event names that can change. The hook contract must be version-tolerant and
  every hook must fail open.
- Deletes `architecture://hooks`, a documented MCP resource
  (`README.md:374`). Breaking change for anyone reading it.
- A blocking `pre-commit` is a change in behaviour users will hit at the worst
  moment — mid-workflow, wanting to commit. It must have `--no-verify` as an
  escape hatch and it must print exactly what is wrong, not just "blocked".

## Alternatives considered

**Keep markdown rules; make them better and add one source of truth.** Rejected.
This is what generated prose already achieves and it is not the problem. The
problem is that prose is *read* rather than *delivered*. Single-sourcing fixes
drift and leaves compliance untouched.

**Rely entirely on the MCP server; the agent reads resources when it chooses.**
Rejected as the only mechanism — that is the status quo, and it is the failure.
It survives only as the fallback, where its weakness is documented.

**Hook only `SessionStart`; rely on drift checks for the rest.** Rejected.
Session start is the highest-value hook, but `PreToolUse` is what closes the gap
between "read at start" and "update after a change" — the update is the half that
is never done. Without it, the document still goes stale within the first change.

**Make `Stop` blocking too.** Rejected. A `Stop` hook that returns non-zero
prevents the agent from ending its turn. Agents retry, loop, or abandon. An
advisory message at `Stop` achieves the same correction with none of the failure
modes.

**Write hooks that the agent must invoke as a tool.** Rejected. That is the
compliance model with extra steps. A hook is invoked by the harness; a tool is
invoked by the model.

**Detect hook availability and disable arkive when absent.** Rejected. Users
without hooks still get MCP, the file format, and export. Degrade, do not
refuse.

## Related

- ADR-0002 — hooks run derivation, which is what makes continuous
  reconciliation free.
- ADR-0006 — consent for writing instruction files and git hooks.
- `docs/issues/0011`, `0012`.