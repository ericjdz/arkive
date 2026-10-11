import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../../io/atomic-write.js";
import { PACKAGE_VERSION } from "../../version.js";
import { buildMatcherGroups } from "../../hooks/adapters/claude-code.js";
import {
  DEFAULT_HOOK_COMMAND,
  buildArkiveEntries,
  hasArkiveSettings,
  mergeClaudeSettings,
  parseClaudeSettings,
  removeArkiveSettings,
  serializeClaudeSettings,
} from "../../hooks/settings.js";

/**
 * Installation of the two hook surfaces.
 *
 * | Surface | What it is | Blocks? |
 * |---|---|---|
 * | `.git/hooks/pre-commit` | a git hook — every harness, every editor, every `git` invocation | **yes** |
 * | `.claude/settings.json` | a Claude Code project hook — session start, edits, compaction, stop | no |
 *
 * ## What was here before, and why it is not here now
 *
 * The previous hook was a `post-commit` running:
 *
 * ```sh
 * npx -y @ericjdz/arkive reconcile --quiet 2>/dev/null || true
 * ```
 *
 * Four independent defects in one line:
 *
 * 1. **`post-commit` cannot gate anything.** It fires after the commit exists.
 * 2. **`--quiet` did not exist when the hook was written.** Commander rejected
 *    the flag and the command exited non-zero on every commit. Issue 0004 added
 *    the flag afterwards, which fixed a symptom and left the hook still unable
 *    to block and still swallowing its output.
 * 3. **`2>/dev/null || true` discarded the failure and the exit code.** So the
 *    hook could never surface anything, in either direction.
 * 4. **`npx -y` fetches unpinned remote code and executes it on every commit.**
 *    For a documentation tool.
 *
 * It had, by construction, never done anything. `pre-commit` can block, reports
 * in prose on stderr, exits non-zero for exactly one reason, and calls the
 * locally installed binary.
 *
 * ## The escape hatches, all of them one command
 *
 * `git commit --no-verify` (git's own), `arkive hooks --remove`, and
 * `ARKIVE_HOOK_DISABLE=1`. The ADR requires the first; the second is the
 * permanent opt-out; the third is the one that works in CI without installing
 * anything.
 */

const BLOCK_START = "# arkive:start";
const BLOCK_END = "# arkive:end";

export interface HookResult {
  installed: string[];
  skipped: string[];
  /** Non-fatal. Reported to stderr; never throws. */
  error?: string;
  /** Paths written, for `--dry-run` and for the install report. */
  written?: string[];
}

export interface InstallGitHooksOptions {
  /**
   * The command the hook runs.
   *
   * Defaults to the locally installed `arkive`. The override exists for two
   * reasons: a project-local install that is not on `PATH`, and CI images where
   * the binary lives somewhere specific. It is an explicit override rather than
   * an automatic search because an automatically discovered binary is one more
   * thing that can silently become something else between one commit and the
   * next.
   */
  command?: string;
  /** Compute the plan without writing anything. */
  dryRun?: boolean;
}

/**
 * `.git` is a file in a worktree or a submodule, and a directory in a normal
 * clone. Reading the pointer is what keeps `arkive hooks` working in the first
 * two cases instead of failing with ENOTDIR.
 */
