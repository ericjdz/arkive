import { HOOK_EXIT, silentResult } from "./contract.js";
import type { HookInput, HookResult } from "./contract.js";
import { hookProjectDir, locateProject } from "./paths.js";
import { formatCoverageGap, formatWarning, verifyProject } from "./verify.js";

/**
 * `stop` — the report that tells the agent what it is about to leave undone.
 *
 * ## Why this does not block
 *
 * Issue 0011 §2 asks for "exit non-zero to block completion on critical drift".
 * ADR-0005 rejects that explicitly and supersedes it, and the rejection is
 * right on Claude Code's own terms: a `Stop` hook that returns a blocking
 * decision prevents the agent from ending its turn. Agents retry, loop, or
 * abandon; Claude Code counts consecutive continuations and ends the turn at
 * eight regardless, so the ninth report arrives with the work still undone and
 * the same message on screen. ADR-0005's alternative — return `additionalContext`,
 * which continues the conversation through the same loop protections but is
 * labelled hook feedback rather than a hook error — gets the correction without
 * the failure modes, and that is what this emits.
 *
 * The one hard rule on top of that: **if `stop_hook_active` is set, say
 * nothing.** The hook already spoke on this turn. Speaking again is nagging, not
 * reporting.
 *
 * Never writes, for the same reason `pre-compact` does not: see that module.
 */
export function stop(input: HookInput, elapsedMs = 0): HookResult {
  // The loop guard, before any work. A second report on a turn that is already
  // continuing because of the first one is the behaviour ADR-0005 is worried
  // about.
  if (input.stopHookActive === true) {
    return silentResult("stop", elapsedMs);
  }

  const project = locateProject(hookProjectDir(input));
  if (project.dir === null) return silentResult("stop", elapsedMs);

  const outcome = verifyProject(project.dir);
  if (outcome.status === "absent") return silentResult("stop", outcome.elapsedMs);

  if (outcome.status === "unreadable") {
    return {
      ...silentResult("stop", elapsedMs),
      inconclusive: true,
      notes: [`arkive stop: the architecture record could not be read — ${outcome.error}`],
    };
  }

  const document = outcome.document;
  if (!document) return silentResult("stop", outcome.elapsedMs);

  const gaps = outcome.coverageGaps;
  if (outcome.blocking.length === 0 && gaps.length === 0) {
    return silentResult("stop", outcome.elapsedMs);
  }

  const lines: string[] = [];
  if (outcome.blocking.length > 0) {
    lines.push(
      "Before this turn ends: the architecture record asserts structure the code does",
      "not support. If this turn changed any of it, the record is now out of date and",
      "the commit hook will refuse the commit until it is reconciled.",
      ""
    );
    const shown = outcome.blocking.slice(0, 5);
    for (const warning of shown) lines.push(formatWarning(warning));
    if (shown.length < outcome.blocking.length) {
      lines.push(`  ... and ${outcome.blocking.length - shown.length} more.`);
    }
    lines.push(
      "  Next: `arkive reconcile` prints the full report; record the change with",
      "  `record_decision` / `update_architecture`, or re-point or remove the",
      "  relationship. They are preserved on purpose — dropping one silently is how",
      "  recorded reasoning is lost."
    );
  }

  if (gaps.length > 0) {
    lines.push(
      "",
      "Separately, arkive could not verify the record against the whole tree on this",
      "turn, so " +
        (outcome.blocking.length > 0 ? "the" : "this") +
        " is not a clean bill of health:",
    );
    for (const gap of gaps.slice(0, 2)) lines.push(formatCoverageGap(gap, outcome.scan));
  }

  return {
    event: "stop",
    context: lines.join("\n"),
    block: false,
    reason: null,
    inconclusive: outcome.inconclusive,
    notes: [],
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs: outcome.elapsedMs,
    overBudget: false,
  };
}
