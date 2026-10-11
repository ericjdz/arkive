import { LineIndex, blankRanges } from "../source-text.js";
import { normalizePackage, isNodeBuiltin } from "./node-builtins.js";
import type {
  ExtractedImport,
  ExtractionContext,
  ExtractResult,
  Extractor,
  ImportForm,
  ImportTarget,
} from "./types.js";

/**
 * TypeScript / JavaScript import extraction.
 *
 * ## The failure this file is built around
 *
 * The old scanner used one regex over the raw file text. That regex matches
 * `import x from "y"` perfectly and also matches four things that are not
 * imports at all:
 *
 * - the same line inside a `//` comment or a `/** ... *\/` block;
 * - a `.md` file's worth of documentation pasted into a template literal;
 * - a string in a test fixture (`expect(src).toContain('import x from "y"')`);
 * - an identifier ending in `import` in a string.
 *
 * Every one of those becomes a graph edge with `evidence: ["file:line"]`
 * pointing at a line that does not import anything. That is not a small
 * inaccuracy: it is a fabricated citation, and ADR-0002's entire provenance
 * argument is that `evidence` is the thing that makes derivation trustworthy
 * rather than plausible. A wrong evidence pointer is worse than a missing edge,
 * because a missing edge is visible and a wrong pointer is not.
 *
 * So comments, string literals, and template literals (including `${}`
 * interpolations, which are code again) are blanked before anything matches.
 * The blanking preserves length and newlines exactly, so a line number is the
 * same in the blanked text and the original — which is what keeps
 * `evidence` honest rather than approximately honest.
 *
 * ## What is deliberately not handled
 *
 * Regular-expression literals. Distinguishing `/` as division from `/` as a
 * regex start needs expression context that a lexer without a parser cannot
 * have. The failure mode is bounded: a misread regex can swallow following
 * text into a comment, which costs that file its imports — and the file is
 * reported, because `complete` goes false when the stripper runs off the end
 * of the source. It cannot invent an import, because a regex body containing
 * `from "..."` and then being counted as evidence would itself need the regex
 * to be misread *and* the inner text to look like a statement.
 */
export const tsJsExtractor: Extractor = {
  id: "ts-js",
  language: "TypeScript/JavaScript",
  ecosystem: "npm",
  extensions: [
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
  ],

  extract(ctx: ExtractionContext): ExtractResult {
    const { code, complete, note } = stripJsNoise(ctx.source);

    // A file cut off mid-construct (unterminated template, truncated read) is
    // the one case where "no imports found" means "stopped looking".
    if (!complete) {
      return { imports: [], complete: false, note };
    }

    const lines = new LineIndex(ctx.source);
    const imports = collectJsImports(code, ctx, lines);

    return { imports, complete: true };
  },
};

/**
 * Blanks comments, strings, and template literals, preserving length.
 *
 * Returns `complete: false` when it reaches end-of-file still inside a string
 * or template, which is the honest signal that the rest of the file was never
 * searched. A file that parses fine inside a deliberately odd lexical state
 * (`<div className="a">{`x`}</div>` is fine; a stray backtick is not) is rarer
 * than the cost of pretending it was read.
 */
