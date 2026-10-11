import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installClaudeHooks,
  installGitHooks,
  managedHookPaths,
  resolveGitDir,
  uninstallClaudeHooks,
  uninstallGitHooks,
} from "../../src/cli/commands/hooks.js";
import { HOOK_BUDGET_MS, FILE_EDIT_MATCHER } from "../../src/hooks/index.js";
import type { ClaudeHookGroupLike } from "../../src/hooks/settings.js";
import { makeProject, removeProject } from "./fixtures.js";

/**
 * Installation.
 *
 * Two properties matter more than anything else here, because both are ways of
 * destroying something a user owns:
 *
 * 1. **Never replace.** `.claude/settings.json` and `.git/hooks/pre-commit`
 *    routinely contain somebody else's configuration.
 * 2. **Never fetch.** The hook this replaces ran `npx -y @ericjdz/arkive` on
 *    every commit — unpinned remote code execution, on every commit, for a
 *    documentation tool.
 */

describe("the pre-commit hook is a gate, not a post-hoc note", () => {
  it("installs pre-commit and never post-commit", () => {
    const dir = makeProject();
    try {
      const result = installGitHooks(dir);
      expect(result.installed).toEqual(["pre-commit"]);
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(true);
      expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("executes no unpinned remote code", () => {
    const dir = makeProject();
    try {
      installGitHooks(dir);
      const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      expect(content).not.toMatch(/npx\s+-y/);
      expect(content).not.toMatch(/curl|wget/);
      expect(content).not.toMatch(/npm install/);
    } finally {
      removeProject(dir);
    }
  });

  it("no longer swallows its own failures", () => {
    // The old line was `... 2>/dev/null || true`: a command that exited non-zero
    // on every commit, with the failure and the exit code both discarded. There
    // is no `|| true` and no `/dev/null` here because there is nothing to hide:
    // stderr is where the block message goes.
    const dir = makeProject();
    try {
      installGitHooks(dir);
      const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      expect(content).not.toContain("|| true");
      expect(content).not.toContain("2>/dev/null");
    } finally {
      removeProject(dir);
    }
  });

  it("carries every documented escape hatch", () => {
    const dir = makeProject();
    try {
      installGitHooks(dir);
      const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      expect(content).toContain("git commit --no-verify");
      expect(content).toContain("arkive hooks --remove");
      expect(content).toContain("ARKIVE_HOOK_DISABLE");
    } finally {
      removeProject(dir);
    }
  });

  it("exits 0 quietly when the binary is not on PATH", () => {
    // Otherwise every commit in a checkout whose arkive has been uninstalled
    // prints `command not found`, and a hook that is noisy when it cannot run is
    // a hook that gets deleted — and a deleted hook enforces nothing.
    const dir = makeProject();
    try {
      installGitHooks(dir, { command: "arkive-definitely-not-installed" });
      const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      expect(content).toContain("command -v arkive-definitely-not-installed >/dev/null 2>&1");
      expect(content).toContain("exit 0");
    } finally {
      removeProject(dir);
    }
  });

  it("honours ARKIVE_HOOK_DISABLE before doing anything else", () => {
    const dir = makeProject();
    try {
      installGitHooks(dir);
      const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      const guard = content.indexOf('if [ -n "${ARKIVE_HOOK_DISABLE:-}" ]');
      const call = content.lastIndexOf("hooks run pre-commit");
      expect(guard).toBeGreaterThan(-1);
      expect(call).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(call);
    } finally {
      removeProject(dir);
    }
  });
});

describe("installing the git hook is idempotent and non-destructive", () => {
  it("does not duplicate the block when run twice", () => {
    const dir = makeProject();
    try {
      installGitHooks(dir);
      const first = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
      const second = installGitHooks(dir);
      expect(second.skipped).toEqual(["pre-commit"]);
      expect(readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8")).toBe(first);
    } finally {
      removeProject(dir);
    }
  });

  it("keeps somebody else's hook in the same file", () => {
    const dir = makeProject();
    try {
      const hookPath = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(hookPath, "#!/bin/sh\nnpm run lint\n");
      installGitHooks(dir);
      const content = readFileSync(hookPath, "utf-8");
      expect(content).toContain("npm run lint");
      expect(content).toContain("arkive:start");
    } finally {
      removeProject(dir);
    }
  });

  it("keeps somebody else's hook on uninstall, and removes only its own", () => {
    const dir = makeProject();
    try {
      const hookPath = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(hookPath, "#!/bin/sh\nnpm run lint\n");
      installGitHooks(dir);
      const result = uninstallGitHooks(dir);
      expect(result.removed).toEqual(["pre-commit"]);
      const content = readFileSync(hookPath, "utf-8");
      expect(content).toContain("npm run lint");
      expect(content).not.toContain("arkive");
    } finally {
      removeProject(dir);
    }
  });

  it("deletes the file when the block was all that was in it", () => {
    const dir = makeProject();
    try {
      installGitHooks(dir);
      uninstallGitHooks(dir);
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("upgrades an old block in place rather than appending a second one", () => {
    const dir = makeProject();
    try {
      const hookPath = join(dir, ".git", "hooks", "pre-commit");
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      writeFileSync(
        hookPath,
        "#!/bin/sh\n\n# arkive:start\nnpx -y @ericjdz/arkive reconcile --quiet 2>/dev/null || true\n# arkive:end\n"
      );
      installGitHooks(dir);
      const content = readFileSync(hookPath, "utf-8");
      expect(content.match(/# arkive:start/g)).toHaveLength(1);
      expect(content).not.toContain("npx -y");
      expect(content).not.toContain("reconcile --quiet");
    } finally {
      removeProject(dir);
    }
  });

  it("refuses to install outside a repository, and says why", () => {
    const dir = makeProject({ gitRepo: false });
    try {
      const result = installGitHooks(dir);
      expect(result.installed).toHaveLength(0);
      expect(result.error).toContain("not a git repository");
    } finally {
      removeProject(dir);
    }
  });

  it("follows the .git pointer file a worktree uses", () => {
    // In a worktree or a submodule `.git` is a *file* containing `gitdir:`.
    // Reading it is the difference between `arkive hooks` working there and
    // failing with ENOTDIR.
    const dir = makeProject({ gitRepo: false });
    const elsewhere = mkdtempSync(join(tmpdir(), "arkive-gitdir-"));
    try {
      const realGitDir = join(elsewhere, "worktrees", "wt");
      mkdirSync(join(realGitDir, "hooks"), { recursive: true });
      writeFileSync(join(dir, ".git"), `gitdir: ${realGitDir}\n`);
      expect(resolveGitDir(dir)).toBe(realGitDir);
      expect(installGitHooks(dir).installed).toEqual(["pre-commit"]);
      expect(existsSync(join(realGitDir, "hooks", "pre-commit"))).toBe(true);
    } finally {
      removeProject(dir);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("writes nothing in dry-run mode", () => {
    const dir = makeProject();
    try {
      const result = installGitHooks(dir, { dryRun: true });
      expect(result.installed).toEqual(["pre-commit"]);
      expect(result.written).toHaveLength(1);
      expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });
});

describe("the Claude Code settings merge, never replace", () => {
  it("wires all four advisory events", () => {
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      expect(Object.keys(settings.hooks).sort()).toEqual([
        "PreCompact",
        "PreToolUse",
        "SessionStart",
        "Stop",
      ]);
    } finally {
      removeProject(dir);
    }
  });

  it("does not wire pre-commit into .claude/settings.json", () => {
    // There is no Claude Code `PreCommit` event. The gate is a git hook, and
    // pretending otherwise would produce a config that looks complete and gates
    // nothing.
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const raw = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
      expect(raw).not.toContain("PreCommit");
    } finally {
      removeProject(dir);
    }
  });

  it("narrows PreToolUse to the file tools", () => {
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      expect(settings.hooks.PreToolUse[0].matcher).toBe(FILE_EDIT_MATCHER);
    } finally {
      removeProject(dir);
    }
  });

  it("sets onFailure to continue so a broken hook cannot block the agent", () => {
    // The default, stated explicitly so changing it is a visible decision rather
    // than an inherited default nobody read.
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      const handlers = (Object.values(settings.hooks) as ClaudeHookGroupLike[][])
        .flat()
        .flatMap((group) => group.hooks ?? []);
      expect(handlers.length).toBe(4);
      for (const handler of handlers) expect(handler.onFailure).toBe("continue");
    } finally {
      removeProject(dir);
    }
  });

  it("preserves every other key and every other hook", () => {
    const dir = makeProject();
    try {
      const path = join(dir, ".claude", "settings.json");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            model: "opus",
            permissions: { allow: ["Bash(ls:*)"] },
            hooks: {
              PreToolUse: [
                { matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] },
              ],
            },
          },
          null,
          2
        )
      );
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(path, "utf-8"));
      expect(settings.model).toBe("opus");
      expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
      const bashGroup = settings.hooks.PreToolUse.find((g: { matcher?: string }) => g.matcher === "Bash");
      expect(bashGroup.hooks[0].command).toBe("./lint.sh");
    } finally {
      removeProject(dir);
    }
  });

  it("is idempotent", () => {
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const first = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
      const second = installClaudeHooks(dir);
      expect(second.skipped).toEqual(["claude-code"]);
      expect(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")).toBe(first);
    } finally {
      removeProject(dir);
    }
  });

  it("removes only its own entries on uninstall", () => {
    const dir = makeProject();
    try {
      const path = join(dir, ".claude", "settings.json");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }] } }, null, 2)
      );
      installClaudeHooks(dir);
      const removed = uninstallClaudeHooks(dir);
      expect(removed.removed).toEqual(["claude-code"]);
      const settings = JSON.parse(readFileSync(path, "utf-8"));
      expect(settings.model).toBe("opus");
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("./lint.sh");
      expect(settings.arkiveHooks).toBeUndefined();
    } finally {
      removeProject(dir);
    }
  });

  it("refuses to overwrite a settings file it cannot parse", () => {
    // Returning `{}` on a parse failure would silently destroy whatever was in
    // there. Refusing is the whole point.
    const dir = makeProject();
    try {
      const path = join(dir, ".claude", "settings.json");
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(path, "{ broken", "utf-8");
      const result = installClaudeHooks(dir);
      expect(result.installed).toHaveLength(0);
      expect(result.error).toContain("not valid JSON");
      expect(readFileSync(path, "utf-8")).toBe("{ broken");
    } finally {
      removeProject(dir);
    }
  });

  it("writes nothing in dry-run mode", () => {
    const dir = makeProject();
    try {
      const result = installClaudeHooks(dir, { dryRun: true });
      expect(result.installed).toEqual(["claude-code"]);
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("runs no unpinned remote code", () => {
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const raw = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
      expect(raw).not.toMatch(/npx\s+-y/);
      expect(raw).not.toMatch(/curl|wget/);
    } finally {
      removeProject(dir);
    }
  });

  it("records which build wrote the file, so a stale config is visible", () => {
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      expect(settings.arkiveHooks.writtenBy).toContain("arkive hooks");
      expect(settings.arkiveHooks.schema).toBe(1);
    } finally {
      removeProject(dir);
    }
  });
});

describe("what `arkive hooks --dry-run` promises", () => {
  it("is exactly the set of paths it manages", () => {
    const dir = makeProject();
    try {
      const paths = managedHookPaths(dir);
      expect(paths).toContain(join(dir, ".git", "hooks", "pre-commit"));
      expect(paths).toContain(join(dir, ".claude", "settings.json"));
      // Not the hook that was deleted.
      expect(paths.some((p) => p.includes("post-commit"))).toBe(false);
    } finally {
      removeProject(dir);
    }
  });

  it("keeps both hook surfaces inside the latency budget they claim", () => {
    // The budget is bought with design, not with a timeout: the per-edit hook
    // reads one file and returns, and the settings file says so.
    expect(HOOK_BUDGET_MS).toBe(200);
    const dir = makeProject();
    try {
      installClaudeHooks(dir);
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
      expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThan(HOOK_BUDGET_MS / 1000);
      expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBeGreaterThan(HOOK_BUDGET_MS / 1000);
    } finally {
      removeProject(dir);
    }
  });
});
