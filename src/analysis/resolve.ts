/**
 * Specifier resolution.
 *
 * ## Why this is separate from the extractors
 *
 * An extractor's job is "what did this file say?". This module's job is "does
 * that name a file in this repository?". Splitting them means a Go extractor
 * needs no knowledge of `.d.ts` probing, a Python extractor needs no knowledge
 * of `tsconfig` path aliases, and the resolution rules — which are shared by
 * every JavaScript-family project and are therefore the most likely place for a
 * silent miss — exist once.
 *
 * ## The failure mode this defends against
 *
 * Resolution failure must be *visible*. A relative specifier that does not
 * resolve is the signature of a deleted module, and issue 0005 §5 asks for
 * exactly that to produce `critical` drift. So resolution returns
 * `{ resolved: false, candidates }` rather than `null`, and the caller emits a
 * `dangling` edge carrying every path it tried. A resolver returning `null`
 * would be indistinguishable from "this project has no such dependency" —
 * the same false confidence the scanner was rewritten to eliminate, one level
 * down.
 */

/** Extensions probed when a specifier carries none, in resolution order. */
const RESOLUTION_ORDER: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Basenames probed when a specifier resolves to a directory. */
const INDEX_BASENAMES: readonly string[] = ["index"];

/**
 * Extensions a TypeScript source file may be *written* with when the specifier
 * uses a different one.
 *
 * `./x.js` in an ESM TypeScript project means `./x.ts`, and this is not
 * optional: it is the standard under `moduleResolution: node16`, and omitting
 * it makes every single-file edge in such a project dangle.
 */
const JS_TO_TS: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
  [".jsx", [".tsx", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
]);

export type Resolution =
  | { ok: true; path: string; via: string }
  | {
      ok: false;
      /** Every path that was tried, in order. Carried into the dangling edge. */
      candidates: string[];
      /**
       * The path the author most likely meant, used to name the dangling node.
       *
       * `./x.js` in a TypeScript project means `src/x.ts`, so a ghost node
       * named `src/x.js` would send a reader looking for a file that was never
       * a real candidate in the first place.
       */
      preferred?: string;
    };

export interface ResolveContext {
  /** Repo-relative directory of the importing file, posix. `""` at the root. */
  readonly fromDir: string;
  /** Available files, repo-relative. */
  readonly hasFile: (relPath: string) => boolean;
  /** Available directories, repo-relative. */
  readonly hasDirectory: (relPath: string) => boolean;
  /** Path aliases from `tsconfig.json` / `arkive.config.json`. */
  readonly aliases: readonly AliasTarget[];
  /** Candidate import roots for language-style paths. */
  readonly searchRoots: readonly string[];
}

export interface AliasTarget {
  /** Prefix as written, e.g. `@/`. */
  readonly prefix: string;
  /** Replacement templates, e.g. `["src/*"]`. */
  readonly targets: readonly string[];
}

/**
 * Resolve a specifier written by a JavaScript-family extractor.
 *
 * In order: aliases, relative paths, extension probing, the `.js` → `.ts`
 * rewrite, declaration-only files, and directory-with-index.
 */
export function resolveJsSpecifier(
  specifier: string,
  ctx: ResolveContext,
  ownExtension = ""
): Resolution {
  // An alias target is a *path*, not a filename: `"@/*": ["src/*"]` makes
  // `@/util` mean `src/util`, and which file that is depends on the same
  // extension probing a relative import needs. Running the alias result through
  // `resolvePath` rather than accepting it verbatim is what makes `@/util`
  // resolve to `src/util.ts` instead of dangling in every project that uses one.
  //
  // `rooted` matters: a `tsconfig` path alias is relative to `baseUrl`, i.e. to
  // the project root, not to the importing file. Joining it with `fromDir`
  // would produce `src/src/util` from `src/a.ts` — which is why this was a real
  // bug rather than a theoretical one.
  const aliased = aliasCandidatesFor(specifier, ctx);
  let aliasedMiss: string[] = [];
  for (const candidate of aliased) {
    const resolution = resolvePath(candidate, ctx, true);
    if (resolution.ok) return resolution;
    aliasedMiss = resolution.candidates;
  }
  if (aliased.length > 0) {
    // The prefix matched but nothing under it resolved. That is a broken path
    // mapping far more often than a deleted file, so the candidates are
    // reported rather than a bare failure.
    return { ok: false, candidates: aliasedMiss, preferred: aliased[0] };
  }

  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    // Not relative and not aliased: a bare specifier. The caller should have
    // classified this as a package; returning it unmodified keeps the evidence
    // honest about what was written rather than inventing a path.
    return { ok: false, candidates: [specifier], preferred: specifier };
  }

  return resolvePath(specifier, ctx);
}

