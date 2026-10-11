import { tsJsExtractor } from "./ts-js.js";
import { pythonExtractor } from "./python.js";
import { goExtractor } from "./go.js";
import type { Extractor } from "./types.js";

/**
 * The registry.
 *
 * ## What "adding a language is one file" means here, precisely
 *
 * This file is the *only* shared module a new language touches, and the touch
 * is one array entry. The walker (`src/analysis/scanner.ts`) has no notion of
 * languages at all: it calls `registry.forPath("main.go")` and either gets an
 * extractor or gets `undefined`, which it counts against coverage. There is no
 * `if (ext === ".py")` anywhere outside the extractor that owns `.py`.
 *
 * To prove it rather than assert it, `tests/analysis/registry.test.ts` writes a
 * brand-new extractor for a language nothing else knows about (`ExampleScript`),
 * registers it, and runs a full derivation over a fixture repo — then asserts
 * the graph came out identical to a hand-written expectation. If any of that
 * needed a second file, the test fails.
 *
 * ## Why registration is explicit rather than directory-scanned
 *
 * An automatic scan of `src/analysis/extractors/` would remove the array entry,
 * and it was rejected for a reason worth recording: the package is bundled by
 * tsup into a single `dist/analysis/*.js`, so a runtime directory scan finds
 * nothing in the published build and silently falls back to... nothing. A
 * derived-from-the-filesystem registry is only correct in the source tree, and
 * the source tree is not what users run. The import list is therefore the
 * thing that survives bundling, and it is the thing that ships.
 */
export function createRegistry(extractors: readonly Extractor[] = DEFAULT_EXTRACTORS): ExtractorRegistry {
  return new ExtractorRegistry(extractors);
}

export class ExtractorRegistry {
  private readonly byExtension = new Map<string, Extractor>();
  private readonly byId = new Map<string, Extractor>();
  readonly extractors: readonly Extractor[];

  constructor(extractors: readonly Extractor[]) {
    this.extractors = extractors;
    for (const extractor of extractors) {
      this.byId.set(extractor.id, extractor);
      for (const extension of extractor.extensions) {
        const key = extension.toLowerCase();
        const existing = this.byExtension.get(key);
        if (existing !== undefined) {
          throw new Error(
            `arkive: extractors "${existing.id}" and "${extractor.id}" both claim ` +
              `"${key}". Two languages owning one extension means one of them ` +
              `silently stops running, which is the failure coverage reporting exists ` +
              `to make visible.`
          );
        }
        this.byExtension.set(key, extractor);
      }
    }
  }

  /** The extractor that owns this path, or `undefined` if nothing does. */
  forPath(path: string): Extractor | undefined {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    if (dot === -1 || dot < slash) return undefined;
    return this.byExtension.get(path.slice(dot).toLowerCase());
  }

  get(id: string): Extractor | undefined {
    return this.byId.get(id);
  }

  get ids(): readonly string[] {
    return [...this.byId.keys()];
  }

  get languages(): readonly string[] {
    return this.extractors.map((extractor) => extractor.language);
  }

  /** Every extension any registered extractor claims. Used for auto-detection. */
  get extensions(): readonly string[] {
    return [...this.byExtension.keys()].sort();
  }
}

/**
 * The built-in set.
 *
 * Registration order is the order a language claims an ambiguous path, and
 * since duplicate claims throw at construction, order here is documentation
 * rather than behaviour.
 */
export const DEFAULT_EXTRACTORS: readonly Extractor[] = [
  tsJsExtractor,
  pythonExtractor,
  goExtractor,
];

/** The registry a scan uses when the caller does not supply one. */
export const defaultRegistry: ExtractorRegistry = createRegistry();