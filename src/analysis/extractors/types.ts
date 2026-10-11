/**
 * The extractor contract.
 *
 * ## Why this file exists
 *
 * `docs/issues/0005-module-derivation.md` §1: "Each behind a small extractor
 * interface so a language is one file, not a branch in a walker." That is an
 * acceptance criterion, and an interface that every language still routes
 * through a `switch` in the walker does not satisfy it. It satisfies the letter
 * and reproduces the defect: adding a language still means editing shared code,
 * which means every other language's tests are the ones that break.
 *
 * So the contract is deliberately narrow, and the *walker* (`src/analysis/scanner.ts`)
 * contains no language knowledge whatsoever. It asks the registry "which
 * extractor claims `foo.py`?" and gets back an `Extractor` or `undefined`.
 * `undefined` is not an error and is not silent: the file is counted against
 * coverage, which is what makes the absence of an extractor visible.
 *
 * ## The three things a new language has to know
 *
 * 1. Which file extensions it claims (`extensions`).
 * 2. Its own id, which namespaces every `rule` it produces (`id`). A rule id
 *    that reads `ts-js/import-edge` tells a reader which language produced the
 *    claim without opening the file that did it.
 * 3. How to find its imports (`extract`), and how to classify each one as an
 *    internal module, a third-party package, or a language builtin.
 *
 * Nothing else. Resolution against the filesystem arrives through
 * `ProjectLayout`, so an extractor never calls `fs` itself.
 *
 * ## What an extractor may not do
 *
 * Return an empty import list on a file it did not understand. `complete:
 * false` is the honest answer and it costs coverage; `imports: []` is a lie
 * that costs nothing, which is exactly why the scan used to report "in sync"
 * on code it had never read.
 */

/**
 * How the specifier was written.
 *
 * Transport naming only — it never changes what an edge means, exactly as
 * `EdgeSchema.label` is documented. It is carried because it is the difference
 * between "this module is loaded eagerly" and "this module is loaded at
 * runtime", which is a question a walkthrough will eventually ask and which is
 * otherwise lost at extraction time.
 */
export type ImportForm =
  // TypeScript / JavaScript
  | "import-from"
  | "import-type"
  | "side-effect-import"
  | "re-export"
  | "dynamic-import"
  | "require"
  | "module-mock"
  // Python
  | "python-import"
  | "python-from"
  | "python-relative"
  // Go
  | "go-import"
  | "go-embed";

/**
 * What a specifier turned out to point at.
 *
 * The three cases are not decoration — each one is a different graph outcome
 * and each has a different failure mode:
 *
 * - `module` becomes a `module` node and an `imports` edge. If it does not
 *   resolve to a file on disk, the edge is still emitted and marked `dangling`,
 *   because ADR-0001 requires a broken reference to be reported rather than
 *   dropped. That is also what turns a deleted file into `critical` drift.
 * - `package` becomes an `external` node. `normalizePackage` already returns
 *   this shape for npm; the extractor only has to say which ecosystem it
 *   belongs to.
 * - `builtin` is the standard library. It produces no node and no edge, because
 *   "this project depends on `os`" is not a fact about this project.
 */
export type ImportTarget =
  | { kind: "module"; path: string; symbol?: string }
  | { kind: "package"; ecosystem: string; name: string }
  | { kind: "builtin" };

export interface ExtractedImport {
  /** The specifier exactly as written, e.g. `../analysis/scanner.js`, `.mod`, `pkg/sub`. */
  specifier: string;
  /** 1-based line the statement starts on. */
  line: number;
  /** How it was written. See `ImportForm`. */
  form: ImportForm;
  /** What it points at. */
  target: ImportTarget;
}

/**
 * Read-only view of the repository an extractor is resolving against.
 *
 * Every lookup is answered from the walk's own file index, so resolution costs
 * a `Set.has` rather than a `stat`. On a 5,000-file repository the difference
 * between the two is roughly 20,000 syscalls.
 */
export interface ProjectLayout {
  /** Absolute repository root. */
  readonly root: string;
  /** Every discovered file, repo-relative and posix-separated. */
  readonly hasFile: (relPath: string) => boolean;
  /** Every discovered directory, repo-relative and posix-separated. */
  readonly hasDirectory: (relPath: string) => boolean;
  /** Candidate import roots, repo-relative. Always includes `""` and `src`. */
  readonly searchRoots: readonly string[];
  /** Path aliases, e.g. `@/*` → `src/*`. */
  readonly aliases: readonly AliasSpec[];
  /** `module` lines from every `go.mod` under the root, longest first. */
  readonly goModules: readonly string[];
}

export interface AliasSpec {
  /** Prefix as written, e.g. `@/`. */
  readonly prefix: string;
  /** Replacement templates, e.g. `["src/*"]`. */
  readonly targets: readonly string[];
}

export interface ExtractionContext {
  /** Repo-relative, posix-separated. */
  readonly path: string;
  /** Directory containing the file, repo-relative and posix-separated. */
  readonly dir: string;
  /** File contents, decoded as UTF-8. */
  readonly source: string;
  readonly layout: ProjectLayout;
}

export interface ExtractResult {
  /** Every import site found, with its line. May be empty; that is a claim, not a default. */
  imports: ExtractedImport[];
  /**
   * `false` when the extractor could not read this file with confidence —
   * an unterminated string, a construct it deliberately skips.
   *
   * The file is then counted against `parseCoverage`, so a repository full of
   * files one extractor cannot handle reports a correspondingly partial scan
   * instead of a clean bill of health.
   */
  complete: boolean;
  /** Why it is not complete. Never set without `complete: false`. */
  note?: string;
}

export interface Extractor {
  /**
   * Stable, lowercase, kebab-case. Used to namespace `rule` ids
   * (`<id>/import-edge`) and to key the per-language coverage report, so it is
   * part of the persisted document's vocabulary and must not churn.
   */
  readonly id: string;
  /** Human name for the coverage report: "TypeScript / JavaScript". */
  readonly language: string;
  /** Package ecosystem, e.g. `npm`, `pypi`, `go`. Empty when there is none. */
  readonly ecosystem: string;
  /** Lower-case extensions this extractor claims, each including the leading dot. */
  readonly extensions: readonly string[];
  extract(ctx: ExtractionContext): ExtractResult;
}

/**
 * The rule ids an extractor emits. Namespaced with the extractor id at emission,
 * so this list is the complete vocabulary of `provenance.rule` for derived
 * elements and nothing else may invent one.
 */
export const RULE_IMPORT_EDGE = "import-edge";
export const RULE_EXTERNAL_NODE = "external-node";
export const RULE_MODULE_NODE = "module-node";