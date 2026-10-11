/**
 * The hook contract (ADR-0005).
 *
 * One contract, N platform adapters. Everything in `src/hooks/` speaks these
 * types; nothing in here knows what a harness is. Claude Code lives in
 * `src/hooks/claude-code.ts`, git lives in `src/cli/commands/hooks.ts`, and a
 * Cursor or Windsurf adapter would be a third file that maps the same
 * {@link HookResult} onto its own wire format without touching anything below.
 *
 * ## The rule that shapes all of it
 *
 * > Harness-delivered context requires zero agent compliance.
 *
 * A rule delivered as markdown runs only if the model chooses to. A rule
 * delivered by `SessionStart` is in the context window before the agent's first
 * token. That is the whole thesis, and it is why `session-start` is the hook
 * that matters and `pre-commit` is the only one allowed to block.
 *
 * ## I/O
 *
 * - **stdin** — one JSON object, the harness's payload. Unknown fields are
 *   ignored and unknown *event* names exit 0: the harness is a dependency we do
 *   not control, so a renamed event must degrade to silence, never to a crash.
 * - **stdout** — one JSON object or nothing. Never prose. A hook that prints a
 *   stray line corrupts the agent's context, which is the thing this module
 *   exists to deliver.
 * - **stderr** — diagnostics. Never parsed by anyone. This is where "arkive
 *   could not verify anything" goes, which is the only place it can go without
 *   being mistaken for a verdict.
 */

/** The five events arkive implements. Names are the contract's, not a harness's. */
export const HOOK_EVENTS = [
  "session-start",
  "pre-tool-use",
  "pre-compact",
  "stop",
  "pre-commit",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Bumped only on a breaking change to {@link HookResult} or {@link HookInput}.
 *
 * The harness does not read this — it cannot, it is not in the harness's wire
 * format. It is in `.claude/settings.json` next to the hooks, so a user who
 * upgraded arkive and did not re-run `arkive hooks install-claude` can see that
 * the config on disk was written by an older build.
 */
export const HOOK_CONTRACT_VERSION = 1;

/**
 * Exit codes.
 *
 * `0` is the default and, for four of the five events, the only code that is
 * ever returned. `1` means "block" and is used by `pre-commit` alone.
 *
 * Why only one blocking hook: `pre-commit` is the one point where a hard
 * failure is affordable, because the user is about to create a commit they can
 * inspect and throw away. Every other event fires in a context where a block
 * strands the agent — a blocking `Stop` makes it unable to end its turn, which
 * produces loops. So `Stop` reports, `PreToolUse` nudges, and only `pre-commit`
 * says no.
 */
export const HOOK_EXIT = {
  /** Allow. Also: "nothing to say", "arkive is not installed here", "I failed". */
  ALLOW: 0,
  /** Block. `pre-commit` only. */
  BLOCK: 1,
} as const;

export type HookExitCode = (typeof HOOK_EXIT)[keyof typeof HOOK_EXIT];

/**
 * The latency budget from ADR-0005.
 *
 * This is a design constraint, not an aspiration, and the design is shaped by
 * it: the two hooks that fire on *every* event in a session — `session-start`
 * and `pre-tool-use` — never run the scanner. They read one JSON file and
 * return. Measured on this repository (163 files): document read ~11ms, session
 * context build ~2ms. The full scan is ~120ms and grows with the tree, which is
 * why it is reserved for `stop`, `pre-compact`, and `pre-commit` — one per turn,
 * one per compaction, one per commit.
 *
 * A hook that slows down every edit is a hook the user removes within a day.
 */
export const HOOK_BUDGET_MS = 200;

/**
 * Set to any truthy value to make every hook exit 0 immediately.
 *
 * The "hooks are an accelerant, never a dependency" invariant needs a switch a
 * user can reach without uninstalling, and it needs to be reachable from CI
 * (`ARKIVE_HOOK_DISABLE=1 npm test`) where installing anything is awkward. This
 * is that switch, and `tests/hooks/graceful-degradation.test.ts` asserts the
 * product works with every hook disabled.
 */
export const DISABLE_ENV = "ARKIVE_HOOK_DISABLE";

/** Set to any truthy value for diagnostics on stderr. Never changes behaviour. */
export const DEBUG_ENV = "ARKIVE_HOOK_DEBUG";

/**
 * Exit immediately without reading stdin.
 *
 * `ARKIVE_HOOK_DISABLE`, `ARKIVE_HOOK_DISABLE=0` and `ARKIVE_HOOK_DISABLE=false`
 * all disable. Anything unset or empty does not. The list is short on purpose:
 * an escape hatch with a grammar is an escape hatch nobody reaches.
 */
export function hooksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DISABLE_ENV];
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The harness payload, normalized.
 *
 * Every field is optional and every field is read defensively. Claude Code
 * documents `session_id`, `cwd`, `hook_event_name` and friends; a future version
 * may add more, another harness may send fewer, and an older Claude Code may not
 * send a field this build has started to rely on. The contract tolerates all
 * three rather than assuming the shape it was written against.
 */
