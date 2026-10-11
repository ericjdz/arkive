import type {
  ExtractedImport,
  ExtractionContext,
  ExtractResult,
  Extractor,
  ImportForm,
  ImportTarget,
} from "./types.js";

/**
 * Python import extraction.
 *
 * ## Why Python is not the JS problem with different syntax
 *
 * Three traps that do not exist in JS:
 *
 * 1. **Relative imports.** `from . import x`, `from ..pkg.mod import y`. The
 *    number of leading dots is an *ascent from the current package*, and the
 *    current package is `__init__.py`-based, not directory-based — a module in
 *    a directory with no `__init__.py` cannot use a relative import at all.
 *    Getting the ascent wrong produces edges to files that do not exist.
 * 2. **Search roots.** A module at `src/pkg/mod.py` is package `pkg`, not
 *    `src.pkg`. Without stripping the root, `from . import x` resolves to
 *    `src` and every relative import in a src-layout project dangles.
 * 3. **Docstrings.** A module's first statement is very often a string literal
 *    containing the text `import os`, and a plain regex reports it.
 *
 * ## Stdlib
 *
 * `sys.stdlib_module_names` is not reachable from a Node process, so the set is
 * carried here. It is a snapshot and it will drift; a module added to a later
 * Python would be reported as a PyPI package rather than dropped. That is the
 * safe direction to be wrong in — a node a human can delete, not an edge that
 * is missing without saying so.
 */
export const pythonExtractor: Extractor = {
  id: "python",
  language: "Python",
  ecosystem: "pypi",
  extensions: [".py", ".pyi"],

  extract(ctx: ExtractionContext): ExtractResult {
    const code = blankPythonLiterals(ctx.source);
    const imports: ExtractedImport[] = [];

    code.split("\n").forEach((rawLine, index) => {
      const line = index + 1;
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;

      // `import a.b.c as d, e.f`
      const plain = /^import\s+(.+)$/.exec(trimmed);
      if (plain !== null) {
        for (const clause of plain[1].split(",")) {
          const name = clause.trim().split(/\s+as\s+/)[0].trim();
          if (name.length === 0) continue;
          imports.push({
            specifier: name,
            line,
            form: "python-import",
            target: classifyAbsolute(name, ctx),
          });
        }
        return;
      }

      // `from .mod import x` / `from . import x` / `from a.b import c`
      const from = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(trimmed);
      if (from === null) return;

      const specifier = from[1];
      const level = /^\.+/.exec(specifier)?.[0].length ?? 0;
      const tail = specifier.replace(/^\.+/, "");
      const imported = firstImportedName(from[2]);

      imports.push({
        specifier,
        line,
        form: level > 0 ? "python-relative" : "python-from",
        target:
          level > 0
            ? classifyRelative(tail, imported, level, ctx)
            : classifyAbsolute(tail.length > 0 ? tail : imported ?? "", ctx, imported),
      });
    });

    return { imports, complete: true };
  },
};

/**
 * `from a.b import c` where `c` names a module rather than a symbol cannot be
 * told apart from `from a.b import c` where `c` is a symbol without resolving
 * the filesystem. The first name is therefore emitted with the package's own
 * path and, where it turns out to be a module, with the symbol attached.
 */
function firstImportedName(clause: string): string | undefined {
  const first = clause.split(",")[0]?.trim();
  if (first === undefined || first === "*") return undefined;
  const name = first.split(/\s+as\s+/)[0].trim();
  return name.length > 0 ? name : undefined;
}

function classifyAbsolute(specifier: string, ctx: ExtractionContext, symbol?: string): ImportTarget {
  if (specifier.length === 0) return { kind: "builtin" };

  const root = specifier.split(".")[0];
  if (PYTHON_STDLIB.has(root)) return { kind: "builtin" };

  const resolved = resolvePythonModule(specifier, ctx);
  if (resolved !== null) {
    return { kind: "module", path: resolved, ...(symbol !== undefined ? { symbol } : {}) };
  }
  return { kind: "package", ecosystem: "pypi", name: root };
}

/**
 * `from ..pkg.mod import x`.
 *
 * Dots ascend from the current package. The current package is the importing
 * file's directory expressed relative to whichever search root it sits under,
 * which is why `layout.searchRoots` is consulted first — without it, a project
 * laid out as `src/` resolves every relative import one level too deep.
 */
function classifyRelative(
  tail: string,
  imported: string | undefined,
  level: number,
  ctx: ExtractionContext
): ImportTarget {
  const root = matchingSearchRoot(ctx);
  const dirParts = ctx.dir.split("/").filter(Boolean);
  const rootParts = root.length === 0 ? [] : root.split("/").filter(Boolean);
  const packageParts = dirParts.slice(rootParts.length);

  // `from . import x` names the module `x` inside the current package, so the
  // imported name becomes part of the path rather than a symbol.
  const tailParts = tail.length > 0 ? tail.split(".") : [];
  const ascent = packageParts.slice(0, Math.max(0, packageParts.length - (level - 1)));
  const segments = [...ascent, ...tailParts];
  if (segments.length === 0 && imported !== undefined) segments.push(imported);

  return { kind: "module", path: segments.join("/") };
}

