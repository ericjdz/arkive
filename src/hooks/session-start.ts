import { buildSessionContext } from "../server/session-context.js";
import { HOOK_BUDGET_MS, HOOK_EXIT, silentResult } from "./contract.js";
import type { HookEvent, HookInput, HookResult } from "./contract.js";
import { hookProjectDir, locateProject } from "./paths.js";
import { readArchitecture } from "../io/architecture-file.js";

/**
 * `session-start` — the hook that matters.
 *
 * ADR-0005's whole thesis in one file: a rule delivered as markdown runs only
 * if the model chooses to, and a rule delivered here is in the context window
 * before the agent's first token. This is the difference between *asked* to
 * remember and *told*, and it is the only thing in this directory that closes
 * the gap without asking anything of the agent.
 *
 * Never writes. `SessionStart` fires on every session and on every `/clear`, and
 * a hook that dirties the tree at session start is a hook that produces surprise
 * (ADR-0005: "Never write during `SessionStart` or `PreToolUse`").
 */

/**
 * Token ceiling for the injected payload.
 *
 * `buildSessionContext` defaults to 2000. This is now injected into every
 * session automatically rather than fetched on demand, so it is worth spending
 * less: the agent that needs the full document can read `architecture://overview`
 * or the file, and the thing it cannot do is ask.
 *
 * Issue 0012 owns the real budget work (centrality ranking, explicit truncation
 * markers inside `buildSessionContext`). This clamp is the belt to that
 * suspenders, and it holds even if 0012 has not landed.
 */
export const SESSION_CONTEXT_MAX_TOKENS = 1200;

/**
 * Hard character ceiling.
 *
 * Claude Code caps a hook's `additionalContext` at 10,000 characters and, past
 * it, writes the text to a file in the session directory and passes Claude the
 * *path* — and Claude is not asked to read it. A session-start hook that
 * overflows therefore delivers nothing at all, silently. Staying under the cap is
 * what makes the hook work, not a nicety.
 */
export const SESSION_CONTEXT_MAX_CHARS = 8000;

const TRUNCATION_NOTICE =
  "\n\n[Truncated: this is the architecture summary within its session budget, not the " +
  "complete document. Read arkive/architecture.json, or the architecture://overview " +
  "resource, for the full graph.]";

/**
 * The record's path, as the agent sees it.
 *
 * Project-relative rather than absolute, and deliberately: an injected context
 * window is shared with humans reading transcripts, gets copied into issues, and
 * outlives the checkout. `C:\Users\someone\...\arkive\architecture.json` in a
 * committed conversation is noise at best and a leaked home directory at worst.
 */
const RECORD_DISPLAY_PATH = "arkive/architecture.json";

export function sessionStart(input: HookInput, elapsedMs = 0): HookResult {
  const project = locateProject(hookProjectDir(input));
  if (project.dir === null) {
    // No document. arkive is not installed here, and that is not an error worth
    // spending a session's first token on.
    return silentResult("session-start", elapsedMs);
  }

  const read = readArchitecture(project.dir);
  if (!read.success) {
    return {
      ...silentResult("session-start", elapsedMs),
      inconclusive: true,
      notes: [`arkive session-start: could not read the document — ${read.error}`],
    };
  }

  let body: string;
  try {
    body = buildSessionContext(read.data, { maxTokens: SESSION_CONTEXT_MAX_TOKENS });
  } catch (err) {
    // `buildSessionContext` is shared with the MCP server and is owned by issue
    // 0012. A hook must not be breakable by a change to a module it merely
    // reads, so a failure here degrades to silence rather than propagating.
    return {
      ...silentResult("session-start", elapsedMs),
      inconclusive: true,
      notes: [
        `arkive session-start: session-context builder failed open — ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }

  const header = renderHeader(read.data.project.name, RECORD_DISPLAY_PATH, input.source);
  const context = clamp(`${header}\n${body}`, elapsedMs);

  return {
    event: "session-start" as HookEvent,
    context,
    block: false,
    reason: null,
    inconclusive: false,
    notes: [],
    exitCode: HOOK_EXIT.ALLOW,
    elapsedMs,
    overBudget: elapsedMs > HOOK_BUDGET_MS,
  };
}

/**
 * The framing around the document.
 *
 * Phrased as facts, not as orders. Claude Code documents that text framed as
 * out-of-band system instructions can trip prompt-injection defences, which
 * makes the agent surface the hook output to the user instead of reading it as
 * context — precisely backwards for a hook whose entire purpose is to be read
 * before the first token.
 */
function renderHeader(projectName: string, path: string, source?: string): string {
  const origin = source ? ` (session source: ${source})` : "";
  return [
    `# Architecture record — ${projectName}${origin}`,
    "",
    `This project tracks its architecture in ${path}. It is derived from static`,
    "analysis of the code, so the graph below is evidence rather than recollection.",
    "Intent, rationale, and rejected alternatives are recorded as decisions and are",
    "authored, not inferred.",
    "",
    "Structure changes (a new service, datastore, module boundary, protocol, or",
    "dependency) are recorded with `record_decision` or `update_architecture`, which",
    "attach the reasoning to the node or edge it explains. Structural drift is",
    "reported automatically; this record does not update itself.",
    "",
  ].join("\n");
}

/**
 * Keep the payload inside both ceilings.
 *
 * Truncation is stated, never silent: an agent that believes it is looking at a
 * complete architecture and is looking at a summary will confidently answer from
 * the summary, which is the exact failure this product exists to prevent.
 */
function clamp(text: string, elapsedMs: number): string | null {
  if (text.length <= SESSION_CONTEXT_MAX_CHARS) return text;
  const room = SESSION_CONTEXT_MAX_CHARS - TRUNCATION_NOTICE.length;
  return text.slice(0, Math.max(0, room)) + TRUNCATION_NOTICE;
}