export function stripJsNoise(source: string): {
  code: string;
  complete: boolean;
  note?: string;
} {
  const length = source.length;
  const ranges: Array<[number, number]> = [];

  let i = 0;
  let unterminated: string | null = null;

  const record = (from: number, to: number): void => {
    ranges.push([from, to]);
  };

  while (i < length) {
    const ch = source[i];
    const next = i + 1 < length ? source[i + 1] : "";

    // --- comments ---------------------------------------------------------
    if (ch === "/" && next === "/") {
      const start = i;
      while (i < length && source[i] !== "\n") i += 1;
      record(start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      if (i >= length) {
        record(start, length);
        if (!unterminated) unterminated = "unterminated block comment";
        break;
      }
      i += 2;
      record(start, i);
      continue;
    }

    // --- regular expression literals -------------------------------------
    //
    // Only needed so that a quote inside a character class — `[^;'"]` — is not
    // read as the start of a string. Without this, a regex containing both
    // quote characters desynchronises the stripper for the rest of the file and
    // the file's coverage drops for no reason.
    //
    // Distinguishing a regex from division needs expression context, which a
    // lexer without a parser does not have. The heuristic below is the standard
    // one: a `/` begins a regex unless the previous significant token could end
    // an expression. It is wrong occasionally, and being wrong here can only
    // cost a false negative inside the regex body — it cannot invent an import.
    if (ch === "/") {
      const previous = lastSignificant(source, i);
      if (previous !== null && REGEX_CANNOT_FOLLOW.has(previous)) {
        i += 1;
        continue;
      }
      const start = i;
      i += 1;
      let closed = false;
      let inClass = false;
      while (i < length) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed && i >= length && unterminated === null) {
        unterminated = "unterminated regular expression literal at end of file";
      }
      if (!closed) record(start, Math.min(i, length));
      continue;
    }

    // --- string literals --------------------------------------------------
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        // A raw newline inside a single-quoted string is legal in JS only via a
        // line continuation, which consumes the backslash above. So an unescaped
        // newline means the literal never closed on this line.
        if (c === "\n") break;
        if (c === quote) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed && unterminated === null) {
        if (i >= length) {
          // Ran to end of file: the file is truncated or malformed, and nothing
          // after this point was searched. That is a real coverage loss and is
          // reported as one.
          unterminated = `unterminated ${quote === '"' ? "double" : "single"}-quoted string at end of file`;
        }
        // Otherwise the quote closed at the newline and scanning resumes there,
        // which is the JSX-text case (`You've`) and the apostrophe-in-a-comment
        // case. Neither hides an import: a one-line string cannot contain a
        // statement, and the one thing inside one that looks like an import is
        // the fixture pattern this function exists to *suppress*. Charging the
        // file for it would train the reader to ignore the coverage number.
      }
      // An import specifier *is* a string literal, so blanking every literal
      // would delete every import and the extractor would report zero on every
      // file — a total, silent failure of the exact kind this file exists to
      // avoid. Blanking is therefore selective: a literal in import position is
      // kept, everything else is blanked so that a fixture containing the text
      // `import x from "y"` as a string value cannot become an edge.
      if (!isSpecifierContext(source, start)) {
        record(start, Math.min(i, length));
      }
      continue;
    }

    // --- template literals, including ${} interpolation -------------------
    if (ch === "`") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        const c = source[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "`") {
          i += 1;
          closed = true;
          break;
        }
        if (c === "$" && next === "{") {
          // Interpolation is code again. Recurse by falling through: scan the
          // balanced braces with the same rules, including nested templates.
          i += 2;
          let depth = 1;
          while (i < length && depth > 0) {
            const inner = source[i];
            if (inner === "{") {
              depth += 1;
              i += 1;
              continue;
            }
            if (inner === "}") {
              depth -= 1;
              i += 1;
              continue;
            }
            if (inner === '"' || inner === "'" || inner === "`") {
              const nested = skipNestedLiteral(source, i);
              record(i, nested.end);
              if (!nested.closed && !unterminated) unterminated = "unterminated template interpolation";
              i = nested.end;
              continue;
            }
            if (inner === "/" && source[i + 1] === "/") {
              const commentStart = i;
              while (i < length && source[i] !== "\n") i += 1;
              record(commentStart, i);
              continue;
            }
            if (inner === "/" && source[i + 1] === "*") {
              const commentStart = i;
              const closedComment = source.indexOf("*/", i + 2);
              const end = closedComment === -1 ? length : closedComment + 2;
              record(commentStart, end);
              i = end;
              continue;
            }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      if (!closed && !unterminated) unterminated = "unterminated template literal";
      record(start, Math.min(i, length));
      continue;
    }

    i += 1;
  }

  return {
    code: blankRanges(source, ranges),
    complete: unterminated === null,
    note: unterminated ?? undefined,
  };
}