/** The longest search root this file sits under. */
function matchingSearchRoot(ctx: ExtractionContext): string {
  let best = "";
  for (const root of ctx.layout.searchRoots) {
    if (root === "") continue;
    if (ctx.dir === root || ctx.dir.startsWith(`${root}/`)) {
      if (root.length > best.length) best = root;
    }
  }
  return best;
}

/** Repository path of an absolute dotted module, or `null` if it is not in the repo. */
function resolvePythonModule(specifier: string, ctx: ExtractionContext): string | null {
  const segments = specifier.split(".");
  for (const root of ctx.layout.searchRoots) {
    const base = root.length === 0 ? segments.join("/") : `${root}/${segments.join("/")}`;
    if (ctx.layout.hasFile(`${base}.py`)) return base;
    if (ctx.layout.hasDirectory(base)) return base;
  }
  return null;
}

/**
 * Blank `#` comments and string literals, preserving newlines.
 *
 * Quote *runs* are detected rather than a `"""`-style pattern, because a
 * docstring may legally contain a triple-quote sequence in its content and a
 * pattern match would un-blank the remainder of the file.
 */
export function blankPythonLiterals(source: string): string {
  const length = source.length;
  const ranges: Array<[number, number]> = [];
  let i = 0;

  while (i < length) {
    const ch = source[i];

    if (ch === "#") {
      const start = i;
      while (i < length && source[i] !== "\n") i += 1;
      ranges.push([start, i]);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      const triple = source.slice(i, i + 3) === ch.repeat(3);
      const quote = triple ? ch.repeat(3) : ch;
      i += quote.length;
      while (i < length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source.slice(i, i + quote.length) === quote) {
          i += quote.length;
          break;
        }
        if (!triple && source[i] === "\n") break;
        i += 1;
      }
      ranges.push([start, Math.min(i, length)]);
      continue;
    }

    i += 1;
  }

  if (ranges.length === 0) return source;

  const ordered = ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ordered) {
    if (start > cursor) parts.push(source.slice(cursor, start));
    parts.push(source.slice(start, end).replace(/[^\n]/g, " "));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

/** Python 3.11 `sys.stdlib_module_names`, top-level names only. */
const PYTHON_STDLIB: ReadonlySet<string> = new Set([
  "__future__", "_abc", "_ast", "_asyncio", "_bisect", "_blake2", "_bz2",
  "_codecs", "_collections", "_collections_abc", "_compat_pickle",
  "_compression", "_contextvars", "_csv", "_ctypes", "_curses", "_datetime",
  "_decimal", "_elementtree", "_frozen_importlib", "_functools", "_hashlib",
  "_heapq", "_imp", "_io", "_json", "_locale", "_lzma", "_md5",
  "_multibytecodec", "_multiprocessing", "_opcode", "_operator", "_osx_support",
  "_pickle", "_posixshmem", "_posixsubprocess", "_py_abc", "_pydecimal", "_pyio",
  "_queue", "_random", "_sha1", "_sha256", "_sha3", "_sha512", "_signal",
  "_sitebuiltins", "_socket", "_sqlite3", "_sre", "_ssl", "_stat", "_statistics",
  "_string", "_strptime", "_struct", "_symtable", "_thread",
  "_threading_local", "_tkinter", "_tokenize", "_tracemalloc", "_typing",
  "_uuid", "_warnings", "_weakref", "_weakrefset", "_zoneinfo",
  "abc", "aifc", "antigravity", "argparse", "array", "ast", "asynchat",
  "asyncio", "asyncore", "atexit", "audioop", "base64", "bdb", "binascii",
  "bisect", "builtins", "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk",
  "cmath", "cmd", "code", "codecs", "codeop", "collections", "colorsys",
  "compileall", "concurrent", "configparser", "contextlib", "contextvars",
  "copy", "copyreg", "crypt", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "distutils", "doctest",
  "email", "encodings", "ensurepip", "enum", "errno", "faulthandler", "fcntl",
  "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools", "gc",
  "genericpath", "getopt", "getpass", "gettext", "glob", "graphlib", "grp",
  "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "lib2to3",
  "linecache", "locale", "logging", "lzma", "mailbox", "mailcap", "marshal",
  "math", "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt",
  "multiprocessing", "netrc", "nis", "nntplib", "ntpath", "nturl2path",
  "numbers", "opcode", "operator", "optparse", "os", "ossaudiodev", "pathlib",
  "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform", "plistlib",
  "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd",
  "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random", "re",
  "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets",
  "select", "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtpd",
  "smtplib", "sndhdr", "socket", "socketserver", "spwd", "sqlite3",
  "sre_compile", "sre_constants", "sre_parse", "ssl", "stat", "statistics",
  "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
  "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile",
  "termios", "textwrap", "this", "threading", "time", "timeit", "tkinter",
  "token", "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty",
  "turtle", "types", "typing", "unicodedata", "unittest", "urllib", "uu",
  "uuid", "venv", "warnings", "wave", "weakref", "webbrowser", "winreg",
  "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);