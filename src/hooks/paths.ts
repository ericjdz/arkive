import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { architecturePath } from "../io/architecture-file.js";

/**
 * Finding the project, and deciding whether a file is architecture-relevant.
 *
 * Two jobs, both of which every hook needs and neither of which any hook should
 * reimplement:
 *
 * 1. **Where is the arkive document?** A hook fires from whatever directory the
 *    agent happens to be in. `src/analysis/`, `packages/api/`, the repo root —
 *    all of them should reach the same document, and none of them should reach
 *    a *parent* repository's document.
 * 2. **Is this file architecture-relevant?** `PreToolUse` fires on every edit. A
 *    nudge on `README.md` is noise; a nudge on a datastore module is the product.
 */

/**
 * How far up to look for the document.
 *
 * Deep enough for `packages/api/src/hooks/`, bounded so a hook launched from
 * somewhere unrelated terminates rather than walking to the filesystem root.
 */
const MAX_UPWARD_LEVELS = 12;

export interface ProjectLocation {
  /** The directory holding `arkive/architecture.json`, or `null` if not found. */
  dir: string | null;
  /**
   * Why the search stopped.
   *
   * `repo-without-record` and `no-repository` are different answers and the
   * `pre-commit` gate treats them oppositely: the first means somebody opted in
   * and the record has gone missing, the second means there was never anything
   * here. Collapsing them is how a gate meant to catch commit 62066bc ends up
   * silent in exactly the repository it was installed in.
   */
  reason: "found" | "repo-without-record" | "no-repository" | "unreadable";
}

/**
 * Walk up from `startDir` looking for `arkive/architecture.json`.
 *
 * The walk stops at the first directory that contains a `.git`, whether or not
 * that directory holds a document. A hook in `/repo/packages/api` must never
 * reach `/repo`'s document if `packages/api` is its own repository, and a hook
 * must never escape the project it was installed into and adopt a stranger's.
 */
export function locateProject(startDir: string): ProjectLocation {
  let current = resolve(startDir);

  for (let level = 0; level <= MAX_UPWARD_LEVELS; level += 1) {
    if (existsSync(architecturePath(current))) {
      return { dir: current, reason: "found" };
    }
    if (existsSync(resolve(current, ".git"))) {
      // A repository root with no record. arkive is not installed here, and
      // anything above this point belongs to someone else.
      return { dir: null, reason: "repo-without-record" };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { dir: null, reason: "no-repository" };
}

/** The project directory a hook should read, honouring the harness's own hints. */
export function hookProjectDir(input: { cwd?: string }): string {
  const candidates = [input.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return resolve(candidate);
  }
  return process.cwd();
}

/**
 * Forward slashes, always.
 *
 * Claude Code documents that on Windows `tool_input.file_path` arrives with
 * backslashes *even when the hook runs under Git Bash*, and that a comparison
 * written with forward slashes then never matches and the tool call proceeds as
 * if the hook had nothing to say. One normalisation point, used by every hook.
 */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Absolute, POSIX-normalised, with `.` and `..` resolved. */
export function normalizePath(path: string, baseDir: string): string {
  const absolute = isAbsolute(path) ? path : resolve(baseDir, path);
  return toPosix(resolve(absolute));
}

/** Project-relative POSIX path, or `null` when the file is outside the project. */
export function relativeToProject(path: string, projectDir: string): string | null {
  const rel = toPosix(relative(projectDir, path));
  if (rel === "") return null;
  if (rel === ".." || rel.startsWith("../")) return null;
  return rel;
}

/**
 * Source extensions, for `PreToolUse`.
 *
 * A superset of the scanner's `SOURCE_EXTENSIONS` (`src/analysis/scanner.ts`):
 * this list also covers the languages the scanner deliberately refuses to parse
 * and counts as unreadable. A `.go` file is unreadable to the drift detector and
 * *very* relevant to the architecture, so excluding it here would gate the hook
 * on exactly the files it knows least about.
 */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".rb",
  ".java",
  ".kt",
  ".kts",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".scala",
  ".ex",
  ".exs",
  ".erl",
  ".clj",
  ".sh",
  ".bash",
  ".sql",
  ".graphql",
  ".proto",
]);

/** Extensionless files that are architecture-relevant anyway. */
const SOURCE_FILENAMES: ReadonlySet<string> = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

/** Directories that never contain architecture, whatever their contents. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".git",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
]);

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "" : path.slice(0, idx);
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export interface ArkiveConfig {
  /**
   * Project-relative glob-ish prefixes. `"src"` matches `src/**`; `"packages/*"`
   * matches one directory level under `packages`. Matched per path segment, the
   * same way `.gitignore` matching works in `src/analysis/scanner.ts`, so the
   * two cannot disagree about what "inside src/" means.
   */
  sourcePaths: string[] | null;
}

