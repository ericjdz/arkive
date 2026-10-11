import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { defaultRegistry } from "./extractors/registry.js";
import type { ExtractorRegistry } from "./extractors/registry.js";
import type { ExtractedImport, Extractor, ProjectLayout } from "./extractors/types.js";
import { loadConfig } from "./config.js";

/**
 * ADR-0002, "The scanner's `src` assumption is a credibility bug, not a
 * coverage bug".
 *
 * The scanner used to call `scanImports(join(dir, "src"))` and nothing else. A
 * project laid out as `lib/`, `app/`, `packages/&lt;pkg&gt;/src` or `services/&lt;svc&gt;`
 * therefore produced `imports: []`, every downstream rule found nothing to
 * complain about, and `arkive reconcile` printed **"in sync"** on a document it
 * had never examined. For a drift detector that is the worst failure mode
 * available: it does not look broken, it looks *right*. Every rule below is
 * skipped in the absence of evidence, so the only honest thing an incomplete
 * scan can do is refuse to be silent about being incomplete.
 *
 * So the walk is real, and it reports on itself:
 *
 * - the repo root, not `src/`, and following `.gitignore`;
 * - `node_modules`, `dist`, `build`, `vendor` and `.git` always skipped;
 * - a hard cap on files and bytes, because a scan that never terminates is not
 *   a scan;
 * - `parseCoverage`, the fraction of files the walk *found* that it also
 *   *parsed*. Anything less than 1 is reported as `critical`.
 *
 * ## Two passes, and why
 *
 * Discovery is a complete `readdir` walk that builds the file index and the
 * list of analysable paths. Extraction is a second pass over that list.
 *
 * The alternative — extracting during the walk — looks cheaper and is wrong.
 * `resolve.ts` answers "does `./sibling` name a file here?" from the index, and
 * a file listed after the importer has not been indexed yet. Every forward
 * reference (`import { later } from "./later"` is a *backward* reference and
 * fine; `import x from "../shared/util"` where `shared/` sorts after the
 * importing directory, which is most of them) would dangle on a directory-
 * ordered walk. A walk order is an implementation detail, and graph shape must
 * not depend on it.
 *
 * The two passes read each file exactly once, so the cost is one extra
 * `readdir` per directory and nothing else.
 *
 * ## What the walker deliberately does not know
 *
 * No language. It asks the registry which extractor owns a path and gets an
 * extractor or `undefined`. A file with no extractor becomes `filesUnreadable`
 * with a note naming the extension — the difference between "I could not read
 * the Ruby half of this repository" and "no drift detected". This is the rule
 * 0004 applied to directories, now applied to languages.
 */

export interface ScanOptions {
  /** Overrides `arkive.config.json`. CLI flags land here. */
  include?: string[];
  exclude?: string[];
  /** A different registry — how a test proves one-file languages. */
  registry?: ExtractorRegistry;
}

export interface ScannedFile {
  /** Repo-relative, posix. */
  path: string;
  /** Which extractor read it. Never `null` — only extracted files land here. */
  extractor: string;
  /** Import sites, with line numbers. */
  imports: ExtractedImport[];
  /**
   * `false` when the extractor could not read this file. Such a file is counted
   * against `parseCoverage`: an extractor that gave up has not reported the
   * absence of imports, it has failed to look. That distinction is the whole
   * subject of this file.
   */
  complete: boolean;
  /** Why it is not complete. */
  note?: string;
}

export interface LanguageCoverage {
  /** Files this extractor read. */
  files: number;
  /** Import sites found across those files. */
  imports: number;
  /** Files it could not fully read. */
  incomplete: number;
}

