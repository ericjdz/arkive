import {
  HOOK_BUDGET_MS,
  HOOK_EVENTS,
  HOOK_EXIT,
  failureResult,
  hooksDisabled,
  parseHookInput,
  silentResult,
} from "./contract.js";
import type { HookEvent, HookInput, HookResult } from "./contract.js";
import { preCompact } from "./pre-compact.js";
import { preToolUse } from "./pre-tool-use.js";
import { sessionStart } from "./session-start.js";
import { stop } from "./stop.js";

/**
 * Dispatch: contract event in, {@link HookResult} out.
 *
 * The budget is enforced here rather than in each hook, because "every hook
 * respects the budget" is a property of the dispatcher and not of four functions
 * that each have to remember. A hook that overruns has its payload dropped and a
 * note recorded — it is not allowed to block, and it is not allowed to deliver a
 * stale partial answer either.
 *
 * `pre-commit` is absent from this table on purpose. It is not a harness event:
 * git hands it environment variables, not a JSON payload, and it reports in
 * prose on stderr rather than in a JSON object on stdout. It has its own entry
 * point (`preCommit` in `pre-commit.ts`) because it is the one hook whose output
 * a human reads, and routing it through the harness dispatcher would have meant
 * pretending it is the same kind of thing.
 */

type Handler = (input: HookInput, elapsedMs: number) => HookResult;

const HARNESS_HANDLERS: Record<Exclude<HookEvent, "pre-commit">, Handler> = {
  "session-start": sessionStart,
  "pre-tool-use": preToolUse,
  "pre-compact": preCompact,
  stop,
};

/**
 * Narrow an arbitrary string to a contract event.
 *
 * Accepts the contract's own kebab-case (`session-start`), the Claude Code
 * spelling (`SessionStart`), and any casing in between. The CamelCase form is
 * not a nicety: `SessionStart` is the name on the wire, so a dispatcher that
 * only understood kebab-case would silently exit 0 on every event — a hook that
 * is installed, runs on schedule, and never says anything.
 */
export function parseHookEvent(value: unknown): HookEvent | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return (HOOK_EVENTS as readonly string[]).includes(normalized) ? (normalized as HookEvent) : null;
}

/**
 * Run one harness hook.
 *
 * Never throws and never returns a blocking exit. Those are the two properties
 * that let a harness treat arkive as safe to run on every event: a hook that can
 * crash the agent's tool loop, or one that can make the agent unable to finish
 * its turn, would be removed from `.claude/settings.json` and the product would
 * be back to prose, which is the failure this module was written to close.
 */
export function runHook(event: HookEvent, rawInput: string, now = Date.now): HookResult {
  if (hooksDisabled()) return silentResult(event);
  if (event === "pre-commit") {
    // Reachable only if a caller routes the git event through the harness
    // dispatcher. It is a programming error, not a user error, so it is loud.
    throw new Error("runHook handles harness events only; call preCommit() for the git gate.");
  }

  const startedAt = now();
  try {
    return enforceBudget(event, HARNESS_HANDLERS[event](parseHookInput(rawInput), now() - startedAt));
  } catch (err) {
    return failureResult(event, err, now() - startedAt);
  }
}

/**
 * Drop an over-budget payload rather than shipping a partial one.
 *
 * The alternative — delivering a truncated session context — is worse than
 * silence, because the agent cannot tell that what it received was cut short
 * and will answer from a summary believing it read the whole thing. The exit
 * code stays 0 even here: being slow is not a reason to stop an agent working.
 */
function enforceBudget(event: HookEvent, result: HookResult): HookResult {
  if (result.elapsedMs <= HOOK_BUDGET_MS) return result;
  return {
    ...result,
    context: null,
    block: false,
    exitCode: HOOK_EXIT.ALLOW,
    overBudget: true,
    notes: [
      ...result.notes,
      `arkive ${event} hook took ${result.elapsedMs}ms, over the ${HOOK_BUDGET_MS}ms budget; ` +
        "its output was discarded rather than delivered incomplete.",
    ],
  };
}
