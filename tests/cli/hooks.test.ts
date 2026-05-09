import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installGitHooks, uninstallGitHooks } from "../../src/cli/commands/hooks.js";

describe("git hooks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arkive-hooks-"));
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    mkdirSync(join(dir, "arkive"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs post-commit hook in .git/hooks", () => {
    const result = installGitHooks(dir);
    expect(result.installed).toContain("post-commit");
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("arkive");
    expect(content).toContain("reconcile");
  });

  it("does not overwrite existing hook — appends arkive block", () => {
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'existing hook'\n");
    const result = installGitHooks(dir);
    expect(result.installed).toContain("post-commit");
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("existing hook");
    expect(content).toContain("arkive");
  });

  it("skips if arkive block already present", () => {
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\n# arkive:start\nnpx @ericjdz/arkive reconcile --quiet\n# arkive:end\n");
    const result = installGitHooks(dir);
    expect(result.skipped).toContain("post-commit");
  });

  it("does nothing if not a git repo", () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const result = installGitHooks(dir);
    expect(result.installed).toHaveLength(0);
    expect(result.error).toContain("not a git repository");
  });

  it("uninstalls arkive block from hook", () => {
    const hookPath = join(dir, ".git", "hooks", "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'keep'\n# arkive:start\nnpx @ericjdz/arkive reconcile --quiet\n# arkive:end\n");
    const result = uninstallGitHooks(dir);
    expect(result.removed).toContain("post-commit");
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("keep");
    expect(content).not.toContain("arkive");
  });
});
