# 0013 — Data integrity

status: done
stream: integrity
blocks: 0004
blocked_by: 0001, 0002
adr: docs/adr/0006-data-integrity-is-a-product-feature.md

## Context

This is the most important issue in the tracker, and it exists because the
product already failed this exact way.

Commit `62066bc` — *"feat: move architecture.json path into arkive/ subdirectory"*
— changed the code path but not the data. A blank scaffold was created at
`arkive/architecture.json`; the real document (7 services, 4 decisions, 3
dataFlows) was orphaned at the root. Both files are in the repository today.
Four recorded architectural decisions — including "React 19 vs 18 dedup," a
genuine decision with a genuine rejected alternative — were destroyed silently.

This is the failure the product exists to prevent. It happened inside the
product, and it is why no one trusts the artifact.

## Scope

An invariant: **no path, schema, or configuration change may destroy user data
silently.**

1. **Migration detection.** On startup, detect a legacy document at any known
   prior path (`./architecture.json`, `./arkive/architecture.json`) and refuse
   to scaffold over an existing one. Refusing silently is the bug — surface a
   clear message naming both paths and telling the user what to do.
2. **Atomic writes.** Every write is temp-file → `fsync` → `rename`. Today
   `src/io/architecture-file.ts:89` and `src/io/prompt-queue.ts:76` use bare
   `writeFileSync`; a crash mid-write leaves truncated JSON that the agent
   cannot self-heal.
3. **Write serialisation.** Three writers exist by design (HTTP viewer
   `serve.ts:42-76`, MCP stdio `tools.ts:408-420`, CLI). `claimNextPrompt`
   (`prompt-queue.ts:121-140`) is a bare read-modify-write with no lock. Either
   lock it, or stop calling it "atomically" in `README.md:362`, `tools.ts:125`,
   and `architecture-tracker/SKILL.md:166` — currently it is both broken and
   falsely advertised.
4. **Unknown-key preservation.** Specified in 0003; implement here.
5. **`--dry-run` on anything that touches the user's repo.** `init` currently
   writes to `arkive/`, `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`, a platform
   MCP config, seven skill directories, and `.git/hooks/post-commit` — with no
   preview and no single consent gate.
6. **Consent for hooks.** `src/cli/commands/init.ts:156` calls
   `installGitHooks()` unconditionally, despite `README.md:160` claiming it is
   optional. MCP and skills have `--skip-mcp` / `--skip-skills`; hooks have
   nothing. Add `--skip-hooks` and stop installing by default.
7. **Snapshot bounding.** `saveSnapshot` (`architecture-file.ts:112-117`) names
   files with `lastUpdated` where only `:` is replaced, leaving `.` intact, so
   two writes in the same millisecond collide. Nothing prunes. `arkive/history/`
   is not gitignored while `architecture.json` is tracked — so every write
   commits a fresh full-document snapshot forever.

## Regression tests

Build the suite around the `62066bc` incident specifically. This is the part
that must not be skipped.

- [ ] Fixture reproducing the incident: a populated legacy `./architecture.json`
      plus a blank `./arkive/architecture.json`. Running any arkive command
      must not lose the legacy decisions, and must report where they went.
- [ ] Concurrent-claim test: two processes racing `claimNextPrompt` against the
      same prompt. Exactly one wins.
- [ ] Interruption test: kill the process mid-write. The next read must find a
      valid document, not truncated JSON.
- [ ] Round-trip test: arbitrary user-added keys at every container level
      survive a full read → merge → write cycle.
- [ ] `init --dry-run` writes nothing, anywhere.
- [ ] `init` installs no git hook unless asked.

## Acceptance criteria

- [ ] All six regression tests above exist and pass.
- [ ] Every README claim about atomicity, optionality, and overwrite-safety is
      either true or corrected. `README.md:24` advertises a `curl | bash`
      installer that runs `npx -y arkive init` (`scripts/install.sh:85`) — a
      *different npm package* than `@ericjdz/arkive`. Fix it.
- [ ] `npm run lint` and `npm test` pass.

## Note

Do not ship a repair release for this on its own — per the maintainer, there
are no real users on 0.2.1 to strand. But every schema change from 0003 onward
reintroduces this risk, which is why it blocks 0004.