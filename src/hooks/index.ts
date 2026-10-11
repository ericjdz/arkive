/**
 * The hook substrate.
 *
 * One contract, N adapters (ADR-0005). Importing this module gives you the
 * contract types, the dispatch, and the Claude Code adapter; nothing here knows
 * about git, and nothing here knows about any harness other than the one
 * adapter that does.
 */

export {
  DISABLE_ENV,
  DEBUG_ENV,
  HOOK_BUDGET_MS,
  HOOK_CONTRACT_VERSION,
  HOOK_EVENTS,
  HOOK_EXIT,
  failureResult,
  hooksDisabled,
  normalizeHookInput,
  parseHookInput,
  silentResult,
} from "./contract.js";
export type { HookEvent, HookExitCode, HookInput, HookResult } from "./contract.js";

export { parseHookEvent, runHook } from "./runner.js";

export { executeHook, main, normalizeHookArgv, readStdin } from "./main.js";
export type { HookIo } from "./main.js";

export { preCommit } from "./pre-commit.js";
export { preCompact } from "./pre-compact.js";
export { preToolUse } from "./pre-tool-use.js";
export { sessionStart, SESSION_CONTEXT_MAX_CHARS, SESSION_CONTEXT_MAX_TOKENS } from "./session-start.js";
export { stop } from "./stop.js";

export {
  displayPath,
  hookProjectDir,
  locateProject,
  matchSourcePath,
  matchesSourcePattern,
  normalizePath,
  readArkiveConfig,
  relativeToProject,
  toPosix,
  SOURCE_EXTENSIONS,
} from "./paths.js";
export type { ArkiveConfig, ProjectLocation, SourcePathMatch } from "./paths.js";

export { COVERAGE_KINDS, formatCoverageGap, formatWarning, partitionCritical, verifyProject } from "./verify.js";
export type { VerifyOutcome, VerifyStatus } from "./verify.js";

export {
  CLAUDE_EVENT,
  FILE_EDIT_MATCHER,
  buildMatcherGroups,
  toClaudeOutput,
} from "./adapters/claude-code.js";
export type { ClaudeHookHandler, ClaudeHookMatcherGroup } from "./adapters/claude-code.js";