export function resolveGitDir(dir: string): string | null {
  const dotGit = resolve(dir, ".git");
  if (existsSync(join(dotGit, "hooks"))) return dotGit;

  let raw: string;
  try {
    raw = readFileSync(dotGit, "utf-8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!match) return null;
  const pointer = match[1].trim();
  const resolved = resolve(dir, pointer);
  return existsSync(join(resolved, "hooks")) ? resolved : null;
}

/**
 * The block installed into `.git/hooks/pre-commit`.
 *
 * `command -v` first, so a machine without arkive on `PATH` exits 0 silently
 * rather than printing `arkive: command not found` on every commit in the
 * repository. A hook that is noisy when it cannot run is a hook that gets
 * deleted, and a deleted hook enforces nothing.
 */
function preCommitBlock(command: string): string {
  // A single-token command is a bare binary name, which may legitimately not be
  // on `PATH` on this machine. Guard it, so a checkout whose arkive has been
  // uninstalled exits 0 quietly instead of printing `arkive: command not found`
  // on every commit. A command containing spaces is already an explicit
  // override — a path, an interpreter invocation — and is used verbatim.
  const invocation = command.includes(" ")
    ? `${command} hooks run pre-commit`
    : [
        `if ! command -v ${command} >/dev/null 2>&1; then exit 0; fi`,
        `${command} hooks run pre-commit`,
      ].join("\n");

  return [
    BLOCK_START,
    `# arkive pre-commit gate — @ericjdz/arkive ${PACKAGE_VERSION}`,
    "#",
    "# Blocks the commit when arkive/architecture.json and the code disagree in ways",
    "# the document cannot defend (an edge that resolves to nothing, a decision",
    "# pointing at a node that is gone).",
    "#",
    "# It does NOT block when the scan was inconclusive. Inconclusive means arkive could",
    "# not look at enough of the tree to have an opinion, which is a limitation of the",
    "# scanner and not a problem with the document; blocking on it would stop commits",
    "# for a reason the user cannot act on. Those cases are printed to stderr instead,",
    "# on every run, so a gate that stayed quiet is never mistaken for a gate that passed.",
    "#",
    `# Installed by: arkive hooks (${PACKAGE_VERSION})`,
    `# Runs:         ${command} hooks run pre-commit`,
    "#",
    "# Escape hatches:",
    "#   once      git commit --no-verify",
    "#   always    npx @ericjdz/arkive hooks --remove",
    "#   env       ARKIVE_HOOK_DISABLE=1",
    "#",
    "# Runs the locally installed binary. Fetches nothing at commit time.",
    "",
    'if [ -n "${ARKIVE_HOOK_DISABLE:-}" ]; then exit 0; fi',
    invocation,
    BLOCK_END,
  ].join("\n");
}

export function installGitHooks(dir: string, options: InstallGitHooksOptions = {}): HookResult {
  const gitDir = resolveGitDir(dir);
  if (gitDir === null) {
    return { installed: [], skipped: [], error: "not a git repository" };
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");
  const command = options.command ?? DEFAULT_HOOK_COMMAND;
  const block = preCommitBlock(command);
  const result: HookResult = { installed: [], skipped: [], written: [] };

  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : null;

  // Already installed and already current: do nothing. Re-running the installer
  // is how a user checks whether a hook survived, and a tool that rewrites a
  // file every time it is asked is a tool that shows up in diffs.
  if (existing !== null && existing.includes(BLOCK_START) && existing.includes(block)) {
    result.skipped.push("pre-commit");
    return result;
  }

  let contents: string;
  if (existing === null) {
    contents = `#!/bin/sh\n\n${block}\n`;
  } else if (existing.includes(BLOCK_START)) {
    contents = replaceBlock(existing, block);
  } else {
    contents = `${existing.trimEnd()}\n\n${block}\n`;
  }

  if (options.dryRun) {
    result.installed.push("pre-commit");
    result.written!.push(hookPath);
    return result;
  }

  try {
    mkdirSync(hooksDir, { recursive: true });
    writeFileAtomic(hookPath, contents);
    chmodSync(hookPath, 0o755);
  } catch (err) {
    result.error = `could not write ${hookPath}: ${(err as Error).message}`;
    return result;
  }

  result.installed.push("pre-commit");
  result.written!.push(hookPath);
  return result;
}

/** Swap the arkive block in place, leaving everything around it byte-identical. */
function replaceBlock(existing: string, block: string): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return `${existing.trimEnd()}\n\n${block}\n`;
  }
  const before = existing.slice(0, start);
  const after = existing.slice(end + BLOCK_END.length);
  return `${before}${block}${after}`;
}

/**
 * Remove arkive's git hook.
 *
 * Deletes the file when the block is all that is in it, and strips the block
 * when somebody else's hook shares the file. The second case is the one that
 * matters: a `pre-commit` that already runs a formatter is common, and silently
 * removing it to install ours would be the worst thing this tool could do.
 */
export function uninstallGitHooks(dir: string): { removed: string[]; error?: string } {
  const gitDir = resolveGitDir(dir);
  if (gitDir === null) return { removed: [], error: "not a git repository" };

  const hookPath = join(gitDir, "hooks", "pre-commit");
  if (!existsSync(hookPath)) return { removed: [] };

  const existing = readFileSync(hookPath, "utf-8");
  if (!existing.includes(BLOCK_START)) return { removed: [] };

  const stripped = existing
    .replace(new RegExp(`\\n?${BLOCK_START.replace("#", "\\#")}[\\s\\S]*?${BLOCK_END.replace("#", "\\#")}\\n?`), "\n")
    .trim();

  if (stripped === "" || stripped === "#!/bin/sh") {
    try {
      unlinkSync(hookPath);
    } catch (err) {
      return { removed: [], error: `could not remove ${hookPath}: ${(err as Error).message}` };
    }
  } else {
    try {
      writeFileAtomic(hookPath, `${stripped}\n`);
    } catch (err) {
      return { removed: [], error: `could not rewrite ${hookPath}: ${(err as Error).message}` };
    }
  }

  return { removed: ["pre-commit"] };
}

// --- Claude Code -------------------------------------------------------------

export interface InstallClaudeHooksOptions {
  command?: string;
  dryRun?: boolean;
}

/**
 * Wire arkive's four advisory hooks into `.claude/settings.json`.
 *
 * This is the surface that delivers architecture context without asking the
 * agent for it: `SessionStart` puts the document in the context window before
 * the first token. Everything else here is defence in depth around that.
 *
 * The file is merged, never replaced. Every other key, every other hook group,
 * and every handler in a group that also holds an arkive handler survives.
 */
export function installClaudeHooks(dir: string, options: InstallClaudeHooksOptions = {}): HookResult {
  const settingsPath = join(dir, ".claude", "settings.json");
  const command = options.command ?? DEFAULT_HOOK_COMMAND;
  const result: HookResult = { installed: [], skipped: [], written: [] };

  let existing;
  try {
    existing = parseClaudeSettings(existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : "");
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }

  if (hasArkiveSettings(existing)) {
    result.skipped.push("claude-code");
    return result;
  }

  const groupsByEvent: Record<string, unknown> = {};
  for (const event of ["session-start", "pre-tool-use", "pre-compact", "stop"] as const) {
    groupsByEvent[toClaudeEventName(event)] = buildMatcherGroups(event, command);
  }

  const merged = serializeClaudeSettings(mergeClaudeSettings(existing, buildArkiveEntries(command, groupsByEvent)));

  if (options.dryRun) {
    result.installed.push("claude-code");
    result.written!.push(settingsPath);
    return result;
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileAtomic(settingsPath, merged);
  } catch (err) {
    result.error = `could not write ${settingsPath}: ${(err as Error).message}`;
    return result;
  }

  result.installed.push("claude-code");
  result.written!.push(settingsPath);
  return result;
}

/** Remove arkive's hooks from `.claude/settings.json`, leaving the rest. */
export function uninstallClaudeHooks(dir: string): { removed: string[]; error?: string } {
  const settingsPath = join(dir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return { removed: [] };

  let existing;
  try {
    existing = parseClaudeSettings(readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    return { removed: [], error: (err as Error).message };
  }

  if (!hasArkiveSettings(existing)) return { removed: [] };

  const cleaned = removeArkiveSettings(existing);
  try {
    if (Object.keys(cleaned).length === 0) {
      unlinkSync(settingsPath);
    } else {
      writeFileAtomic(settingsPath, serializeClaudeSettings(cleaned));
    }
  } catch (err) {
    return { removed: [], error: `could not rewrite ${settingsPath}: ${(err as Error).message}` };
  }

  return { removed: ["claude-code"] };
}

function toClaudeEventName(event: string): string {
  switch (event) {
    case "session-start":
      return "SessionStart";
    case "pre-tool-use":
      return "PreToolUse";
    case "pre-compact":
      return "PreCompact";
    default:
      return "Stop";
  }
}

/**
 * Every path `arkive hooks` manages.
 *
 * `arkive hooks --dry-run` prints exactly this list and writes nothing, which
 * is what makes hook installation reviewable before it happens rather than
 * discovered afterwards (ADR-0006 §4).
 */
export function managedHookPaths(dir: string): string[] {
  const paths: string[] = [];
  const gitDir = resolveGitDir(dir);
  if (gitDir !== null) paths.push(join(gitDir, "hooks", "pre-commit"));
  paths.push(join(dir, ".claude", "settings.json"));
  return paths;
}
