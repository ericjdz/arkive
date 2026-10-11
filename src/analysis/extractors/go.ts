import type {
  ExtractedImport,
  ExtractionContext,
  ExtractResult,
  Extractor,
  ImportForm,
  ImportTarget,
} from "./types.js";

/**
 * Go import extraction.
 *
 * ## The parts of Go that make this harder than the syntax suggests
 *
 * - **A bare identifier is not always stdlib.** `import "net/http"` is stdlib;
 *   `import "example.com/api/internal/store"` is a third party; and
 *   `import "github.com/org/project/internal/store"` may be *this* repository,
 *   if `go.mod` says `module github.com/org/project`. Go has no marker that
 *   distinguishes the third case. Getting it wrong in the direction of "external"
 *   turns your own code into a dependency you do not have, which produces a
 *   clean-looking graph that lies; so the module path from `go.mod` is checked
 *   first, and the fallback is `stdlib` only when the first path segment is a
 *   known standard-library name.
 * - Line and block comments, same as everything else.
 * - **Backtick raw strings**, which contain no escapes at all — a backtick
 *   scanning for `\\"` would run to the end of the file.
 * - **Dot and blank imports.** `_ "embed"` and `. "internal/testutil"` are real
 *   imports with real consequences; they are recorded with the same shape as
 *   any other and the alias is carried on the specifier for a reader.
 */
export const goExtractor: Extractor = {
  id: "go",
  language: "Go",
  ecosystem: "go",
  extensions: [".go"],

  extract(ctx: ExtractionContext): ExtractResult {
    const { code } = blankGoNoise(ctx.source);
    const imports: ExtractedImport[] = [];

    // Both `import "x"` and the parenthesised block. The block form is read
    // line-wise rather than by matching across the whole file so that a
    // truncated file still yields the lines it did contain.
    const single = /^import\s+(?:([A-Za-z_.][\w.]*|_|\.)\s+)?"([^"]+)"\s*$/gm;
    const block = /^import\s*\(([\s\S]*?)^\)/gm;

    const record = (raw: string, line: number): void => {
      // Inside a block, a line is `<optional alias> "<path>"`.
      const parsed = /^(?:([A-Za-z_.][\w.]*|_|\.)\s+)?"([^"]+)"\s*$/.exec(raw);
      if (parsed === null) return;
      const specifier = parsed[2];
      const alias = parsed[1];
      imports.push({
        specifier: alias ? `${alias} ${specifier}` : specifier,
        line,
        form: "go-import",
        target: classifyGo(specifier, alias === "_" ? "blank" : undefined, ctx),
      });
    };

    const consumeBlock = (body: string, startLine: number): void => {
      body.split("\n").forEach((raw, offset) => {
        const text = raw.trim();
        if (text.length === 0) return;
        record(text, startLine + offset);
      });
    };

    block.lastIndex = 0;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = block.exec(code)) !== null) {
      consumeBlock(blockMatch[1], lineOf(code, blockMatch.index));
    }

    // Remove block bodies so the single-line form cannot match inside them.
    const withoutBlocks = code.replace(block, (match: string) => match.replace(/[^\n]/g, " "));
    single.lastIndex = 0;
    let singleMatch: RegExpExecArray | null;
    while ((singleMatch = single.exec(withoutBlocks)) !== null) {
      imports.push({
        specifier: singleMatch[1] ? `${singleMatch[1]} ${singleMatch[2]}` : singleMatch[2],
        line: lineOf(withoutBlocks, singleMatch.index),
        form: "go-import",
        target: classifyGo(
          singleMatch[2],
          singleMatch[1] === "_" ? "blank" : undefined,
          ctx
        ),
      });
    }

    imports.sort((a, b) => a.line - b.line);
    return { imports, complete: true };
  },
};

/**
 * The three-way decision described at the top of the file, in the order that
 * keeps a repository's own packages from being filed as dependencies.
 */
