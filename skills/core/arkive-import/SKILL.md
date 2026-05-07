---
name: arkive-import
description: Convert an existing project into arkive by analyzing git history or filesystem dates. Builds a phased, history-rich arkive/architecture.json.
trigger: User says "import project", "convert project to arkive", "analyze project history", or invokes /arkive-import.
---

# /arkive-import — Import Existing Project

## When to Use

Run this to populate `arkive/architecture.json` from an existing codebase. This skill reconstructs the project's architectural history by analyzing when files were introduced and what they represent.

## Precondition

`arkive/architecture.json` must exist. If it doesn't, run `/arkive-init` first.

## Flow

### Phase 1: Collection

#### 1. Detect source type

```bash
# Check for git
test -d .git && echo "git" || echo "filesystem"
```

- If `.git/` exists → **git mode** (primary, reliable)
- Else → **filesystem mode** (fallback, dates approximate)

#### 2. Collect source files

Traverse the project and collect all source files. Exclude:
- `node_modules/`, `dist/`, `build/`, `.git/`, `.next/`, `__pycache__/`, `vendor/`
- Lock files: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Gemfile.lock`, `poetry.lock`
- Binary files, images, fonts
- `.env`, `.env.*` (secrets)

Include:
- `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,rb,php,css,scss,html,vue,svelte}`
- Config files: `*.json` (not lockfiles), `*.yaml`, `*.yml`, `*.toml`, `*.ini`
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/*.yml`
- `Makefile`, `CMakeLists.txt`

#### 3. Get creation dates

**Git mode:**
```bash
# For each file, get the commit that first added it
git log --diff-filter=A --follow --format='%H %aI %s' -- <file>
```
Use the LAST line of output (earliest commit). Use author date (`%aI`), not committer date.

**Filesystem mode:**
Use `fs.stat(file).birthtime`. Fall back to `mtime` if `birthtime` is unavailable or equals epoch.

#### 4. Sort all files chronologically by creation date.

### Phase 2: Clustering into Phases

#### 5. Group files into phases

**Git mode:**
- Files introduced in the same commit form an atomic group.
- Commits within 24 hours of each other, touching related directories, merge into a single phase.
- Label each phase from the commit message(s).

**Filesystem mode:**
- Files created on the same day (calendar date) form a group.
- Label each phase by directory + date (e.g., "src/api — 2025-03-15").
- Note: filesystem dates may be unreliable. Add disclaimer to history entries: "Imported from filesystem — dates approximate."

#### 6. Present phase summary to user

Before processing, show the user what was found:

```
Found N phases spanning M months:

Phase 1 (2025-01-10): "Initial commit" — 12 files
  src/index.ts, src/app.ts, package.json, tsconfig.json, ...
Phase 2 (2025-01-12): "Add database models" — 5 files
  src/models/user.ts, src/models/post.ts, ...
Phase 3 (2025-01-15): "Authentication system" — 8 files
  src/auth/login.ts, src/auth/middleware.ts, ...
...

This will process each phase sequentially. Estimated iterations: N.
Large projects may consume significant tokens.
Proceed? [Y/n]
```

Wait for user confirmation before proceeding.

### Phase 3: Sequential Processing

#### 7. Process each phase in chronological order

For EACH phase:

1. **Read all files introduced in that phase.**
2. **Identify architectural elements:**
   - New services (frontend, backend, database, etc.)
   - New connections between services
   - Stack additions (languages, frameworks, databases, infrastructure)
   - Architectural decisions evident from the code
3. **Update arkive/architecture.json:**
   - Call `update_architecture` (MCP) or edit directly with discovered services, connections, stack entries.
   - Use the phase's ORIGINAL timestamp, not the current time.
4. **Record decisions:**
   - Call `record_decision` for choices evident in the code.
   - Example: `express` in package.json → Decision: "Express.js for HTTP server", rationale from package.json context, alternatives: ["Fastify", "Koa"]
   - If rationale is unknown: `"Pre-existing choice — rationale not documented"`
   - If alternatives weren't evaluated: `[{ name: "Not evaluated", whyNot: "No evidence of alternatives considered" }]`
5. **Report progress:**
   ```
   Phase 3/18 complete: "Authentication system"
   — Added 2 services: auth-service, session-store
   — Added 1 connection: auth-service -> session-store (TCP/Redis)
   — Recorded 1 decision: JWT for session tokens
   ```

#### 8. Finalize

After all phases:
1. Call `check_drift` to verify consistency.
2. Report final summary:
   ```
   Import complete.
   — 18 phases processed
   — 12 services, 8 connections, 5 decisions recorded
   — History spans 2025-01-10 to 2025-06-30
   — Drift check: 0 issues
   ```

### Resumption

If the session is interrupted mid-import:
- On re-invocation, read the `history` array in `arkive/architecture.json`.
- Find the last entry with action `"import_phase"`.
- Resume from the next unprocessed phase.
- Do NOT reprocess completed phases.

## STRICT RULES — DO NOT VIOLATE

1. You MUST process phases in strict chronological order. Do NOT skip, reorder, or batch phases.
2. Each phase MUST produce at least one `history` entry with the ORIGINAL timestamp from git/filesystem — NOT the current time.
3. Do NOT hallucinate architectural decisions. Only record choices that are EVIDENT from the code:
   - Package in `package.json` or equivalent → record as a stack/framework decision.
   - Config file (Docker, nginx, CI) → record as infrastructure decision.
   - Multiple options available but one chosen → record with alternatives.
4. If you cannot determine the rationale for a choice, use:
   - rationale: `"Pre-existing choice — rationale not documented"`
   - alternatives: `[{ name: "Not evaluated", whyNot: "No evidence of alternatives considered" }]`
5. Do NOT summarize multiple phases into one. Each phase is a discrete unit of work.
6. History entries for import phases MUST use action `"import_phase"` and include the phase number in the summary.
7. After completing all phases, you MUST call `check_drift` and report any inconsistencies.

## MUST NOT

- Do NOT start processing without user confirmation of the phase summary
- Do NOT use current timestamps for historical phases
- Do NOT invent services, connections, or decisions not evident in the code
- Do NOT skip phases or process them out of order
- Do NOT reprocess phases that are already in the history
