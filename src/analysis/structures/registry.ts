import { tsStructureExtractor } from "./ts-types.js";
import { zodStructureExtractor } from "./zod.js";
import type { StructureExtractor } from "./types.js";

/**
 * The structure-extractor registry.
 *
 * ## Why this is not `ExtractorRegistry`
 *
 * `src/analysis/extractors/registry.ts:47-60` **throws** when two extractors
 * claim one extension, and that is right for imports: one language means one set
 * of specifiers, and a second claimant would silently stop one of them running.
 *
 * Data structures invert that. A single `.ts` file declares TypeScript
 * interfaces *and* Zod schemas, and both are real shapes with different fields
 * and different evidence. Forcing them apart would mean one extension per
 * format, which means `ts-types` claiming `.ts` and Zod claiming `.ts.zod`, and
 * neither of those files exists in any real project.
 *
 * So this registry **runs every extractor that claims a path** and returns the
 * lot. The cost is that two extractors can both find nothing in a file, and the
 * mitigation is coverage rather than a guard: a file no extractor claims is
 * counted against `structureCoverage`, and a file an extractor claims and
 * fails to read is counted against it too. A format nobody wrote therefore shows
 * up as a lower number, which is the honest direction to be wrong in.
 *
 * ## What "adding a format is one file" means here
 *
 * One array entry. `derive.ts` asks the registry for every extractor claiming
 * `path` and iterates the result; it contains no format names, and neither does
 * the walker. `tests/analysis/structures/registry.test.ts` registers a format
 * nobody has written — `sql-ddl`, claiming `.sql` — runs a full derivation over a
 * fixture written in it, and asserts the graph came out correct with nothing else
 * changed. If any of that needed a second file, the test fails.
 */
export function createStructureRegistry(
  extractors: readonly StructureExtractor[] = DEFAULT_STRUCTURE_EXTRACTORS
): StructureRegistry {
  return new StructureRegistry(extractors);
}

export class StructureRegistry {
  private readonly byExtension = new Map<string, StructureExtractor[]>();
  private readonly byId = new Map<string, StructureExtractor>();
  readonly extractors: readonly StructureExtractor[];

  constructor(extractors: readonly StructureExtractor[]) {
    this.extractors = extractors;
    for (const extractor of extractors) {
      this.byId.set(extractor.id, extractor);
      for (const extension of extractor.extensions) {
        const key = extension.toLowerCase();
        const existing = this.byExtension.get(key);
        if (existing === undefined) this.byExtension.set(key, [extractor]);
        else existing.push(extractor);
      }
    }
  }

  /**
   * Every extractor claiming this path, in registration order.
   *
   * An empty array means arkive reads this file's imports but has no way to read
   * its shapes. That is counted, not ignored — see the file comment.
   */
  forPath(path: string): readonly StructureExtractor[] {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    if (dot === -1 || dot < slash) return [];
    return this.byExtension.get(path.slice(dot).toLowerCase()) ?? [];
  }

  get(id: string): StructureExtractor | undefined {
    return this.byId.get(id);
  }

  get ids(): readonly string[] {
    return [...this.byId.keys()];
  }

  get formats(): readonly string[] {
    return this.extractors.map((extractor) => extractor.format);
  }

  /** Every extension any registered structure extractor claims. */
  get extensions(): readonly string[] {
    return [...this.byExtension.keys()].sort();
  }
}

/**
 * The built-in set.
 *
 * Order is declaration order, not priority. Both built-ins claim `.ts` and both
 * run; `ts-types` finds interfaces and type aliases, `zod` finds object schemas,
 * and a file with both yields structures from both. Neither suppresses the other,
 * and a schema whose name shadows a type alias is recorded twice under two
 * different ids rather than merged — see `structureNodeId` in `derive.ts`.
 */
export const DEFAULT_STRUCTURE_EXTRACTORS: readonly StructureExtractor[] = [
  tsStructureExtractor,
  zodStructureExtractor,
];

export const defaultStructureRegistry: StructureRegistry = createStructureRegistry();