/**
 * Tokens after which a `/` is division rather than the start of a regex.
 *
 * Anything not in this set means "a regex may start here". The list is the
 * standard one and covers every case in real source; the failure mode of
 * getting it wrong is bounded and one-directional, which is noted on the
 * caller.
 */
const REGEX_CANNOT_FOLLOW: ReadonlySet<string> = new Set([
  ")", "]", "}", "++", "--", "+", "-", "*", "%", "&", "|", "^", "~", "!", "=", "<", ">",
  "==", "!=", "===", "!==", "<=", ">=", "&&", "||", "??", "=>", "*=", "/=", "%=", "+=",
  "-=", "&=", "|=", "^=", "<<", ">>", ">>>", "**", "this", "true", "false", "null",
  "undefined", "super",
]);

/** The last significant character before `at`, skipping whitespace and comments. */
function lastSignificant(source: string, at: number): string | null {
  let i = at - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return null;

  // A comment ends just before `at`, so walk back over it.
  if (source[i] === "/" && source[i - 1] === "*") {
    const open = source.lastIndexOf("/*", i - 1);
    return open === -1 ? null : lastSignificant(source, open);
  }
  if (i >= 1 && source[i - 1] === "/" && source[i - 2] === "/") {
    const lineStart = source.lastIndexOf("\n", i - 2);
    return lastSignificant(source, lineStart === -1 ? 0 : lineStart + 1);
  }

  // Identifiers and keywords come back whole; operators come back one char.
  if (/[A-Za-z0-9_$]/.test(source[i])) {
    let start = i;
    while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1;
    return source.slice(start, i + 1);
  }
  const two = source.slice(Math.max(0, i - 1), i + 1);
  return REGEX_CANNOT_FOLLOW.has(two) ? two : source[i];
}

/**
 * Does this specifier fall under this alias prefix?
 *
 * The prefix is matched on its *head*, before any `*`: a config declaring
 * `"@/*"` describes everything under `@/`, and testing the literal string
 * `"@/*"` against `"@/util"` fails. Getting this wrong files every aliased
 * import as a third-party package named `@`, which is a fabricated dependency
 * and a graph edge to a package that does not exist.
 */
function aliasMatches(specifier: string, prefix: string): boolean {
  const star = prefix.indexOf("*");
  if (star === -1) return specifier.startsWith(prefix);
  const head = prefix.slice(0, star);
  const tail = prefix.slice(star + 1);
  if (!specifier.startsWith(head)) return false;
  return tail.length === 0 || specifier.endsWith(tail);
}

/**
 * Is the literal opening at `at` an import specifier?
 *
 * Reads the 48 characters before the opening quote and asks whether they end in
 * an import position: `from`, `import`, `require(`, `import(`, `vi.mock(`.
 *
 * This is a lexical heuristic and it is deliberately narrow. A loose version
 * that treated "any identifier followed by `(`" as import position would keep
 * every string passed to every function, which reintroduces the fixture
 * false positive it is here to prevent. A tight version that missed a case
 * deletes a real edge, which is visible in the graph and fixable; keeping the
 * list explicit is what makes the miss list short and reviewable.
 */
