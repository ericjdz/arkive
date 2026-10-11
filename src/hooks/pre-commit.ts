import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HOOK_EXIT, silentResult } from "./contract.js";
import type { HookResult } from "./contract.js";
import { locateProject } from "./paths.js";
import { formatCoverageGap, formatWarning, verifyProject } from "./verify.js";

/**
 * `pre-commit` — the only hook in arkive's history that can prevent anything.
 *
 * Everything else in `src/hooks/` is an accelerant. This one is a gate, and it
 * is a gate because of a specific property of the moment it fires in: the user
 * is about to create a commit they can read, discard, and `git commit
 * --no-verify` past. It is the one place a hard failure is affordable.
 *
 * It replaces a `post-commit` hook that
 *
 * - ran *after* the commit, so it could never gate anything;
 * - passed `reconcile --quiet`, a flag that did not exist when the hook was
 *   written, so Commander rejected it and the command exited non-zero on every
 *   commit in every repository that installed it;
 * - piped that failure into `2>/dev/null || true`, so the failure was discarded
 *   along with the exit code; and
 * - ran `npx -y @ericjdz/arkive`, fetching unpinned remote code and executing it
 *   on every commit, for a documentation tool.
 *
 * ## What blocks, and what deliberately does not
 *
 * | Condition | Blocks? |
 * |---|---|
 * | Document present, scan conclusive, `critical` finding that is not a coverage kind | **yes** |
 * | Document present, scan inconclusive (`incomplete-scan`, `missing-manifest`) | no — reported on stderr |
 * | Document missing | **yes** — see below |
 * | Document unreadable or schema-invalid | **yes** |
 * | `warning`-severity drift | no |
 * | arkive itself failed | no — fails open, loudly, on stderr |
 *
 * **Inconclusive scans do not block.** `drift.ts` marks `incomplete-scan` and
 * `missing-manifest` as `critical`, which is correct for a report and wrong for a
 * gate: blocking on them blocks commits because the *scanner* is incomplete
 * rather than because anything is wrong. On this repository — 163 files parsed,
 * 2 not — that alone would refuse every commit in a project whose architecture
 * is in perfect order. The gap is reported to stderr on every run so it is never
 * invisible, and the gate does not pretend a partial view is a verdict.
 *
 * **A missing document does block.** The general rule is "absent document: exit
 * 0, silently" — a harness hook firing in a directory arkive was never installed
 * into should be invisible. A git hook is different: it exists in
 * `.git/hooks/`, which is not committed, so it is only ever present in a
 * checkout where somebody ran `arkive hooks`. If the document is gone from a
 * checkout that opted in, something removed it, and the commit 62066bc class of
 * failure — a path change silently orphaning a document — is exactly what this
 * is here to catch. `arkive hooks --remove` and `git commit --no-verify` are both
 * one command away, and the block message says so.
 *
 * ## Failure is never a block
 *
 * If arkive cannot run, the commit proceeds. A gate that bricks `git commit`
 * because of a missing dependency, a Node upgrade, or a corrupted `node_modules`
 * gets uninstalled, and an uninstalled gate enforces nothing. The failure is
 * printed to stderr every single time so it cannot be missed, which is a
 * stronger guarantee than a block nobody can get past.
 */
