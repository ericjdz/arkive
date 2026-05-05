---
name: setup
description: Initialize architecture tracking in a project. Run this once per project.
---

# Setup — Architecture Learning Tool

## When to Use

Run this skill when starting a new project or adding architecture tracking to an existing one.

## What It Does

1. Creates `architecture.json` — the living architecture document
2. Creates `CLAUDE.md` — instructions for Claude Code
3. Creates `AGENTS.md` — instructions for Codex/OpenCode/Copilot
4. Creates `.cursor/rules/architecture-tracker.mdc` — Cursor auto-apply rule

## Steps

1. Run the CLI: `npx archlearn init --name <project-name>`
2. If the project already has code, scan the existing codebase and populate `architecture.json`:
   - Check `package.json` for dependencies → populate `stack`
   - Check folder structure for services → populate `services`
   - Check config files (Docker, nginx, etc.) → populate `infrastructure`
3. Commit the generated files

## After Setup

The `architecture-tracker` skill will activate automatically. From now on, read `architecture.json` before major changes and update it after.