/**
 * Resolve a dotted/slashed module path: Python (`pkg.mod`), Go (`internal/store`).
 *
 * Tries, per search root: the path itself as a directory, the path with the
 * language's file extension, and a package `__init__` inside it.
 */
export function resolveModulePath(
  specifier: string,
  ctx: ResolveContext,
  sourceExtension: string
): Resolution {
  const segments = specifier.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { ok: false, candidates: [] };

  const relative = segments.join("/");
  const candidates: string[] = [];

  for (const root of ctx.searchRoots) {
    const base = root.length === 0 ? relative : `${root}/${relative}`;
    candidates.push(base);

    if (ctx.hasDirectory(base)) return { ok: true, path: base, via: "directory" };
    if (ctx.hasFile(`${base}${sourceExtension}`)) {
      return { ok: true, path: base, via: `probe:${sourceExtension}` };
    }
    const init = `${base}/__init__${sourceExtension}`;
    candidates.push(init);
    if (ctx.hasFile(init)) return { ok: true, path: base, via: "package-init" };
  }

  return { ok: false, candidates };
}

function resolvePath(specifier: string, ctx: ResolveContext, rooted = false): Resolution {
  const normalized =
    specifier.startsWith("/") || rooted
      ? specifier.replace(/^\//, "")
      : joinPosix(ctx.fromDir, specifier);
  const extension = extnameOf(normalized);
  const candidates: string[] = [normalized];
  // What the author most likely meant, for the dangling node this failure
  // produces. `./x.js` in a TypeScript project means `src/x.ts`, and a ghost
  // node named `src/x.js` would send a reader looking for a file that was
  // never a real candidate.
  let preferred = normalized;

  if (extension === "") {
    for (const candidate of RESOLUTION_ORDER) {
      const path = `${normalized}${candidate}`;
      candidates.push(path);
      if (ctx.hasFile(path)) return { ok: true, path, via: `probe:${candidate}` };
    }
    preferred = `${normalized}.ts`;
    for (const index of INDEX_BASENAMES) {
      for (const candidate of RESOLUTION_ORDER) {
        const path = joinPosix(normalized, `${index}${candidate}`);
        candidates.push(path);
        if (ctx.hasFile(path)) return { ok: true, path, via: `index:${candidate}` };
      }
    }
    return { ok: false, candidates, preferred };
  }

  // `./x.js` may name a `.ts` source.
  const stem = normalized.slice(0, normalized.length - extension.length);
  const rewrites = JS_TO_TS.get(extension) ?? [];
  if (rewrites.length > 0) preferred = `${stem}${rewrites[0]}`;
  for (const candidate of rewrites) {
    const path = `${stem}${candidate}`;
    candidates.push(path);
    if (ctx.hasFile(path)) return { ok: true, path, via: `rewrite:${candidate}` };
  }

  // A `.d.ts` with no implementation, which happens in declaration-only packages.
  for (const candidate of [".d.ts", ".d.mts", ".d.cts"]) {
    const path = `${stem}${candidate}`;
    candidates.push(path);
    if (ctx.hasFile(path)) return { ok: true, path, via: `types:${candidate}` };
  }

  if (ctx.hasFile(normalized)) return { ok: true, path: normalized, via: "exact" };

  // A directory specifier written with an extension, e.g. `./pkg.js` → `./pkg/`.
  if (ctx.hasDirectory(normalized)) {
    for (const index of INDEX_BASENAMES) {
      for (const candidate of RESOLUTION_ORDER) {
        const path = joinPosix(normalized, `${index}${candidate}`);
        candidates.push(path);
        if (ctx.hasFile(path)) return { ok: true, path, via: `dir:${candidate}` };
      }
    }
  }

  return { ok: false, candidates, preferred };
}

/**
 * Resolve a repository-relative path to a real file.
 *
 * The second half of `resolveJsSpecifier`, and the whole of what the Python and
 * Go extractors need: those extractors already work out *which* module in this
 * repository they mean, and what is left is finding the file that holds it
 * under whichever extension its author happened to use.
 *
 * `extraExtensions` are probed first, because a Python module is `pkg/mod.py`
 * and never `pkg/mod.ts` no matter what sits next to it in the tree.
 *
 * `searchRoots` are tried after the path itself, which is what makes a Python
 * or Go module path — always written relative to a *package*, never to a file —
 * find its file in a repository that puts its source under `src/`. Without it,
 * every relative Python import in a src-layout project dangles, and dangling
 * edges are reported as `critical`.
 */
export function resolveRepoPath(
  path: string,
  ctx: ResolveContext,
  extraExtensions: readonly string[] = []
): Resolution {
  const normalised = path.replace(/^\.\//, "");
  const bases = [
    normalised,
    ...ctx.searchRoots
      .filter((root) => root.length > 0)
      .map((root) => `${root}/${normalised}`),
  ];

  const candidates: string[] = [];
  const extensions = [...extraExtensions, ...RESOLUTION_ORDER];

  for (const base of bases) {
    candidates.push(base);
    if (base !== normalised) {
      // A language-style module path may name a directory rather than a file.
      if (ctx.hasDirectory(base)) return { ok: true, path: base, via: "directory" };
    }

    const extension = extnameOf(base);
    if (extension === "") {
      for (const candidate of extensions) {
        const attempt = `${base}${candidate}`;
        candidates.push(attempt);
        if (ctx.hasFile(attempt)) return { ok: true, path: attempt, via: `probe:${candidate}` };
      }
      for (const index of INDEX_BASENAMES) {
        for (const candidate of extensions) {
          const attempt = joinPosix(base, `${index}${candidate}`);
          candidates.push(attempt);
          if (ctx.hasFile(attempt)) return { ok: true, path: attempt, via: `index:${candidate}` };
        }
      }
      continue;
    }

    const stem = base.slice(0, base.length - extension.length);
    for (const candidate of extraExtensions) {
      const attempt = `${stem}${candidate}`;
      candidates.push(attempt);
      if (ctx.hasFile(attempt)) return { ok: true, path: attempt, via: `probe:${candidate}` };
    }
    for (const candidate of JS_TO_TS.get(extension) ?? []) {
      const attempt = `${stem}${candidate}`;
      candidates.push(attempt);
      if (ctx.hasFile(attempt)) return { ok: true, path: attempt, via: `rewrite:${candidate}` };
    }
    if (ctx.hasFile(base)) return { ok: true, path: base, via: "exact" };
  }

  return { ok: false, candidates };
}

/**
 * Every path an alias would produce for this specifier, in configured order.
 *
 * Existence is deliberately *not* checked here. The caller resolves each
 * candidate properly, so an alias target that points at a directory still gets
 * its `index` probe and its extension rewriting.
 */
function aliasCandidatesFor(specifier: string, ctx: ResolveContext): string[] {
  const candidates: string[] = [];
  for (const alias of ctx.aliases) {
    candidates.push(...aliasCandidatesForTarget(alias, specifier));
  }
  return candidates;
}

function aliasCandidatesForTarget(alias: AliasTarget, specifier: string): string[] {
  if (!alias.prefix.includes("*")) {
    // A prefix alias: `"~lib": ["vendor/lib"]` makes `~lib/y` mean
    // `vendor/lib/y`, bundler-style. Treating the target as a *replacement*
    // rather than a prefix would silently drop the remainder and resolve every
    // import under the alias to the same directory.
    if (!specifier.startsWith(alias.prefix)) return [];
    const rest = specifier.slice(alias.prefix.length);
    const tail = rest.startsWith("/") ? rest : `/${rest}`;
    return alias.targets.map((target) => `${target.replace(/\/+$/, "")}${tail}`);
  }

  const [head, tail] = splitOnce(alias.prefix, "*");
  if (!specifier.startsWith(head) || !specifier.endsWith(tail)) return [];
  const captured = specifier.slice(head.length, specifier.length - tail.length);
  return alias.targets
    .filter((target) => target.includes("*"))
    .map((target) => target.replace("*", captured));
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return [value.slice(0, at), value.slice(at + 1)];
}

function joinPosix(base: string, relative: string): string {
  const segments = base.length === 0 ? [] : base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function extnameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Directory of a repo-relative posix path. `""` for a root-level file. */
export function parentDirectoryOf(relPath: string): string {
  const at = relPath.lastIndexOf("/");
  return at === -1 ? "" : relPath.slice(0, at);
}