export function preCommit(startDir: string, elapsedMs = 0): HookResult {
  const start = resolve(startDir);

  // Defensive. git runs this hook with the repository as its working directory,
  // so a directory that has vanished underneath us means the environment is not
  // what the gate was written for. Fail open, loudly.
  if (!existsSync(start)) {
    return {
      ...silentResult("pre-commit", elapsedMs),
      notes: [`arkive pre-commit: ${start} does not exist; skipping the gate.`],
    };
  }

  const project = locateProject(start);
  const exitCodeFor = (blocking: boolean): 0 | 1 =>
    blocking ? HOOK_EXIT.BLOCK : HOOK_EXIT.ALLOW;

  if (project.dir === null) {
    // There is no document anywhere at or above this checkout. That is a real
    // problem only when a repository is here at all, because a git hook exists
    // only where somebody ran `arkive hooks`. Outside a repository there is
    // nothing to be inconsistent with.
    if (project.reason === "no-repository") {
      const result = silentResult("pre-commit", elapsedMs);
      result.reason = "No git repository here; arkive has nothing to check.";
      return result;
    }
    return {
      ...silentResult("pre-commit", elapsedMs),
      reason:
        "arkive/architecture.json is missing and the pre-commit gate is installed.\n" +
        "  Either the document was deleted, moved, or never committed — which is the\n" +
        "  failure this gate exists to catch — or this checkout opted in by mistake.\n" +
        "  Fix it:      restore or re-create arkive/architecture.json, then commit again.\n" +
        "  Or opt out:  arkive hooks --remove\n" +
        "  Or once:     git commit --no-verify",
      block: true,
      exitCode: exitCodeFor(true),
    };
  }

  const outcome = verifyProject(project.dir);

  if (outcome.status === "unreadable") {
    return {
      ...silentResult("pre-commit", outcome.elapsedMs),
      block: true,
      exitCode: exitCodeFor(true),
      inconclusive: true,
      reason:
        "The architecture record exists but could not be read, so this commit cannot be\n" +
        "  checked against it. Committing a graph nobody can parse is how the record\n" +
        "  stops being a record.\n" +
        `  ${outcome.error}\n` +
        "  Fix it:      repair arkive/architecture.json, then commit again.\n" +
        "  Or once:     git commit --no-verify",
    };
  }

  if (outcome.status === "absent") {
    // Reachable only if the document vanished between the probe above and here,
    // which means something is actively deleting it mid-commit.
    return {
      ...silentResult("pre-commit", outcome.elapsedMs),
      block: true,
      exitCode: exitCodeFor(true),
      reason:
        "arkive/architecture.json disappeared during the pre-commit check.\n" +
        "  Something is moving it while git runs. Commit or opt out with --no-verify.",
    };
  }

  const notes: string[] = [];

  // Reported on every single run, never blocking. Silence here would be the
  // exact failure ADR-0002 describes: a detector that is quiet because it is
  // incomplete reads as a detector that is quiet because everything is fine.
  for (const gap of outcome.coverageGaps) {
    notes.push(
      `arkive could not verify this commit — the scan did not cover the project:\n` +
        formatCoverageGap(gap, outcome.scan) +
        `\n  This is not a clean bill of health. The gate did not fire because it has no` +
        `\n  finding to act on, not because it found nothing. Run \`arkive reconcile\` for detail.`
    );
  }

  if (outcome.blocking.length === 0) {
    return {
      ...silentResult("pre-commit", outcome.elapsedMs),
      notes,
      inconclusive: outcome.inconclusive,
    };
  }

  const body = [
    "The architecture record and the code disagree in ways the record cannot defend:",
    "",
    ...outcome.blocking.map(formatWarning),
    "",
    `Scan coverage: ${outcome.scan ? `${(outcome.scan.parseCoverage * 100).toFixed(1)}%` : "n/a"} ` +
      `over ${outcome.scan?.filesScanned ?? 0} parsed file(s).`,
    "",
    "Fix it:      record the change with `record_decision` / `update_architecture`,",
    "             or re-point or remove the dangling relationship. They are preserved",
    "             on purpose; deleting one silently is how recorded reasoning is lost.",
    "             `arkive reconcile` prints the full report.",
    "Or once:     git commit --no-verify",
    "Or always:   arkive hooks --remove",
  ].join("\n");

  return {
    event: "pre-commit",
    context: null,
    block: true,
    reason: body,
    inconclusive: outcome.inconclusive,
    notes,
    exitCode: exitCodeFor(true),
    elapsedMs: outcome.elapsedMs,
    overBudget: false,
  };
}

/** Convenience for callers that already have a project directory. */
export function preCommitInProject(projectDir: string, elapsedMs = 0): HookResult {
  return preCommit(resolve(projectDir), elapsedMs);
}
