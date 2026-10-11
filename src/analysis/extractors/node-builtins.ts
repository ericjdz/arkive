/**
 * npm package identity and the Node builtin set.
 *
 * Extracted from `src/analysis/scanner.ts` so that `ts-js.ts` can classify a
 * specifier without importing the walker. Importing the walker from an
 * extractor would close a cycle (`scanner` → `registry` → `ts-js` →
 * `scanner`) and the whole point of the extractor boundary is that the walker
 * has no language knowledge to share back.
 */

/**
 * Module specifiers that are known at analysis time and are not dependencies.
 *
 * Only the unqualified form is listed. `node:fs` is handled separately because
 * the `node:` prefix makes the intent explicit and the name after it is
 * arbitrary — `node:anything` is a builtin specifier whether or not `anything`
 * is on this list.
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "sys", "test", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

/** `true` for `fs` and for `node:fs`; `false` for `fs/promises` and `pkg`. */
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith("@") || specifier.includes("/")) return false;
  return NODE_BUILTINS.has(specifier);
}

/**
 * Reduce an npm specifier to the package identity, or `null` when it is not one.
 *
 * Returns `null` for relative and absolute specifiers (those are module paths,
 * not packages) and for builtins. Callers that only want the package set —
 * `drift.ts`'s `undeclared-import` rule — read exactly the shape this returns.
 */
export function normalizePackage(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:")) return null;
  if (!specifier.startsWith("@") && !specifier.includes("/") && isNodeBuiltin(specifier)) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return specifier.split("/")[0];
}