export interface ScanResult {
  hasPackageJson: boolean;
  dependencies: string[];
  /**
   * Flat npm package set, for `drift.ts`'s `undeclared-import` rule.
   *
   * npm-scoped on purpose. A Python `import requests` landing here would be
   * reported as an undeclared *JavaScript* dependency — trading a false
   * negative for a false positive, which is not a fix.
   */
  imports: string[];
  /**
   * Fraction of discovered source files that were actually parsed, 0–1.
   *
   * 1 means the walk saw everything it was able to see. Anything less means
   * every rule downstream is reasoning about an incomplete view of the project,
   * and the absence of a warning is not evidence of anything.
   */
  parseCoverage: number;
  /** Files read and fully extracted. */
  filesScanned: number;
  /** Files found but not fully extracted: no extractor, read error, or gave up. */
  filesUnreadable: number;
  /** Files never reached because the walk hit a cap. */
  filesTruncated: number;
  /** Total bytes read, so a caller can tell "small project" from "capped". */
  bytesScanned: number;
  /** Top-level directories the walk entered, for the report. */
  roots: string[];
  /** Set when the walk stopped early. Never silent. */
  truncated: boolean;
  /** Human-readable reasons coverage is below 1. */
  scanNotes: string[];
  /** Absolute repo root, so a caller can resolve `module.path`. */
  root: string;
  /** Per-file extraction, for derivation. */
  files: ScannedFile[];
  /** Every discovered file, repo-relative. The resolver's index. */
  fileIndex: ReadonlySet<string>;
  /** Every discovered directory, repo-relative. */
  directoryIndex: ReadonlySet<string>;
  /** Extractor id → coverage. */
  byLanguage: Record<string, LanguageCoverage>;
  /** Extensions found with no extractor, and how many files each had. */
  unsupported: Array<{ extension: string; files: number }>;
  /** The effective filters, echoed into `scanNotes`. */
  filters: { include: string[]; exclude: string[] };
  /** Aliases in effect. */
  aliases: Array<{ prefix: string; targets: string[] }>;
  /** `module` paths from `go.mod`, longest first. */
  goModules: string[];
  /** Import roots used for language-style module paths. */
  searchRoots: string[];
  /** `arkive.config.json` as loaded, or `null`. */
  configSource: string | null;
}

/**
 * Hard caps, so `arkive status` cannot hang on a monorepo.
 *
 * The file cap is 20,000 rather than something smaller because of a specific
 * measurement: a full scan plus derivation of a synthetic 5,000-file TypeScript
 * repository takes well under a second on this hardware, and
 * `tests/analysis/performance.test.ts` asserts that a 5,000-file scan stays
 * under the 5-second budget the issue sets. A cap below 5,000 would therefore
 * not be protecting anyone — it would be truncating a repository the scan can
 * finish, and reporting `truncated` on work that was never attempted. 20,000
 * leaves roughly four times the headroom the budget needs while still bounding
 * a pathological tree.
 *
 * `arkive.config.json` may raise this up to `MAX_FILES_CEILING` in
 * `config.ts`; beyond that, raising it stops being a configuration decision and
 * starts being a denial of service against your own repository.
 */
export const SCAN_MAX_FILES = 20_000;
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** Never walked, whatever `.gitignore` says. */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  ".git",
]);

/**
 * Extensions the walk *notices* but has no extractor for.
 *
 * Counting them as unreadable rather than ignoring them is the difference
 * between "no drift detected" and "I could not read the Ruby half of this
 * repository". A polyglot project is exactly where a drift detector's silence
 * is most expensive. A file with an extension in neither set (`.md`, `.json`,
 * `.txt`) is not source at all and is skipped without being counted, because
 * counting documentation as unreadable code would train the reader to ignore
 * the number.
 */
const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".rb", ".java", ".kt", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".php", ".swift", ".scala", ".ex", ".exs", ".erl", ".clj", ".sh", ".bash",
  ".sql", ".lua", ".dart", ".m", ".mm", ".pl", ".r", ".jl", ".nim", ".hs",
]);

/**
 * The order files are extracted in.
 *
 * Alphabetical, not walk order, so the graph a scan produces is byte-identical
 * regardless of the filesystem's directory ordering. Without this the same
 * repository produces a different edge ordering on ext4, APFS and NTFS, and
 * `arkive derive` would commit a diff on every run for no reason.
 */
