import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ARKIVE_BLOCK_START = "# arkive:start";
const ARKIVE_BLOCK_END = "# arkive:end";

const POST_COMMIT_BLOCK = `${ARKIVE_BLOCK_START}
# Auto-reconcile architecture on commit
npx -y @ericjdz/arkive reconcile --quiet 2>/dev/null || true
${ARKIVE_BLOCK_END}`;

export interface HookResult {
  installed: string[];
  skipped: string[];
  error?: string;
}

export function installGitHooks(dir: string): HookResult {
  const gitDir = join(dir, ".git");
  if (!existsSync(gitDir)) {
    return { installed: [], skipped: [], error: "not a git repository" };
  }

  const hooksDir = join(gitDir, "hooks");
  const result: HookResult = { installed: [], skipped: [] };
  const hookPath = join(hooksDir, "post-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes(ARKIVE_BLOCK_START)) {
      result.skipped.push("post-commit");
      return result;
    }
    writeFileSync(hookPath, existing.trimEnd() + "\n\n" + POST_COMMIT_BLOCK + "\n");
  } else {
    writeFileSync(hookPath, "#!/bin/sh\n\n" + POST_COMMIT_BLOCK + "\n");
  }

  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Windows does not reliably support chmod on git hooks.
  }

  result.installed.push("post-commit");
  return result;
}

export function uninstallGitHooks(dir: string): { removed: string[]; error?: string } {
  const gitDir = join(dir, ".git");
  if (!existsSync(gitDir)) {
    return { removed: [], error: "not a git repository" };
  }

  const hookPath = join(gitDir, "hooks", "post-commit");
  if (!existsSync(hookPath)) return { removed: [] };

  const content = readFileSync(hookPath, "utf-8");
  if (!content.includes(ARKIVE_BLOCK_START)) return { removed: [] };

  const cleaned = content
    .replace(new RegExp(`\n?${ARKIVE_BLOCK_START}[\\s\\S]*?${ARKIVE_BLOCK_END}\n?`), "\n")
    .trim();

  if (cleaned === "#!/bin/sh" || cleaned === "") {
    unlinkSync(hookPath);
  } else {
    writeFileSync(hookPath, cleaned + "\n");
  }

  return { removed: ["post-commit"] };
}
