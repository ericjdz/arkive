import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEBUG_ENV, HOOK_EXIT, failureResult, hooksDisabled } from "./contract.js";
import type { HookEvent, HookResult } from "./contract.js";
import { parseHookEvent, runHook } from "./runner.js";
import { preCommit } from "./pre-commit.js";
import { toClaudeOutput } from "./adapters/claude-code.js";
import { hookProjectDir } from "./paths.js";

/**
 * The hook process.
 *
 * One entry point for all five events, because "the harness runs a command" is
 * the only thing every hook substrate agrees on. Everything above this file is
 * platform-agnostic; everything below it is "read a file descriptor, write a
 * file descriptor, set an exit code".
 *
 * ## The four rules this file exists to hold
 *
 * 1. **stdout is a protocol.** For a harness event it is one JSON object or
 *    nothing. Never a stray line, never a newline, never a log. A hook that
 *    prints a diagnostic to stdout corrupts the agent's context, and the agent
 *    is the only thing this product has.
 * 2. **stderr is a person.** Every diagnostic, every failure, every coverage gap
 *    a user needs to know about. Claude Code discards stderr from a hook that
 *    exits 0 on most events, so these are for a human reading a terminal or a
 *    CI log, never for the model.
 * 3. **Fail open.** Any throw, any unrecognised event, any disabled hook exits
 *    0. The only non-zero exit this file can produce is `pre-commit`'s block.
 * 4. **Exit code and stdout are the contract.** A `pre-commit` block prints to
 *    stderr and exits 1; it prints nothing to stdout, because stdout on a git
 *    hook is noise in the middle of `git commit`'s own output.
 */

export interface HookIo {
  /** The harness payload. Read from fd 0 in production. */
  stdin: string;
  /** Where JSON goes. Ignored for `pre-commit`, which has no JSON. */
  stdout: (text: string) => void;
  /** Where diagnostics go. */
  stderr: (text: string) => void;
  /** Working directory for the git gate, when no harness `cwd` was supplied. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Read fd 0 to end. Never throws; an unreadable stdin is empty input. */
export function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    // No stdin, a closed pipe, or a platform that refuses to read fd 0. All
    // three mean the same thing to a hook: no payload, so fail open.
    return "";
  }
}

/**
 * Execute one hook and report what it decided.
 *
 * Pure with respect to the process: it takes the I/O it should use and returns
 * the exit code. `tests/hooks/` drives this directly with strings, which is why
 * the hook behaviour can be asserted without spawning anything.
 */
export function executeHook(event: HookEvent, io: HookIo): number {
  const debug = (io.env ?? process.env)[DEBUG_ENV] !== undefined;

  if (hooksDisabled(io.env ?? process.env)) {
    // Total silence. `ARKIVE_HOOK_DISABLE=1` is how a user, or a CI job, turns
    // arkive off without uninstalling it; printing "disabled" on every event
    // would make it unusable for the case it exists for.
    return HOOK_EXIT.ALLOW;
  }

  let result: HookResult;
  try {
    result =
      event === "pre-commit"
        ? preCommit(io.cwd)
        : runHook(event, io.stdin);
  } catch (err) {
    result = failureResult(event, err);
    emitStderr(result, io);
    return HOOK_EXIT.ALLOW;
  }

  emitStderr(result, io);
  if (event === "pre-commit") {
    if (result.block && result.reason) io.stderr(`${result.reason}\n`);
    return result.exitCode;
  }

  const payload = toClaudeOutput(result);
  if (payload !== null) io.stdout(`${JSON.stringify(payload)}\n`);
  // Emitted whenever debug is on, including at 0ms: a hook that is fast enough
  // to be invisible is exactly the one whose latency you need to be able to see.
  if (debug) io.stderr(`arkive ${event}: ${result.elapsedMs}ms\n`);
  return result.exitCode;
}

/**
 * Everything the user could need to know that the model does not need to know.
 *
 * Coverage gaps land here on every run, exit code or not, because "the gate did
 * not fire" and "the gate had nothing to fire on" must never look the same in a
 * commit log.
 */
function emitStderr(result: HookResult, io: HookIo): void {
  for (const note of result.notes) io.stderr(`${note}\n`);
}

/**
 * Strip the subcommand prefixes a caller may have left in front of the event.
 *
 * The same entry point is reached three ways — `node src/hooks/main.ts
 * session-start`, `arkive hooks run session-start`, and `arkive hooks
 * session-start` — because the installed binary is the shipped command and the
 * module is the direct one. Accepting all three removes an entire class of "the
 * hook is installed and silently does nothing", which is the failure mode that
 * made the previous `post-commit` hook useless for its whole life without
 * anybody noticing.
 */
export function normalizeHookArgv(argv: readonly string[]): string[] {
  const args = [...argv];
  if (args[0] === "hooks") args.shift();
  if (args[0] === "run") args.shift();
  return args;
}

/**
 * Process entry point.
 *
 * Deliberately separate from {@link executeHook} so that tests never have to
 * stub `process.exit` or capture `process.stdout`.
 */
export function main(argv: string[] = process.argv.slice(2)): number {
  const event = parseHookEvent(normalizeHookArgv(argv)[0]);

  if (event === null) {
    // An unrecognised event name is a harness that renamed something. Say
    // nothing and succeed: the alternative is a hook error on every event in
    // every session of a Claude Code that shipped a new lifecycle point.
    return HOOK_EXIT.ALLOW;
  }

  return executeHook(event, {
    stdin: event === "pre-commit" ? "" : readStdin(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: hookProjectDir({ cwd: process.env.CLAUDE_PROJECT_DIR }),
  });
}

/**
 * `true` when this module is the process entry point.
 *
 * `pathToFileURL` rather than string concatenation: `new URL("file://C:/x")`
 * parses `c:` as a host and produces a URL that matches nothing. On Windows that
 * silently means the hook process exits 0 without ever running — a gate that
 * looks installed and enforces nothing, which is the exact failure this whole
 * change exists to end.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(invoked)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main();
}
