import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, extname, relative, sep } from "node:path";

/**
 * ADR-0002, "The scanner's `src` assumption becomes a correctness bug".
 *
 * The scanner used to call `scanImports(join(dir, "src"))` and nothing else. A
 * project laid out as `lib/`, `app/`, `packages/` or `services/` therefore
 * produced `imports: []`, every downstream rule found nothing to complain
 * about, and `arkive reconcile` printed **"in sync"** on a document it had never
 * examined. For a drift detector that is the worst failure mode available: it
 * does not look broken, it looks *right*. Every rule below is skipped in the
 * absence of evidence, so the only honest thing an incomplete scan can do is
 * refuse to be silent about being incomplete.
 *
 * So the walk is real, and it reports on itself:
 *
 * - the repo root, not `src/`, and following `.gitignore`;
 * - `node_modules`, `dist`, `build`, `vendor` and `.git` always skipped;
 * - a hard cap on files and bytes, because a scan that never terminates is not
 *   a scan;
 * - `parseCoverage`, the fraction of files the walk *found* that it also
 *   *parsed*. Anything less than 1 is reported as `critical`.
 */

export interface ScanResult {
  hasPackageJson: boolean;
  dependencies: string[];
  imports: string[];
  /**
   * Fraction of discovered source files that were actually parsed, 0–1.
   *
   * 1 means the walk saw everything it was able to see. Anything less means
   * some rule below is reasoning about an incomplete view of the project, and
   * the absence of a warning is not evidence of anything.
   */
  parseCoverage: number;
  /** Files the walk found and read. */
  filesScanned: number;
  /** Files the walk found but could not read or could not attribute. */
  filesUnreadable: number;
  /** Files never reached because the walk hit its cap. */
  filesTruncated: number;
  /** Total bytes read, so a caller can tell "small project" from "capped". */
  bytesScanned: number;
  /** Top-level directories the walk entered, for the report. */
  roots: string[];
  /** Set when the walk stopped early. Never silent. */
  truncated: boolean;
  /** Human-readable reasons coverage is below 1. */
  scanNotes: string[];
}

/**
 * Hard caps. Both exist so `arkive status` cannot hang on a monorepo.
 *
 * 4000 files is roughly a very large single-package TypeScript project. Past
 * that the scan reports `truncated` rather than quietly taking 30 seconds.
 */
export const SCAN_MAX_FILES = 4000;
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** Never walked, whatever `.gitignore` says. */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  ".git",
]);

/** Extensions the import regex can meaningfully read. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/**
 * Extensions the walk *notices* but cannot analyse.
 *
 * Counting them as unreadable rather than ignoring them is the difference
 * between "no drift detected" and "I could not read the Go half of this
 * repository". A polyglot project is exactly where a drift detector's silence
 * is most expensive.
 */
const UNANALYSABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py",
  ".go",
  ".rb",
  ".java",
  ".kt",
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
  ".vue",
  ".svelte",
]);