/**
 * Read `arkive.config.json` if the project has one.
 *
 * Issue 0005 introduces that file for scanner roots. The hook needs the same
 * answer to a different question ("is this path architecture-relevant?") and is
 * landing in parallel with it, so this reads the file rather than importing a
 * module that does not exist yet, and accepts the three key spellings the issue
 * and its successors might use.
 *
 * An unreadable or malformed config is **not** an error: the hook falls back to
 * its defaults. A configuration file that stops the hook from running would make
 * arkive a dependency of its own configuration.
 */
export function readArkiveConfig(projectDir: string): ArkiveConfig {
  const path = resolve(projectDir, "arkive.config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { sourcePaths: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { sourcePaths: null };
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["sourcePaths", "source_paths", "include", "roots"]) {
    const value = record[key];
    if (Array.isArray(value) && value.some((entry) => typeof entry === "string")) {
      return { sourcePaths: value.filter((entry): entry is string => typeof entry === "string") };
    }
  }
  return { sourcePaths: null };
}

/** One path segment pattern: `*`, `?`, and `**`. */
function segmentMatches(segment: string, pattern: string): boolean {
  if (pattern === "**") return true;
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(segment);
}

/**
 * Match a project-relative path against one configured prefix.
 *
 * The rules are `.gitignore`'s, because that is what a user writing
 * `arkive.config.json` already has in their head:
 *
 * - the prefix must match **whole path segments**, so `src` does not match
 *   `srcery/`;
 * - a matched directory covers everything beneath it, at any depth;
 * - a leading double-star followed by a slash means *zero or more* leading
 *   directories, so `**\/.ts` matches both `.ts` at the root and `a/b/.ts`.
 */
export function matchesSourcePattern(relPath: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === "") return true;

  const pathSegments = relPath.split("/");

  // A leading `**` plus slash crosses directories. Handled by trying the
  // remainder against every suffix rather than by making `**` match one segment,
  // because "zero or more" is the whole difference between a leading `**/`
  // matching a file at the root and not matching it at all.
  const withoutLeadingStars = normalized.replace(/^(\*\*\/)+/, "");
  if (withoutLeadingStars !== normalized) {
    for (let start = 0; start <= pathSegments.length; start += 1) {
      if (matchesSegments(pathSegments.slice(start), withoutLeadingStars.split("/"))) return true;
    }
    return false;
  }

  return matchesSegments(pathSegments, normalized.split("/"));
}

/** Does `pathSegments` start with `patternSegments`, matched segment by segment? */
function matchesSegments(pathSegments: string[], patternSegments: string[]): boolean {
  if (patternSegments.length > pathSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i += 1) {
    if (!segmentMatches(pathSegments[i], patternSegments[i])) return false;
  }
  return true;
}

export interface SourcePathMatch {
  /** True when the edit should produce a nudge. */
  isSource: boolean;
  /** Project-relative POSIX path, or `null` when the file is outside the project. */
  relPath: string | null;
  /** Why it was excluded, when it was. One line, for the debug channel. */
  reason: string | null;
  /** True when the decision came from `arkive.config.json` rather than defaults. */
  fromConfig: boolean;
}

const NO_MATCH = { relPath: null, fromConfig: false } as const;

/**
 * Decide whether an edited path is architecture-relevant.
 *
 * Returns a {@link SourcePathMatch} rather than a boolean because the three
 * reasons a path is skipped are worth telling apart in a debug log, and a hook
 * that fires on every edit is exactly the place where "why did this run?" is
 * asked constantly.
 */
export function matchSourcePath(
  filePath: string,
  projectDir: string,
  config: ArkiveConfig = readArkiveConfig(projectDir)
): SourcePathMatch {
  const relPath = relativeToProject(normalizePath(filePath, projectDir), projectDir);
  if (relPath === null) {
    return { isSource: false, ...NO_MATCH, reason: "outside the project directory" };
  }

  const segments = relPath.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) {
    return { isSource: false, relPath, fromConfig: false, reason: "build or vendored directory" };
  }

  if (config.sourcePaths && config.sourcePaths.length > 0) {
    const matched = config.sourcePaths.some((pattern) => matchesSourcePattern(relPath, pattern));
    return {
      isSource: matched,
      relPath,
      fromConfig: true,
      reason: matched ? null : "not under a configured sourcePath",
    };
  }

  const name = basename(relPath);
  const ext = extensionOf(relPath);
  const isSource =
    SOURCE_EXTENSIONS.has(ext) || SOURCE_FILENAMES.has(name) || name.startsWith("Dockerfile.");
  return {
    isSource,
    relPath,
    fromConfig: false,
    reason: isSource ? null : `not a source extension (${ext || "no extension"})`,
  };
}

/**
 * The path a hook shows to a human or an agent.
 *
 * Project-relative, POSIX-normalised. An injected context window gets copied
 * into issues and outlives the checkout, and `C:\Users\<someone>\...` in a
 * committed conversation is noise at best.
 */
export function displayPath(projectDir: string, ...segments: string[]): string {
  return toPosix(resolve(projectDir, ...segments));
}
