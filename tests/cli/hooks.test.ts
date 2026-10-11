import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installGitHooks, uninstallGitHooks } from "../../src/cli/commands/hooks.js";

/**
 * The git hook surface.
 *
 * **This file previously asserted the opposite of what it asserts now**, and the
 * change is the point. It used to require `post-commit` running
 * `npx -y @ericjdz/arkive reconcile --quiet 2>/dev/null || true` — a hook that
 * fired after the commit so it could never gate anything, passed a flag the CLI
 * did not declare so Commander rejected it, piped that failure into `/dev/null`
 * with `|| true` so nothing could ever surface, and fetched unpinned remote code
 * on every commit in every repository that installed it. It had never done
 * anything, and every assertion below would have passed forever.
 *
 * ADR-0005 deletes it. `pre-commit` can block, reports in prose, and exits
 * non-zero for exactly one reason. These assertions are stronger than the ones
 * they replaced, not weaker: each old one checked that a string appeared, and
 * each new one checks that the dangerous string does *not* appear, that the
 * correct one does, and that the escape hatches are documented.
 */

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

  it("installs the pre-commit gate in .git/hooks", () => {
    const result = installGitHooks(dir);
    expect(result.installed).toContain("pre-commit");
    expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(true);
    const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).toContain("arkive");
    expect(content).toContain("hooks run pre-commit");
  });

  it("does not install the post-commit hook it replaced", () => {
    installGitHooks(dir);
    expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("executes no unpinned remote code on commit", () => {
    // `npx -y @ericjdz/arkive` fetched the latest published package and ran it,
    // on every commit, in every repository that installed the hook. For a
    // documentation tool.
    installGitHooks(dir);
    const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).not.toMatch(/npx\s+-y/);
    expect(content).not.toMatch(/curl|wget|npm install/);
  });

  it("cannot swallow its own failure", () => {
    // `2>/dev/null || true` discarded both the error text and the exit code, so
    // the hook had no way to act in either direction.
    installGitHooks(dir);
    const content = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).not.toContain("|| true");
    expect(content).not.toContain("2>/dev/null");
  });

  it("does not overwrite existing hook — appends arkive block", () => {
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'existing hook'\n");
    const result = installGitHooks(dir);
    expect(result.installed).toContain("pre-commit");
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("existing hook");
    expect(content).toContain("arkive");
  });

  it("skips if arkive block already present", () => {
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    installGitHooks(dir);
    const result = installGitHooks(dir);
    expect(result.skipped).toContain("pre-commit");
  });

  it("does nothing if not a git repo", () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const result = installGitHooks(dir);
    expect(result.installed).toHaveLength(0);
    expect(result.error).toContain("not a git repository");
  });

  it("uninstalls arkive block from hook", () => {
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'keep'\n# arkive:start\narkive hooks run pre-commit\n# arkive:end\n");
    const result = uninstallGitHooks(dir);
    expect(result.removed).toContain("pre-commit");
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("keep");
    expect(content).not.toContain("arkive");
  });
});