export interface HookInput {
  /** Project directory. Falls back to `CLAUDE_PROJECT_DIR`, then `process.cwd()`. */
  cwd?: string;
  /** `SessionStart`: `startup` | `resume` | `clear` | `compact` | `fork`. */
  source?: string;
  /** `PreToolUse`: `Edit` | `Write` | `MultiEdit` | `NotebookEdit`. */
  toolName?: string;
  /** `PreToolUse`: the tool's arguments. Only `file_path` is read. */
  filePath?: string;
  /** `PreCompact`: `manual` | `auto`. */
  trigger?: string;
  /**
   * `Stop`: already true when a `Stop` hook has continued this turn.
   *
   * The loop guard. Claude Code caps consecutive continuations at eight and
   * then ends the turn regardless; without this check a document that cannot be
   * fixed burns all eight and then reports anyway, which reads as the hook
   * nagging rather than reporting.
   */
  stopHookActive?: boolean;
  /** The harness's own event name, for diagnostics. */
  hookEventName?: string;
}

/** Parse a harness payload. Never throws; an unparseable payload is empty input. */
export function parseHookInput(raw: string): HookInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Fail open. A harness that cannot produce JSON is a harness we have
    // nothing to say to, and a parse error is not the agent's problem.
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return normalizeHookInput(value as Record<string, unknown>);
}

/** Map a raw parsed object onto {@link HookInput}, dropping anything unusable. */
export function normalizeHookInput(value: Record<string, unknown>): HookInput {
  const input: HookInput = {};
  const str = (key: string): string | undefined => {
    const raw = value[key];
    return typeof raw === "string" ? raw : undefined;
  };

  const cwd = str("cwd");
  if (cwd) input.cwd = cwd;
  const source = str("source");
  if (source) input.source = source;
  const toolName = str("tool_name");
  if (toolName) input.toolName = toolName;
  const trigger = str("trigger");
  if (trigger) input.trigger = trigger;
  const hookEventName = str("hook_event_name");
  if (hookEventName) input.hookEventName = hookEventName;
  if (value.stop_hook_active === true) input.stopHookActive = true;

  const toolInput = value.tool_input;
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const filePath = (toolInput as Record<string, unknown>).file_path;
    if (typeof filePath === "string" && filePath !== "") input.filePath = filePath;
  }

  return input;
}

/**
 * What a hook decided.
 *
 * Platform-agnostic on purpose. An adapter turns this into whatever its harness
 * expects — `additionalContext`, `permissionDecision`, a git exit code — and
 * the logic underneath never learns which harness it is running under.
 */
export interface HookResult {
  event: HookEvent;
  /**
   * Text for the agent, or `null` to say nothing.
   *
   * Written as factual statements about the system, not as imperative
   * instructions. Claude Code documents that text framed as out-of-band system
   * commands can trip prompt-injection defences, which makes the agent surface
   * the hook output to the user instead of reading it as context — the exact
   * opposite of what a hook is for.
   */
  context: string | null;
  /**
   * Whether this hook may stop the action.
   *
   * Only `pre-commit` sets it. It is a separate field from the exit code
   * because the *harness* meaning of "block" differs from the *git* meaning:
   * git reads a non-zero exit, Claude Code reads exit 2 or a `decision` field,
   * and the adapter has to be the one that knows which.
   */
  block: boolean;
  /** Why. Goes to the human, never to the agent's context as an instruction. */
  reason: string | null;
  /**
   * True when arkive declined to act because it could not verify the project.
   *
   * Distinct from "clean". A clean gate says "I looked and it agrees"; an
   * inconclusive gate says "I could not look", and conflating the two is how a
   * drift detector manufactures false confidence (ADR-0002).
   */
  inconclusive: boolean;
  /** Diagnostics. stderr in every adapter. */
  notes: string[];
  exitCode: HookExitCode;
  elapsedMs: number;
  /** True when the hook exceeded {@link HOOK_BUDGET_MS} and dropped its payload. */
  overBudget: boolean;
}

/** The result of a hook that had nothing to say. */
export function silentResult(event: HookEvent, elapsedMs = 0): HookResult {
  return {
    event,
    context: null,
    block: false,
    reason: null,
    inconclusive: false,
    notes: [],
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs,
    overBudget: false,
  };
}

/**
 * The result of a hook that crashed.
 *
 * Always exit 0. A hook that cannot run must not be able to stop an agent from
 * editing files or stop a developer from committing — that would make arkive a
 * dependency rather than an accelerant, and the one thing issue 0011 exists to
 * prevent is the reverse: prose that breaks when the model forgets. A broken
 * hook is quieter than a broken rule, and quiet is the correct failure.
 */
export function failureResult(event: HookEvent, error: unknown, elapsedMs = 0): HookResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    event,
    context: null,
    block: false,
    reason: null,
    inconclusive: true,
    notes: [`arkive ${event} hook failed open: ${message}`],
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs,
    overBudget: false,
  };
}