const IMPORT_REGEX =
  /(?:import\s+(?:[^"']*?\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function scanProject(dir: string): ScanResult {
  const scanNotes: string[] = [];
  const dependencies = readDependencies(dir);
  const roots: string[] = [];

  let filesScanned = 0;
  let filesUnreadable = 0;
  let filesTruncated = 0;
  let bytesScanned = 0;
  let truncated = false;

  const ignore = loadGitignore(dir);
  const imports = new Set<string>();
  const queue: string[] = [dir];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop() as string;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as unknown as Dirent[];
    } catch (err) {
      scanNotes.push(`could not list ${relative(dir, current) || "."}: ${(err as Error).message}`);
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      const relPath = toPosix(relative(dir, full));
      if (!relPath || relPath === "") continue;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        // A symlink out of the repo, or a cycle, would make the walk
        // non-terminating. Record it and move on.
        try {
          const stats = lstatSync(full);
          const target = statSync(full);
          if (target.isDirectory()) {
            if (ignore(relPath, true)) continue;
            scanNotes.push(`skipped symlinked directory ${relPath}`);
            continue;
          }
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          scanNotes.push(`skipped unreadable symlink ${relPath}`);
          continue;
        }
      }

      if (isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (ignore(relPath, true)) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        if (current === dir) roots.push(entry.name);
        queue.push(full);
        continue;
      }

      if (!isFile) continue;

      const ext = extname(entry.name).toLowerCase();
      const analysable = SOURCE_EXTENSIONS.has(ext);
      if (!analysable && !UNANALYSABLE_EXTENSIONS.has(ext)) continue;
      if (ignore(relPath, false)) continue;

      if (filesScanned + filesUnreadable + filesTruncated >= SCAN_MAX_FILES ||
          bytesScanned >= SCAN_MAX_BYTES) {
        filesTruncated += 1;
        truncated = true;
        continue;
      }

      if (!analysable) {
        filesUnreadable += 1;
        continue;
      }

      let content: string;
      try {
        const stats = statSync(full);
        if (stats.size > MAX_FILE_BYTES) {
          // Too big to be hand-written source. Counting it as unreadable keeps
          // coverage honest: a bundled file is not something a regex can analyse.
          filesUnreadable += 1;
          scanNotes.push(`skipped ${relPath} (${stats.size} bytes, above the per-file cap)`);
          continue;
        }
        content = readFileSync(full, "utf-8");
        bytesScanned += stats.size;
      } catch (err) {
        filesUnreadable += 1;
        scanNotes.push(`could not read ${relPath}: ${(err as Error).message}`);
        continue;
      }

      filesScanned += 1;
      collectImports(content, imports);
    }
  }

  const discovered = filesScanned + filesUnreadable + filesTruncated;
  const parseCoverage = discovered === 0 ? 1 : filesScanned / discovered;

  if (truncated) {
    scanNotes.push(
      `scan stopped at the ${SCAN_MAX_FILES}-file / ${SCAN_MAX_BYTES}-byte cap; ` +
        `${filesTruncated} source file(s) were not examined`
    );
  }
  if (filesUnreadable > 0) {
    scanNotes.push(
      `${filesUnreadable} file(s) are not JavaScript/TypeScript and were not analysed`
    );
  }
  if (discovered === 0) {
    scanNotes.push("no JavaScript or TypeScript source files were found");
  }

  return {
    hasPackageJson: existsSync(join(dir, "package.json")),
    dependencies: Array.from(new Set(dependencies)).sort(),
    imports: Array.from(imports).sort(),
    parseCoverage,
    filesScanned,
    filesUnreadable,
    filesTruncated,
    bytesScanned,
    roots: roots.sort(),
    truncated,
    scanNotes,
  };
}

function collectImports(content: string, into: Set<string>): void {
  IMPORT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    const pkg = normalizePackage(match[1]);
    if (pkg) into.add(pkg);
  }
}

function readDependencies(dir: string): string[] {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return [];
  }
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

type IgnoreMatcher = (relPath: string, isDirectory: boolean) => boolean;

/**
 * Honour the project's `.gitignore`.
 *
 * Not a full gitignore implementation and it does not pretend to be: patterns
 * are matched per-segment, `*` and `?` and `**` are supported, negation is
 * supported, and directory-only patterns are supported. What it is for is
 * making the walk agree with what `git status` considers the project, which is
 * the question that matters for "did I look at everything".
 *
 * An unreadable or absent `.gitignore` is not an error: the walk still runs,
 * and it reports what it covered.
 */
export function loadGitignore(dir: string): IgnoreMatcher {
  const path = join(dir, ".gitignore");
  let contents = "";
  try {
    contents = readFileSync(path, "utf-8");
  } catch {
    return () => false;
  }

  const rules: Array<{ regex: RegExp; negate: boolean; dirOnly: boolean }> = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const negate = line.startsWith("!");
    const body = negate ? line.slice(1) : line;
    if (body === "") continue;

    const dirOnly = body.endsWith("/");
    const pattern = dirOnly ? body.slice(0, -1) : body;
    if (pattern === "") continue;

    rules.push({
      regex: globToRegExp(pattern),
      negate,
      dirOnly,
    });
  }

  if (rules.length === 0) return () => false;

  // Last matching rule wins, exactly as git resolves it.
  return (relPath: string, isDirectory: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(relPath)) ignored = !rule.negate;
    }
    return ignored;
  };
}

/**
 * A deliberately small subset of gitignore glob syntax.
 *
 * Unanchored patterns match at any depth (`node_modules`), anchored ones match
 * only at the root (`/build`), `**` crosses directories, `*` and `?` do not.
 */
export function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;

  let source = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "*") {
      if (body[i + 1] === "*") {
        // `**/` — any number of leading directories.
        if (body[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${source}(?:/.*)?$`);
}

function normalizePackage(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return null;
  if (!spec.startsWith("@") && !spec.includes("/") && NODE_BUILTINS.has(spec)) {
    return null;
  }
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "child_process", "url", "util", "stream",
  "events", "crypto", "http", "https", "net", "tls", "zlib",
  "buffer", "process", "querystring", "readline", "tty", "vm",
]);