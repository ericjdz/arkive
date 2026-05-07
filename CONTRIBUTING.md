# Contributing to arkive

Thanks for your interest. This document covers how to set up, test, and submit changes.

## Development Setup

```bash
git clone https://github.com/arkive/arkive.git
cd arkive
npm install
npm test
npm run build
```

Requires Node.js 18+.

## Project Layout

- `src/cli/` — CLI entry point and commands (Plan 1 + Plan 2)
- `src/schema/` — Zod schema for `arkive/architecture.json` (Plan 1)
- `src/templates/` — Handlebars templates rendered by `init` (Plan 1)
- `src/server/` — MCP server (Plan 2)
- `src/manifests/` — schema validators for distribution manifests (Plan 5)
- `viewer/` — React + Vite web viewer (Plan 3)
- `skills/` — `SKILL.md` files for AI agents (Plans 1, 4)
- `.claude-plugin/` — Claude Code marketplace manifests (Plan 5)
- `scripts/` — build, install, and prepublish scripts (Plan 5)
- `tests/` — Vitest tests, mirroring `src/` layout

## Workflow

1. Open an issue describing the change before opening a PR for non-trivial work.
2. Write failing tests first.
3. Implement the minimal change to make them pass.
4. Run `npm run lint && npm test && npm run build` before pushing.
5. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `build:`).

## Testing

```bash
npm test                 # full suite
npm run test:watch       # watch mode
npx vitest run tests/cli # one folder
```

Every new feature ships with tests. Manifests, scripts, and templates are tested too — see `tests/manifests/`, `tests/install/`, `tests/standalone/`.

## Releasing

Releases are gated by `prepublishOnly`, which runs lint, tests, build, and `scripts/prepublish.ts` validation. Maintainers run:

```bash
npm version <patch|minor|major>
npm publish
git push --follow-tags
```

## Code of Conduct

Be kind. Assume good faith. Critique ideas, not people.
