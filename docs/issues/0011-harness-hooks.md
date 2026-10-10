# 0011 — Harness hook substrate

status: open
stream: enforce
blocks: 0009
blocked_by: 0004
adr: docs/adr/0005-enforcement-via-hooks-not-prose.md

## Context

arkive's entire value proposition is *enforcement*, and it currently has none.

The three lifecycle rules — read on session start, update before a major
change, update after — appear in at least five hand-maintained files that have
already drifted apart:

- root `CLAUDE.md:9-11` and root `AGENTS.md` rules §1-3
- `src/templates/arkive-block.md.hbs`, `CLAUDE.md.hbs`, `AGENTS.md.hbs` (three
  separate hand-maintained templates, not generated from one source)
- `skills/core/architecture-tracker/SKILL.md:26-48`, headed *"Lifecycle Hooks
  (**NON-NEGOTIABLE**)"*

The word "hook" in `SKILL.md:30` (`### session_start`) describes a conceptual
lifecycle, not an implemented one. There is no `SessionStart` hook, no
`PreToolUse` guard, no `Stop` hook, no `PreCompact` flush. The only real hook
is the git `post-commit`, which passes `reconcile --quiet` — an option that
does not exist — and swallows the error with `2>/dev/null || true`. It has
never done anything.

The product is *asked* to remember. The harness should hand the agent what it
needs instead.

## Scope

1. **Hook contract.** `src/hooks/` with a platform-agnostic contract: each hook
   reads stdin JSON, writes stdout, exits with a documented code. Platforms
   adapt to it. One contract, N adapters.
2. **Claude Code adapter** — `.claude/settings.json`:
   - `SessionStart` → emit `architecture://session-context` as a system
     reminder. Zero agent compliance required.
   - `PreToolUse` (matcher `Edit|Write`) → when the target path is a source
     path per `arkive.config.json`, surface a non-blocking nudge that the
     architecture may need updating.
   - `PreCompact` → flush pending architecture state before context loss.
   - `Stop` → verify the document is current; exit non-zero to block
     completion on critical drift.
   - `pre-commit` git hook → the only true gate. Fail the commit on `critical`
     drift. This replaces `post-commit`, which can never block anything.
3. **Failure is silent and safe.** If hooks are unavailable — wrong platform,
   old harness, MCP disabled — the product must still work through the
   file-based fallback. Hooks are an accelerant, never a dependency. A user who
   cannot install hooks is not a broken user.
4. **Un-gitignore `docs/`.** Already handled in 0001. Planning documents were
   lost to a `.gitignore` entry; do not repeat it for any decision artifact.
5. **Pin and scope.** The old hook ran unpinned `npx -y @ericjdz/arkive` on
   every commit — remote code execution on every commit, for a documentation
   tool. Call the locally installed binary and pin the version.

## Out of scope

GitHub Actions (0001). The viewer's own lifecycle.

## Acceptance criteria

- [ ] With hooks installed, a fresh session receives architecture context
      without the agent asking for it. Demonstrable in a transcript.
- [ ] A critical-drift commit is blocked by `pre-commit` and released by
      fixing the drift. Demonstrable.
- [ ] Disabling all hooks leaves the product fully functional via files and MCP.
- [ ] No hook executes unpinned remote code.
- [ ] `npm run lint` and `npm test` pass.

## Note

This is the moat. Vendors ship generic hooks; they will not ship
architecture-aware ones, because the value is in knowing that *these* modules
depend on *that* datastore under *this* decision. Generic hooks cannot know the
project.