function isSpecifierContext(source: string, at: number): boolean {
  const before = source.slice(Math.max(0, at - 48), at).replace(/\s+$/, "");
  if (before === "") return false;
  if (/\b(?:from|import|require)$/.test(before)) return true;
  if (/\b(?:require|import)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\($/.test(before)) return true;
  if (/\b(?:mock|unmock|doMock|doUnmock|unstable_mockModule|create)\s*\($/.test(before)) {
    return true;
  }
  return false;
}

/** Skips one `"`, `'`, or `` ` `` literal starting at `start`. */
function skipNestedLiteral(
  source: string,
  start: number
): { end: number; closed: boolean } {
  const length = source.length;
  const quote = source[start];
  let i = start + 1;
  while (i < length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote !== "`" && c === "\n") return { end: i, closed: false };
    if (c === quote) return { end: i + 1, closed: true };
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < length && depth > 0) {
        const inner = source[i];
        if (inner === "{") {
          depth += 1;
          i += 1;
        } else if (inner === "}") {
          depth -= 1;
          i += 1;
        } else if (inner === quote) {
          const nested = skipNestedLiteral(source, i);
          i = nested.end;
        } else {
          i += 1;
        }
      }
      continue;
    }
    i += 1;
  }
  return { end: length, closed: false };
}

/**
 * The import forms. Each carries its own capture layout and they are applied in
 * order of specificity, because `export ... from` and `import ... from` share
 * a shape and `import("x")` is a prefix of nothing else.
 */
const IMPORT_PATTERNS: ReadonlyArray<{
  form: ImportForm | ((text: string) => ImportForm);
  regex: RegExp;
  /** Index of the capture group holding the specifier. */
  group: number;
}> = [
  // export ... from "x"  /  export * from "x"  /  import ... from "x"
  //
  // `from` is *required* here. Making the clause optional would also match
  // `import "x"` — which the side-effect pattern below already handles — and
  // produce two import sites for one statement. That inflates the per-language
  // import count and, more importantly, makes the same line appear as evidence
  // twice for reasons a reader could not reconstruct.
  {
    form: (text) => (/^\s*export/.test(text) ? "re-export" : "import-from"),
    regex: /\b(import|export)\s+(type\s+)?[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    group: 3,
  },
  // import "x" — side-effect only, no binding
  {
    form: "side-effect-import",
    regex: /\bimport\s+['"]([^'"]+)['"]/g,
    group: 1,
  },
  // import("x") — dynamic
  {
    form: "dynamic-import",
    regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    group: 1,
  },
  // require("x") — CJS
  {
    form: "require",
    regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    group: 1,
  },
];

function collectJsImports(
  code: string,
  ctx: ExtractionContext,
  lines: LineIndex
): ExtractedImport[] {
  const found: ExtractedImport[] = [];

  for (const { form, regex, group } of IMPORT_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(code)) !== null) {
      const specifier = match[group];
      if (specifier === undefined || specifier === "") continue;

      const resolvedForm =
        typeof form === "function"
          ? (match[1] === "export" ? "re-export" : match[2] ? "import-type" : form(match[0]))
          : form;

      found.push({
        specifier,
        line: lines.lineAt(match.index),
        form: resolvedForm,
        target: classifyJsSpecifier(specifier, ctx.layout),
      });
    }
  }

  return found;
}

/**
 * Relative, aliased, or bare?
 *
 * The split matters because the three produce different graph elements and,
 * more importantly, three different *failure modes*. A bare specifier that is
 * really a workspace package resolves to nothing on disk and becomes a dangling
 * `imports` edge — reported, never dropped. Getting this wrong in the other
 * direction (calling a real dependency "relative") would delete a legitimate
 * edge from the graph, which is the 62066bc shape.
 */
function classifyJsSpecifier(specifier: string, layout: { aliases: readonly { prefix: string }[] }): ImportTarget {
  if (specifier.startsWith(".")) {
    return { kind: "module", path: specifier };
  }

  if (isNodeBuiltin(specifier)) {
    return { kind: "builtin" };
  }

  for (const alias of layout.aliases) {
    if (aliasMatches(specifier, alias.prefix)) {
      return { kind: "module", path: specifier };
    }
  }

  const packageName = normalizePackage(specifier);
  if (packageName === null) {
    // An absolute or otherwise unclassifiable specifier. Not a module we can
    // resolve, not a package we can name — treated as a module so resolution
    // tries and reports rather than silently dropping it.
    return { kind: "module", path: specifier };
  }
  return { kind: "package", ecosystem: "npm", name: packageName };
}