function classifyGo(
  specifier: string,
  alias: "blank" | undefined,
  ctx: ExtractionContext
): ImportTarget {
  // 1. This repository's own module path prefix.
  for (const module of ctx.layout.goModules) {
    if (specifier === module) {
      return { kind: "module", path: "" };
    }
    if (specifier.startsWith(`${module}/`)) {
      return { kind: "module", path: specifier.slice(module.length + 1) };
    }
  }

  const firstSegment = specifier.split("/")[0];

  // 2. Standard library: no dot in the first segment and a known name.
  if (!firstSegment.includes(".") && GO_STDLIB.has(firstSegment)) {
    return { kind: "builtin" };
  }

  // 3. Everything else with a domain-like first segment is a module path, and
  //    the Go convention says a first segment containing a dot is never stdlib.
  if (firstSegment.includes(".")) {
    return { kind: "package", ecosystem: "go", name: specifier };
  }

  // 4. A single-word path that is not stdlib and not ours: still an external
  //    package. Aliases do not change this — `alias "x/y"` is a rename.
  void alias;
  return { kind: "package", ecosystem: "go", name: specifier };
}

/**
 * Line of a byte offset, computed on demand.
 *
 * Extraction is not on the hot path the way the walk is, and this keeps the
 * per-line loop allocation-free; `LineIndex` would allocate an array per file.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Blank comments, interpreted string literals, and raw string literals.
 *
 * Go raw strings are backtick-delimited with no escape processing whatsoever,
 * so an unterminated one is a real possibility in a truncated file and the
 * scanner says so rather than quietly blanking the remainder.
 */
export function blankGoNoise(source: string): {
  code: string;
  complete: boolean;
  note?: string;
} {
  const length = source.length;
  const ranges: Array<[number, number]> = [];
  let i = 0;
  let unterminated: string | null = null;

  while (i < length) {
    const ch = source[i];

    if (ch === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < length && source[i] !== "\n") i += 1;
      ranges.push([start, i]);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const start = i;
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? length : end + 2;
      if (end === -1 && !unterminated) unterminated = "unterminated block comment";
      ranges.push([start, stop]);
      i = stop;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        if (source[i] === "`") {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed && !unterminated) unterminated = "unterminated raw string";
      // A raw string cannot contain an import line at the start of a line
      // without a literal newline in it, so leaving it visible costs nothing and
      // blanking it would be a large allocation for no benefit.
      ranges.push([start, i]);
      continue;
    }
    if (ch === '"') {
      // Skipped over, but deliberately *not* blanked: a Go import specifier is
      // itself a string literal, and the whole matching step depends on the
      // quotes and the text between them surviving. Skipping is what stops a
      // `//` inside a string from being read as a comment; blanking is not
      // needed, because the import patterns are line-anchored and a string
      // containing a line that starts with `import` is not a thing Go permits
      // without an explicit newline inside the literal.
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "\n") break;
        if (source[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed && !unterminated) unterminated = "unterminated interpreted string";
      void start;
      continue;
    }
    // A rune literal, `'x'` or `'\n'`. Skipped so that a `'` inside a
    // character class or a comment-like construct cannot desynchronise the
    // scanner for the rest of the file.
    if (ch === "'") {
      const start = i;
      i += 1;
      if (source[i] === "\\") i += 2;
      else i += 1;
      if (source[i] === "'") i += 1;
      ranges.push([start, i]);
      continue;
    }

    i += 1;
  }

  const ordered = ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ordered) {
    if (start > cursor) parts.push(source.slice(cursor, start));
    parts.push(source.slice(start, end).replace(/[^\n]/g, " "));
    cursor = end;
  }
  parts.push(source.slice(cursor));

  return {
    code: parts.join(""),
    complete: unterminated === null,
    note: unterminated ?? undefined,
  };
}

/**
 * Standard-library package names.
 *
 * Go's own rule is that a first path segment without a dot *may* be stdlib, but
 * "may" is not decidable from the syntax alone. This set makes it decidable for
 * every package that has shipped a stdlib release; a hypothetical stdlib package
 * added later is reported as an external module, which is the visible direction
 * to be wrong in.
 */
const GO_STDLIB: ReadonlySet<string> = new Set([
  "archive", "bufio", "builtin", "bytes", "cmp", "compress", "container", "context",
  "crypto", "database", "debug", "embed", "encoding", "errors", "expvar", "flag",
  "fmt", "go", "hash", "html", "image", "index", "io", "iter", "log", "maps",
  "math", "mime", "net", "os", "path", "plugin", "reflect", "regexp", "runtime",
  "slices", "sort", "strconv", "strings", "structs", "sync", "syscall", "testing",
  "text", "time", "unicode", "unique", "unsafe", "weak",
]);