function sortedDiscoveries(discovered: Discovery[]): Discovery[] {
  return discovered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

interface Discovery {
  /** Absolute path. */
  absolute: string;
  /** Repo-relative, posix. */
  path: string;
  extractor: Extractor;
}

export function scanProject(dir: string, options: ScanOptions = {}): ScanResult {
  const registry = options.registry ?? defaultRegistry;
  const loaded = loadConfig(dir);
  const config = loaded.config;
  const scanNotes: string[] = [...loaded.notes];

  const dependencies = readDependencies(dir);
  const roots: string[] = [];
  const fileIndex = new Set<string>();
  const directoryIndex = new Set<string>();
  const discovered: Discovery[] = [];
  const unsupported = new Map<string, number>();

  let filesScanned = 0;
  let filesUnreadable = 0;
  let filesTruncated = 0;
  let truncated = false;

  const maxFiles = config.maxFiles ?? SCAN_MAX_FILES;
  const maxBytes = config.maxBytes ?? SCAN_MAX_BYTES;
  const maxFileBytes = config.maxFileBytes ?? MAX_FILE_BYTES;

  const skip = new Set([...SKIP_DIRECTORIES, ...(config.skip ?? [])]);
  const include = options.include ?? config.include ?? [];
  const exclude = options.exclude ?? config.exclude ?? [];
  const searchRoots = config.searchRoots ?? ["", "src", "lib", "app"];

  const ignore = loadGitignore(dir);

  if (include.length > 0) {
    scanNotes.push(
      `scan restricted to ${include.join(", ")}; nothing outside those paths was ` +
        `examined, so the coverage below describes them and not the repository`
    );
  }
  if (exclude.length > 0) {
    scanNotes.push(
      `scan excludes ${exclude.join(", ")}; those paths were not examined and are ` +
        `not counted against coverage`
    );
  }

  // --- pass 1: discovery -----------------------------------------------------
  //
  // No file is opened here. This pass exists to produce a complete index, so
  // that resolution in pass 2 does not depend on the order directories happened
  // to come back in.
  const queue: string[] = [dir];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop() as string;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as unknown as Dirent[];
    } catch (err) {
      scanNotes.push(
        `could not list ${relative(dir, current) || "."}: ${(err as Error).message}`
      );
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
        if (skip.has(entry.name)) continue;
        if (ignore(relPath, true)) continue;
        if (!withinFilters(relPath, include, exclude)) continue;
        if (visited.has(full)) continue;
        visited.add(full);
        directoryIndex.add(relPath);
        if (current === dir) roots.push(entry.name);
        queue.push(full);
        continue;
      }

      if (!isFile) continue;

      const extension = extname(entry.name).toLowerCase();
      const extractor = registry.forPath(relPath);
      const knownUnsupported = extractor === undefined && UNSUPPORTED_EXTENSIONS.has(extension);
      if (extractor === undefined && !knownUnsupported) continue;
      if (ignore(relPath, false)) continue;
      if (!withinFilters(relPath, include, exclude)) continue;

      fileIndex.add(relPath);

      if (extractor === undefined) {
        // A language arkive has no extractor for. It counts against coverage:
        // a file that was found and not read is exactly what `parseCoverage`
        // exists to make visible, and dropping it here would restore the
        // original bug — a repository with an unreadable half reporting 100%.
        filesUnreadable += 1;
        unsupported.set(extension, (unsupported.get(extension) ?? 0) + 1);
        continue;
      }

      if (discovered.length >= maxFiles) {
        filesTruncated += 1;
        truncated = true;
        continue;
      }

      discovered.push({ absolute: full, path: relPath, extractor });
    }
  }

  // --- pass 2: extraction ----------------------------------------------------

  const layout: ProjectLayout = {
    root: dir,
    hasFile: (relPath) => fileIndex.has(relPath),
    hasDirectory: (relPath) => directoryIndex.has(relPath),
    searchRoots,
    aliases: loaded.aliases,
    goModules: loaded.goModules,
  };

  const files: ScannedFile[] = [];
  const byLanguage: Record<string, LanguageCoverage> = {};
  const imports = new Set<string>();

  let bytesScanned = 0;

  for (const entry of sortedDiscoveries(discovered)) {
    const bucket = (byLanguage[entry.extractor.id] ??= { files: 0, imports: 0, incomplete: 0 });

    let content: string;
    try {
      content = readFileSync(entry.absolute, "utf-8");
    } catch (err) {
      filesUnreadable += 1;
      bucket.incomplete += 1;
      scanNotes.push(`could not read ${entry.path}: ${(err as Error).message}`);
      continue;
    }

    // The size is measured from what was read rather than from a preceding
    // `statSync`. On the 5,000-file benchmark that stat is ~270ms of ~3,000ms —
    // one syscall per file spent learning something the read already told us —
    // and `readdirSync(withFileTypes)` has already established that this is a
    // regular file, so the stat was never doing that job.
    const size = Buffer.byteLength(content, "utf8");

    if (size > maxFileBytes) {
      // Too big to be hand-written source. Counting it as unreadable keeps
      // coverage honest: a bundled file is not something a regex can analyse.
      filesUnreadable += 1;
      bucket.incomplete += 1;
      scanNotes.push(`skipped ${entry.path} (${size} bytes, above the per-file cap)`);
      continue;
    }
    if (bytesScanned + size > maxBytes) {
      filesTruncated += 1;
      truncated = true;
      continue;
    }
    bytesScanned += size;

    let result;
    try {
      result = entry.extractor.extract({
        path: entry.path,
        dir: parentOf(entry.path),
        source: content,
        layout,
      });
    } catch (err) {
      // An extractor that throws has not reported the absence of imports. It
      // has failed to look, and the difference is the entire subject.
      filesUnreadable += 1;
      bucket.incomplete += 1;
      scanNotes.push(
        `extractor "${entry.extractor.id}" failed on ${entry.path}: ${(err as Error).message}`
      );
      continue;
    }

    bucket.files += 1;
    bucket.imports += result.imports.length;

    files.push({
      path: entry.path,
      extractor: entry.extractor.id,
      imports: result.imports,
      complete: result.complete,
      ...(result.note !== undefined ? { note: result.note } : {}),
    });

    if (!result.complete) {
      filesUnreadable += 1;
      bucket.incomplete += 1;
      continue;
    }

    filesScanned += 1;
    for (const found of result.imports) {
      if (found.target.kind === "package" && found.target.ecosystem === "npm") {
        imports.add(found.target.name);
      }
    }
  }

  const seen = filesScanned + filesUnreadable + filesTruncated;
  const parseCoverage = seen === 0 ? 1 : filesScanned / seen;

  if (truncated) {
    scanNotes.push(
      `scan stopped at the ${maxFiles}-file / ${maxBytes}-byte cap; ` +
        `${filesTruncated} source file(s) were not examined`
    );
  }

  const unsupportedList = [...unsupported.entries()]
    .map(([extension, count]) => ({ extension, files: count }))
    .sort((a, b) => b.files - a.files || (a.extension < b.extension ? -1 : 1));

  if (unsupportedList.length > 0) {
    const total = unsupportedList.reduce((sum, entry) => sum + entry.files, 0);
    const detail = unsupportedList.map((entry) => `${entry.extension} (${entry.files})`).join(", ");
    scanNotes.push(
      `${total} file(s) are a language arkive has no extractor for and were not ` +
        `analysed: ${detail}`
    );
  }

  const incomplete = files.filter((file) => !file.complete);
  if (incomplete.length > 0) {
    scanNotes.push(
      `${incomplete.length} file(s) were opened but not fully read; first: ` +
        `${incomplete[0].path}${incomplete[0].note ? ` (${incomplete[0].note})` : ""}`
    );
  }

  if (seen === 0) {
    scanNotes.push(
      `no analysable source files were found (extracted languages: ` +
        `${registry.languages.join(", ")}); the scan had nothing to read`
    );
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
    root: dir,
    files,
    fileIndex,
    directoryIndex,
    byLanguage,
    unsupported: unsupportedList,
    filters: { include, exclude },
    aliases: loaded.aliases.map((alias) => ({
      prefix: alias.prefix,
      targets: [...alias.targets],
    })),
    goModules: [...loaded.goModules],
    searchRoots,
    configSource: loaded.source,
  };
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Does this path survive `--include` / `--exclude`?
 *
 * A prefix match on a path-segment boundary, not a glob and not a raw
 * `startsWith`. `src` includes everything under `src` and leaves `srcgen.ts`
 * alone; matching on the boundary is the only version that does the obvious
 * thing, and the alternative would silently drop files a user did not ask to
 * drop — which is the same failure as an unnoticed narrowing, one step
 * further in.
 */
export function withinFilters(
  relPath: string,
  include: readonly string[],
  exclude: readonly string[]
): boolean {
  if (exclude.some((prefix) => isUnder(relPath, prefix))) return false;
  if (include.length === 0) return true;
  return include.some((prefix) => isUnder(relPath, prefix));
}

function isUnder(relPath: string, prefix: string): boolean {
  const normalised = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalised === "" || normalised === ".") return true;
  return relPath === normalised || relPath.startsWith(`${normalised}/`);
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

function parentOf(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
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

    rules.push({ regex: globToRegExp(pattern), negate, dirOnly });
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