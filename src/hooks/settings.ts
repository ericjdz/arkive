import { toPosix } from "./paths.js";

/**
 * Settings generation for `.claude/settings.json`.
 *
 * ## The three properties this file has to have
 *
 * 1. **It merges.** A user's `.claude/settings.json` is theirs. Every key is
 *    preserved, every hook group that is not arkive's survives, and a repeated
 *    install does not append a second copy of the same hook.
 * 2. **It is removable exactly.** Uninstall removes arkive's handlers and
 *    nothing else, including from a group that holds both arkive's handler and
 *    somebody else's.
 * 3. **It runs no unpinned remote code.** The command is the locally installed
 *    `arkive` binary. The previous git hook ran `npx -y @ericjdz/arkive` on
 *    every commit, which is remote code execution on every commit for a
 *    documentation tool; nothing arkive generates fetches anything.
 */

/**
 * Identifies arkive's entries inside a settings file that may be full of other
 * people's entries.
 *
 * A substring, not a path, because the command legitimately differs between a
 * global install (`arkive`), a project-local one
 * (`node ./node_modules/@ericjdz/arkive/bin/arkive.mjs`), and an explicit
 * override. What all of them share is the subcommand shape arkive owns, and it
 * is the same shape the git hook uses — so a reader who has seen one recognises
 * the other.
 */
const ARKIVE_COMMAND_MARKER = "hooks run";

const SETTINGS_KEY = "arkiveHooks";
const HOOKS_KEY = "hooks";

export interface ClaudeSettings {
  [key: string]: unknown;
}

export interface ClaudeHookHandlerLike {
  type?: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface ClaudeHookGroupLike {
  matcher?: string;
  hooks?: ClaudeHookHandlerLike[];
  [key: string]: unknown;
}

/** The default command: the locally installed binary, on `PATH`. */
export const DEFAULT_HOOK_COMMAND = "arkive";

/** Every contract event Claude Code has an event for, in settings-file order. */
const CLAUDE_EVENTS_WITH_HOOKS = [
  "SessionStart",
  "PreToolUse",
  "PreCompact",
  "Stop",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a handler arkive generated. */
function isArkiveHandler(handler: unknown): boolean {
  if (!isRecord(handler)) return false;
  const command = typeof handler.command === "string" ? handler.command : "";
  return command.includes(ARKIVE_COMMAND_MARKER);
}

function parseSettings(raw: string): ClaudeSettings {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A settings file we cannot parse is a settings file we must not overwrite.
    // Returning `{}` would silently destroy whatever was in it; the caller
    // surfaces this as an error instead.
    throw new Error(".claude/settings.json exists but is not valid JSON. Fix or move it first.");
  }
}

/**
 * Strip arkive's handlers out of one event's matcher groups.
 *
 * Groups that become empty are removed; groups that still hold someone else's
 * handler keep their matcher and position. Removing the group rather than
 * leaving an empty array matters because an empty `hooks: []` reads as "this
 * event is configured, with nothing to run" to anything walking the file.
 */
function stripArkiveGroups(groups: unknown): ClaudeHookGroupLike[] {
  if (!Array.isArray(groups)) return [];

  const cleaned: ClaudeHookGroupLike[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    const remaining = handlers.filter((handler) => !isArkiveHandler(handler));
    if (remaining.length === handlers.length) {
      cleaned.push(group as ClaudeHookGroupLike);
      continue;
    }
    if (remaining.length === 0) continue;
    cleaned.push({ ...group, hooks: remaining } as ClaudeHookGroupLike);
  }
  return cleaned;
}

/**
 * Build the arkive entries to merge into a settings file.
 *
 * `groupsByEvent` is keyed by Claude Code event name. Its values are typed
 * loosely on purpose: this module only ever inspects and copies the groups, and
 * a narrow structural type here would force the adapter's (deliberately
 * precise) handler type to carry an index signature it has no use for.
 */
export function buildArkiveEntries(
  command: string,
  groupsByEvent: Record<string, unknown>
): ClaudeSettings {
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(groupsByEvent)) {
    if (Array.isArray(groups) && groups.length > 0) hooks[event] = groups;
  }
  return {
    // Not a Claude Code key. Recorded so a user who upgraded arkive and did not
    // re-run the installer can see which build wrote this file and compare it
    // with `arkive hooks install-claude`.
    [SETTINGS_KEY]: { writtenBy: "arkive hooks install-claude", schema: 1 },
    hooks,
  };
}

/**
 * Merge arkive's hooks into an existing settings object.
 *
 * Pure: takes the parsed object, returns a new one. The caller decides when to
 * write, which is what makes `--dry-run` possible without a second code path.
 */
export function mergeClaudeSettings(
  existing: ClaudeSettings,
  arkiveEntries: ClaudeSettings
): ClaudeSettings {
  const arkiveHooks = isRecord(arkiveEntries.hooks) ? arkiveEntries.hooks : {};
  const existingHooks = isRecord(existing[HOOKS_KEY]) ? { ...(existing[HOOKS_KEY] as Record<string, unknown>) } : {};

  for (const event of CLAUDE_EVENTS_WITH_HOOKS) {
    const kept = stripArkiveGroups(existingHooks[event]);
    const incoming = Array.isArray(arkiveHooks[event]) ? (arkiveHooks[event] as ClaudeHookGroupLike[]) : [];
    const merged = [...kept, ...incoming];
    if (merged.length > 0) existingHooks[event] = merged;
    else delete existingHooks[event];
  }

  return {
    ...existing,
    [SETTINGS_KEY]: arkiveEntries[SETTINGS_KEY],
    ...(Object.keys(existingHooks).length > 0 ? { [HOOKS_KEY]: existingHooks } : {}),
  };
}

/** Remove arkive's hooks, leaving everything else untouched. */
export function removeArkiveSettings(existing: ClaudeSettings): ClaudeSettings {
  const hooks = isRecord(existing[HOOKS_KEY]) ? { ...(existing[HOOKS_KEY] as Record<string, unknown>) } : {};
  for (const event of CLAUDE_EVENTS_WITH_HOOKS) {
    const kept = stripArkiveGroups(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next: ClaudeSettings = { ...existing };
  delete next[SETTINGS_KEY];
  if (Object.keys(hooks).length > 0) next[HOOKS_KEY] = hooks;
  else delete next[HOOKS_KEY];
  return next;
}

/**
 * True when the settings file already carries arkive's hooks.
 *
 * Written as "is there a group this function would change?" rather than as a
 * second, independent notion of what an arkive handler looks like. Two
 * definitions of the same thing is how an installer ends up reporting `skipped`
 * on a file full of its own entries, or appending a second copy of every hook
 * on every run.
 */
export function hasArkiveSettings(settings: ClaudeSettings): boolean {
  const hooks = settings[HOOKS_KEY];
  if (!isRecord(hooks)) return false;
  return CLAUDE_EVENTS_WITH_HOOKS.some((event) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return stripArkiveGroups(groups).length !== groups.length;
  });
}

export function parseClaudeSettings(raw: string): ClaudeSettings {
  return parseSettings(raw);
}

/** Settings files are JSON; arkive writes them with a trailing newline, like npm. */
export function serializeClaudeSettings(settings: ClaudeSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** A relative display path for logs, always with forward slashes. */
export function settingsDisplayPath(projectDir: string): string {
  return toPosix(`${projectDir}/.claude/settings.json`);
}
