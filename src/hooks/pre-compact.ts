import { HOOK_EXIT, silentResult } from "./contract.js";
import type { HookInput, HookResult } from "./contract.js";
import { hookProjectDir, locateProject } from "./paths.js";
import { formatCoverageGap, formatWarning, verifyProject } from "./verify.js";

/**
 * `pre-compact` — capture what is about to fall out of the context window.
 *
 * Compaction is the one event where the agent's memory is destroyed rather than
 * merely stale, and ADR-0005 calls it "the exact moment memory is lost, which no
 * amount of markdown addressed". The lifecycle rules that matter — re-read
 * before a major change, update after one — are enforced by what survives
 * compaction, so this hook's job is to make the current agreement between the
 * document and the code part of what survives.
 *
 * ## What it does not do, and why
 *
 * ADR-0005 says writes happen in `pre-compact`, `stop`, and `pre-commit`. This
 * hook writes nothing, and that is a deliberate narrowing rather than an
 * omission:
 *
 * - The only thing worth writing at a compaction boundary is a **derived delta**
 *   — module nodes and edges that static analysis found and the document does
 *   not have. That derivation is issue 0005, and it does not exist yet. Writing
 *   before it lands means inventing a delta, and a fabricated delta in an
 *   architecture record is worse than a stale one, because it reads as fact.
 * - **Intent is the agent's.** A rationale, a rejected alternative, an owner: no
 *   amount of scanning recovers those, and a hook that guesses them is the
 *   compliance model with extra steps.
 *
 * So the hook takes the part it can do honestly — a bounded, current statement of
 * what the document claims and where the code disagrees — and injects it into
 * the context that compaction is about to summarise. When 0005 lands, this is
 * where the derived flush is added; the read-only half does not move.
 *
 * Never blocks. Blocking a compaction that is already past the context limit
 * turns a recoverable situation into a failed request.
 */
export function preCompact(input: HookInput, elapsedMs = 0): HookResult {
  const project = locateProject(hookProjectDir(input));
  if (project.dir === null) return silentResult("pre-compact", elapsedMs);

  const outcome = verifyProject(project.dir);
  if (outcome.status === "absent") return silentResult("pre-compact", outcome.elapsedMs);

  const notes: string[] = [];
  if (outcome.status === "unreadable") {
    return {
      ...silentResult("pre-compact", elapsedMs),
      inconclusive: true,
      notes: [
        `arkive pre-compact: the architecture record could not be read — ${outcome.error}. ` +
          "It will not survive compaction intact; nothing was changed.",
      ],
    };
  }

  const drift = outcome.drift;
  const document = outcome.document;
  if (!drift || !document) return silentResult("pre-compact", outcome.elapsedMs);

  const relevant = outcome.blocking;
  const gaps = outcome.coverageGaps;

  // Nothing to carry: the document agrees with what arkive could see, so the
  // agent loses nothing by losing this. Injecting "still fine" on every
  // compaction is how a hook gets ignored.
  if (relevant.length === 0 && gaps.length === 0) {
    return silentResult("pre-compact", outcome.elapsedMs);
  }

  const lines: string[] = [
    "Architecture state immediately before compaction:",
    "",
    `${document.project.name} — ${document.nodes.length} node(s), ` +
      `${document.edges.length} edge(s), ${document.decisions.length} decision(s), ` +
      `last updated ${document.project.lastUpdated}.`,
  ];

  if (relevant.length > 0) {
    lines.push("", "The record currently asserts relationships the code does not support:");
    for (const warning of relevant.slice(0, 8)) lines.push(formatWarning(warning));
    if (relevant.length > 8) {
      lines.push(`  ... and ${relevant.length - 8} more.`);
    }
    lines.push(
      "",
      "These are unresolved at the moment of compaction. Either the code moved and the",
      "record did not, or the record describes a relationship that no longer resolves —",
      "which is preserved rather than deleted on purpose, because silently dropping a",
      "recorded relationship is how the reasoning behind a system gets lost.",
      "",
      "Next: `arkive reconcile` prints the full report; `record_decision` /",
      "`update_architecture` records what changed and why.",
    );
  }

  if (gaps.length > 0) {
    lines.push("", "Limits on the above (arkive could not verify these):");
    for (const gap of gaps.slice(0, 3)) lines.push(formatCoverageGap(gap, outcome.scan));
    lines.push(
      "  This is not a clean bill of health. Silence from the rules above is evidence",
      "  only where the scan actually reached.",
    );
  }

  return {
    event: "pre-compact",
    context: lines.join("\n"),
    block: false,
    reason: null,
    inconclusive: outcome.inconclusive,
    notes,
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs: outcome.elapsedMs,
    overBudget: false,
  };
}
