import type { ArchitectureDocumentV2, GraphEdge, GraphNode } from "../schema/graph.js";
import { derivedFrom } from "../schema/provenance.js";
import { defaultRegistry } from "./extractors/registry.js";
import type { ExtractorRegistry } from "./extractors/registry.js";
import { RULE_EXTERNAL_NODE, RULE_IMPORT_EDGE, RULE_MODULE_NODE } from "./extractors/types.js";
import type { ExtractedImport, ProjectLayout } from "./extractors/types.js";
import { resolveJsSpecifier, resolveRepoPath } from "./resolve.js";
import type { ResolveContext, Resolution } from "./resolve.js";
import { scanProject } from "./scanner.js";
import type { ScanOptions, ScanResult } from "./scanner.js";

/**
 * Module derivation — the layer where the product's premise gets tested.
 *
 * ADR-0002: structure is derived from code because structure is a fact.
 * `scanner.ts` already established that a scan must report its own coverage.
 * This file turns a scan into a graph, and its central obligation is that
 * **every element it emits carries evidence a human can open** — a wrong
 * `file:line` is worse than a missing edge, because a missing edge is visible.
 *
 * ## What comes out
 *
 * - a `module` node per **file**, carrying `path`;
 * - a `module` node per **directory** that contains code. ADR-0002:69 names
 *   "Directory tree, import graph" as the two mechanically derivable facts
 *   about modules, and the directory level is what makes the graph navigable
 *   above the level of "which line of which file";
 * - an `external` node per third-party package, per ecosystem, so a PyPI
 *   `requests` and an npm `requests` are two facts rather than one collision;
 * - an `imports` edge per importer → imported pair, carrying **every** site it
 *   came from. ADR-0002:101-103: "Evidence is an array because an import edge
 *   between two directories has many sites."
 *
 * ## The split that makes continuous refresh safe
 *
 * `mergeDerived` is why this can run on every scan. Derived elements are
 * replaced wholesale by the current derivation; authored elements are never
 * touched. A `module` node whose file was deleted is tombstoned and its
 * incident **derived** edges dropped — ADR-0001:129-137 requires a node removal
 * to be soft, and requires edges to a removed node to go with it. Authored
 * edges survive that, because ADR-0001 also refuses to delete a relationship
 * somebody wrote.
 *
 * ## What is deliberately absent
 *
 * `datastructure` nodes (issue 0006 — the extractor registry is the seam it
 * plugs into), `service` boundaries (a judgement call, ADR-0002:72), and any
 * confidence number: ADR-0002:105-107 deleted that field because "a number an
 * LLM assigns to itself is not evidence".
 */

/** Extensions probed ahead of the JS family, per language. */
const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  python: [".py", ".pyi"],
  go: [".go"],
  "ts-js": [],
};

export interface DeriveOptions extends ScanOptions {
  /** Keep only nodes whose path starts with one of these prefixes. */
  onlyModules?: readonly string[];
}

export interface UnresolvedImport {
  /** The file whose specifier did not resolve. */
  from: string;
  /** The specifier as written. */
  specifier: string;
  /** 1-based line. */
  line: number;
  /** Every path that was tried. Carried into the dangling edge. */
  candidates: string[];
}

export interface DerivationResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Import sites that named a module which is not on disk. */
  unresolved: UnresolvedImport[];
  /**
   * Fraction of discovered source files that produced a fully-parsed module
   * node. The same number as `scan.parseCoverage`, restated because this is the
   * value a caller *displaying the graph* needs, and a graph that is 40%
   * derived must say so everywhere it is shown.
   */
  coverage: number;
  /** Restated counts, so a graph-only consumer need not hold the scan. */
  counts: { parsed: number; unreadable: number; truncated: number };
  /** Directory nodes emitted. */
  directories: number;
  /** Per-language file/import counts. */
  byLanguage: Record<string, { files: number; imports: number; incomplete: number }>;
  /** Everything the scan wants the reader to know. */
  notes: string[];
}

export function deriveModules(dir: string, options: DeriveOptions = {}): DerivationResult {
  return deriveFromScan(scanProject(dir, options), options);
}

/**
 * Extensions that are imported by name but are not modules.
 *
 * `import "./styles.css"` is a real import statement with no module behind it.
 * Emitting a dangling edge for one produces a `critical` finding on essentially
 * every frontend repository, and a critical that fires constantly is a critical
 * nobody reads — which is the same failure as the one this whole layer exists
 * to end. They are skipped instead, and *not* counted as unresolved, because
 * nothing is missing: the graph has no node kind for a stylesheet, and it
 * should not grow one to record a file that is not part of the architecture.
 */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".css", ".scss", ".sass", ".less", ".styl", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".wav", ".webm", ".wasm", ".txt", ".md", ".html", ".htm",
  ".graphql", ".gql", ".proto", ".sql",
]);

/**
 * Derive from a scan that has already been taken.
 *
 * Separate so issue 0007's watch mode does not pay for a second walk on every
 * change, and so a test can derive against a scan it assembled by hand.
 */
export function deriveFromScan(
  scan: ScanResult,
  options: DeriveOptions = {}
): DerivationResult {
  const registry = options.registry ?? defaultRegistry;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const unresolved: UnresolvedImport[] = [];

  const fileToNode = new Map<string, string>();
  const dirToNode = new Map<string, string>();

  // --- module nodes, one per file -------------------------------------------

  for (const file of scan.files) {
    const id = fileNodeId(file.path);
    fileToNode.set(file.path, id);
    nodes.set(id, {
      id,
      kind: "module",
      name: baseNameOf(file.path),
      // Not a description of the file. Anything more would be a claim no rule
      // observed, and ADR-0002:88-89 puts "what it means" in the authored column.
      summary: "",
      tech: registry.get(file.extractor)?.language ?? file.extractor,
      path: file.path,
      provenance: derivedFrom(`${file.extractor}/${RULE_MODULE_NODE}`, [`${file.path}:1`]),
    });
  }

  // --- module nodes, one per directory --------------------------------------

  const directories = new Set<string>();
  for (const file of scan.files) {
    for (const ancestor of ancestorsOf(file.path)) directories.add(ancestor);
  }
  for (const directory of [...directories].sort()) {
    const id = dirNodeId(directory);
    dirToNode.set(directory, id);
    nodes.set(id, {
      id,
      kind: "module",
      name: baseNameOf(directory),
      summary: "",
      path: directory,
      provenance: derivedFrom(`directory/${RULE_MODULE_NODE}`, [`${directory}/`]),
    });
  }

  // --- external nodes and import edges --------------------------------------

  const externalSites = new Map<string, Set<string>>();
  const resolveCtx: ResolveContext = {
    fromDir: "",
    hasFile: (relPath) => scan.fileIndex.has(relPath),
    hasDirectory: (relPath) => scan.directoryIndex.has(relPath),
    aliases: scan.aliases,
    searchRoots: scan.searchRoots,
  };

  for (const file of scan.files) {
    const fromFile = fileToNode.get(file.path);
    if (fromFile === undefined) continue;
    const fromDir = dirToNode.get(parentOf(file.path));
    const language = file.extractor;
    const rule = `${language}/${RULE_IMPORT_EDGE}`;

    for (const found of file.imports) {
      const site = `${file.path}:${found.line}`;

      // Builtins are the language, not this project. No node, no edge.
      if (found.target.kind === "builtin") continue;

      // A stylesheet is not a module. See `ASSET_EXTENSIONS`.
      if (ASSET_EXTENSIONS.has(extnameOf(found.specifier))) continue;

      if (found.target.kind === "package") {
        const id = externalNodeId(found.target.ecosystem, found.target.name);
        const sites = externalSites.get(id) ?? new Set<string>();
        sites.add(site);
        externalSites.set(id, sites);

        addEdge(edges, {
          id: edgeId(fromFile, id),
          from: fromFile,
          to: id,
          kind: "imports",
          rule,
          evidence: [site],
        });
        if (fromDir !== undefined) {
          addEdge(edges, {
            id: edgeId(fromDir, id),
            from: fromDir,
            to: id,
            kind: "imports",
            note: "aggregated over the files in this directory",
            rule,
            evidence: [site],
          });
        }
        continue;
      }

      const resolution = resolveImport(
        found.specifier,
        found.target,
        file,
        resolveCtx,
        registry.get(language)
      );

      if (!resolution.ok) {
        unresolved.push({
          from: file.path,
          specifier: found.specifier,
          line: found.line,
          candidates: resolution.candidates,
        });
        // Emitted, not dropped. A specifier pointing at nothing is a fact about
        // the repository — most often a deleted module — and ADR-0001:141-145
        // requires the reference to be preserved and reported. This edge is
        // also the mechanism behind issue 0005's `critical` deleted-module
        // finding: a dangling edge is a fact no scan can produce by accident.
        const ghost = fileNodeId(
          resolution.preferred ?? resolution.candidates[0] ?? found.specifier
        );
        addEdge(edges, {
          id: edgeId(fromFile, ghost),
          from: fromFile,
          to: ghost,
          kind: "imports",
          rule,
          evidence: [site],
          dangling: true,
          note:
            `unresolved: "${found.specifier}" matched no file; tried ` +
            `${resolution.candidates.join(", ") || "nothing"}`,
        });
        continue;
      }

      const toFile = fileToNode.get(resolution.path);
      if (toFile !== undefined) {
        addEdge(edges, {
          id: edgeId(fromFile, toFile),
          from: fromFile,
          to: toFile,
          kind: "imports",
          rule,
          evidence: [site],
        });
      }
      const toDir = dirToNode.get(resolution.path);
      if (toDir !== undefined) {
        addEdge(edges, {
          id: edgeId(fromFile, toDir),
          from: fromFile,
          to: toDir,
          kind: "imports",
          rule,
          evidence: [site],
        });
      }
    }
  }

  for (const [id, sites] of externalSites) {
    const { ecosystem, name, rulePrefix } = splitExternalId(id);
    nodes.set(id, {
      id,
      kind: "external",
      name,
      summary: "",
      tech: ecosystem,
      provenance: derivedFrom(
        `${rulePrefix}/${RULE_EXTERNAL_NODE}`,
        // Sorted, so the document is byte-identical between runs over an
        // unchanged repository. An unsorted evidence array would make `arkive
        // derive` commit a diff every run for no reason.
        [...sites].sort()
      ),
    });
  }

  const filtered =
    options.onlyModules === undefined
      ? [...nodes.values()]
      : [...nodes.values()].filter((node) =>
          options.onlyModules?.some((prefix) => underPath(node.path, prefix))
        );
  const live = new Set(filtered.map((node) => node.id));

  return {
    nodes: filtered.sort(byId),
    edges: [...edges.values()].filter((edge) => live.has(edge.from)).sort(byId),
    unresolved: unresolved.sort((a, b) =>
      a.from === b.from ? a.line - b.line : a.from < b.from ? -1 : 1
    ),
    coverage: scan.parseCoverage,
    counts: {
      parsed: scan.filesScanned,
      unreadable: scan.filesUnreadable,
      truncated: scan.filesTruncated,
    },
    directories: directories.size,
    byLanguage: scan.byLanguage,
    notes: scan.scanNotes,
  };
}

/**
 * Resolve one internal import, dispatching on the extractor's language.
 *
 * The dispatch is the only place the three languages' resolution conventions
 * meet, and it is a switch over an *extractor id* rather than a branch inside
 * the walk — so adding a language that resolves like an existing one is one
 * line, and adding one that does not is one new function plus one line.
 *
 * The fallback matters more than the cases. A language this table does not know
 * about resolves by *its own extension*, because in every language covered so
 * far a module is a file of the same kind as the one importing it. That is what
 * lets `tests/analysis/registry.test.ts` register a language nobody has written
 * and have its imports resolve with nothing here changing — which is the
 * property the issue's acceptance criterion is actually about.
 */
function resolveImport(
  specifier: string,
  target: { kind: "module"; path: string; symbol?: string },
  file: { path: string },
  ctx: ResolveContext,
  extractor: { id: string } | undefined
): Resolution {
  const scoped: ResolveContext = { ...ctx, fromDir: parentOf(file.path) };
  const id = extractor?.id ?? "ts-js";

  if (id === "ts-js") return resolveJsSpecifier(specifier, scoped);

  const ownExtension = extnameOf(file.path);
  const extra = LANGUAGE_EXTENSIONS[id] ?? (ownExtension === "" ? [] : [ownExtension]);

  // Python and Go extractors already reduced the specifier to a repository path
  // or a package directory; what remains is finding the file.
  const resolution = resolveRepoPath(target.path, scoped, extra);
  if (resolution.ok || target.path.length > 0) return resolution;

  // A Go import may name a *directory* of files rather than one file.
  if (ctx.hasDirectory(target.path)) {
    return { ok: true, path: `${target.path}/`, via: "directory" };
  }
  return resolution;
}

/**
 * Add or merge an edge.
 *
 * Merging rather than replacing is the point: ADR-0002:101-103 — evidence is an
 * array because an import edge between two directories has many sites. Forty
 * files importing `zod` produce one edge carrying forty `file:line` entries,
 * not forty edges and not one representative entry.
 */
function addEdge(
  edges: Map<string, GraphEdge>,
  incoming: {
    id: string;
    from: string;
    to: string;
    kind: "imports";
    rule: string;
    evidence: string[];
    note?: string;
    dangling?: boolean;
  }
): void {
  const existing = edges.get(incoming.id);
  if (existing === undefined) {
    edges.set(incoming.id, {
      id: incoming.id,
      from: incoming.from,
      to: incoming.to,
      kind: incoming.kind,
      ...(incoming.note !== undefined ? { note: incoming.note } : {}),
      ...(incoming.dangling === true ? { dangling: true } : {}),
      provenance: derivedFrom(incoming.rule, [...incoming.evidence]),
    });
    return;
  }
  if (!existing.provenance.derived) return;
  const merged = new Set(existing.provenance.evidence);
  for (const site of incoming.evidence) merged.add(site);
  edges.set(incoming.id, {
    ...existing,
    provenance: derivedFrom(existing.provenance.rule, [...merged].sort()),
  });
}

// --- ids ---------------------------------------------------------------------

/** File-level module node. `module:` + path. */
export function fileNodeId(path: string): string {
  return `module:${path}`;
}

/** Directory-level module node. Namespaced so it can never collide with a file. */
export function dirNodeId(path: string): string {
  return `module:dir:${path}`;
}

export function externalNodeId(ecosystem: string, name: string): string {
  return `external:${ecosystem}:${name}`;
}

export function edgeId(from: string, to: string): string {
  return `imports:${from}->${to}`;
}

function splitExternalId(id: string): {
  ecosystem: string;
  name: string;
  rulePrefix: string;
} {
  // `external:<ecosystem>:<name...>`
  const rest = id.slice("external:".length);
  const at = rest.indexOf(":");
  const ecosystem = rest.slice(0, at);
  const name = rest.slice(at + 1);
  // The npm ecosystem is derived by the JavaScript extractor, which is the only
  // one that can have produced it.
  return { ecosystem, name, rulePrefix: ecosystem === "npm" ? "ts-js" : ecosystem };
}

function baseNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.length > 0 ? base : path;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function extnameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Every ancestor directory of a repo-relative path, nearest first. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = parentOf(path);
  while (current.length > 0) {
    ancestors.push(current);
    current = parentOf(current);
  }
  return ancestors;
}

function underPath(path: string | undefined, prefix: string): boolean {
  if (path === undefined) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// --- the derived / authored split --------------------------------------------

/**
 * An authored node that derivation can no longer corroborate.
 *
 * ADR-0002:116 names this as the first thing `reconcile` is retained to report:
 * "An authored node whose kind is derivable but which has no derivation." It is
 * reported and nothing else. `mergeDerived` has already kept the node — that is
 * rule 1 — and this record exists so a caller can *say* so.
 */
export interface AuthoredOrphan {
  id: string;
  kind: string;
  /** Present on `module` nodes; the file derivation looked for. */
  path?: string;
  /** `true` for `authoredBy: "human"`. Drives severity. */
  humanVerified: boolean;
  /**
   * Why the node is being treated as a candidate at all.
   *
   * `no-derivation-of-this-kind` is the suppressed case: the run derived zero
   * nodes of this kind, so it has no opinion about them. Reporting an authored
   * `datastructure` as orphaned by a run that emits no data structures is a
   * finding produced from no evidence, which ADR-0002:150-152 rejects outright.
   */
  because: "no-derivation-of-this-kind" | "not-reproduced";
}

export interface MergeResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Derived elements the current derivation replaced. */
  replaced: number;
  /** Authored elements a derivation would otherwise have replaced. */
  preservedAuthored: number;
  /** Derived nodes tombstoned because the current run cannot reproduce them. */
  tombstoned: number;
  /** Derived edges dropped because an endpoint was tombstoned. */
  droppedEdges: number;
  /**
   * Node ids this merge introduced. The headline of the delta — "3 nodes added"
   * is the sentence a reader acts on, and a count of *replaced* elements is not
   * it (a replaced element is usually the same element, refreshed).
   */
  addedNodes: string[];
  /** Node ids tombstoned by this merge. */
  removedNodes: string[];
  /** Derived or authored edges this merge introduced. */
  addedEdges: number;
  /** Authored nodes of a derivable kind this run could not corroborate. */
  orphanedAuthored: AuthoredOrphan[];
}

/**
 * Fold a fresh derivation onto an existing document without destroying anything
 * a human wrote.
 *
 * Takes `{ nodes, edges }` rather than a full `ArchitectureDocumentV2` on
 * purpose. `readArchitecture` returns an `ArchitectureDocument`, whose
 * `schemaVersion` is typed `number` because it reports what was on disk (issue
 * 0004 §3 — a v1 file reads as v2 in memory and is not persisted as v2 until a
 * write). Merging reads two arrays and writes two arrays; requiring the literal
 * `2` would force every caller through a cast to express nothing.
 *
 * The rules, in the order they apply:
 *
 * 1. An **authored** element with the same id is kept. Derivation never
 *    overwrites it. This is what makes it safe to run on every commit, and it
 *    is the reason `reconcile` cannot silently rewrite a document.
 * 2. A **derived** element with the same id is replaced. Derived state is
 *    regenerated, so there is nothing to preserve — except the human half of a
 *    derived node (`summary`, `owner`), which is carried across.
 * 3. A derived element the current derivation did **not** reproduce is
 *    tombstoned (`deletedAt`) if it is a node, and its incident derived edges
 *    are dropped. ADR-0001:129-137 requires a soft node removal with an
 *    explicit edge cascade.
 * 4. An **authored** edge is never dropped for that reason. ADR-0001 refuses to
 *    delete a relationship somebody wrote; it survives as `dangling`.
 *
 * `provenance` is never carried across a refresh. A refreshed node's evidence
 * must reflect the run that produced it, or the graph would cite lines that no
 * longer say what the edge claims they say — which is worse than having no
 * evidence, because a wrong citation is indistinguishable from a right one.
 */
export function mergeDerived(
  document: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  derivation: DerivationResult
): MergeResult {
  let replaced = 0;
  let preservedAuthored = 0;
  let tombstoned = 0;
  let droppedEdges = 0;
  let addedEdges = 0;
  const addedNodes: string[] = [];
  const removedNodes: string[] = [];

  const previousNodes = new Map(document.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(document.edges.map((edge) => [edge.id, edge]));

  const nodes: GraphNode[] = [];
  const freshIds = new Set<string>();

  for (const node of derivation.nodes) {
    const previous = previousNodes.get(node.id);
    freshIds.add(node.id);
    if (previous === undefined) {
      nodes.push(node);
      addedNodes.push(node.id);
      continue;
    }
    if (!previous.provenance.derived) {
      nodes.push(previous);
      preservedAuthored += 1;
      continue;
    }
    replaced += 1;
    nodes.push({ ...node, ...carryHumanNodeFields(previous) });
  }

  const now = new Date().toISOString();
  const tombstones: GraphNode[] = [];

  for (const previous of document.nodes) {
    if (freshIds.has(previous.id)) {
      // Authored and re-derived under the same id. Rule 1 kept the stored copy,
      // so this node is corroborated by both halves and is not an orphan.
      continue;
    }
    if (!previous.provenance.derived) {
      nodes.push(previous);
      continue;
    }
    if (previous.deletedAt !== undefined) {
      tombstones.push(previous);
      continue;
    }
    tombstoned += 1;
    removedNodes.push(previous.id);
    tombstones.push({ ...previous, deletedAt: now });
  }

  const liveIds = new Set([...nodes, ...tombstones].map((node) => node.id));

  const edges: GraphEdge[] = [];
  const freshEdgeIds = new Set<string>();

  for (const edge of derivation.edges) {
    const previous = previousEdges.get(edge.id);
    freshEdgeIds.add(edge.id);
    if (previous === undefined) {
      edges.push(edge);
      addedEdges += 1;
      continue;
    }
    if (!previous.provenance.derived) {
      edges.push(previous);
      preservedAuthored += 1;
      continue;
    }
    replaced += 1;
    edges.push({ ...edge, ...carryHumanEdgeFields(previous) });
  }

  for (const previous of document.edges) {
    if (freshEdgeIds.has(previous.id)) continue;
    if (!previous.provenance.derived) {
      edges.push(previous);
      continue;
    }
    // Derived and no longer reproducible. ADR-0001:134 drops incident edges
    // with the node, so the edge goes too — it was a claim about structure that
    // the current run has disproved.
    droppedEdges += 1;
  }

  return {
    nodes: [...nodes, ...tombstones].sort(byId),
    edges: edges.sort(byId),
    replaced,
    preservedAuthored,
    tombstoned,
    droppedEdges,
    addedNodes,
    removedNodes,
    addedEdges,
    orphanedAuthored: findOrphanedAuthored(document, derivation, freshIds),
  };
}

/**
 * Authored nodes of a derivable kind that this derivation could not corroborate.
 *
 * ### The two halves of the rule
 *
 * **Which nodes are candidates.** Only `kind: "module"` and `kind: "external"`.
 * Those are the two kinds this build derives exhaustively (ADR-0002:62-69 names
 * them as mechanically derived with nothing on the "understands something"
 * side), so "derivation did not produce it" is a real absence. An authored
 * `service` or `datastore` is *never* an orphan: ADR-0002:72-75 puts "is this the
 * right boundary, and what is it for" on the human side, so a rule that cannot
 * derive a service can never accuse one of not existing. It would fire on every
 * authored service in every project, which is the "critical that fires constantly
 * is a critical nobody reads" failure.
 *
 * **When the verdict fires.** Only when this run derived at least one node of
 * that kind. A repository with no imports derives zero `external` nodes, and an
 * authored `external:npm:redis` node in it is not contradicted by the absence —
 * the absence is the scan's coverage, not a fact about the graph. An orphan
 * verdict produced from no evidence is exactly what ADR-0002:150-152 rules out.
 *
 * ### Why it is reported and never deleted
 *
 * `mergeDerived` rule 1 already keeps the node — no code path here removes an
 * authored element. The finding exists so a human is *told*, because the node
 * carries `summary` and possibly `provenance.reviewedAt`, and a summary nobody
 * has re-read in four months is the cost this product exists to pay. A 62066bc
 * here would be quiet and correct-looking: a decision's `subjects[]` resolving
 * against a graph that silently lost the node it was about.
 */
function findOrphanedAuthored(
  document: { nodes: readonly GraphNode[] },
  derivation: DerivationResult,
  freshIds: ReadonlySet<string>
): AuthoredOrphan[] {
  // What this run is capable of speaking about. Computed first, because it
  // decides whether a node is a candidate at all — see the doc comment.
  const derivedKinds = new Set(derivation.nodes.map((node) => node.kind));
  const orphans: AuthoredOrphan[] = [];

  for (const node of document.nodes) {
    if (node.provenance.derived) continue;
    if (node.deletedAt !== undefined) continue;
    if (!ORPHANABLE_KINDS.has(node.kind)) continue;
    // Derivation produced this id under the same identity. The stored copy won
    // the merge (rule 1), so the two halves agree this is here.
    if (freshIds.has(node.id)) continue;
    // The current run derived nothing of this kind, so it has no opinion.
    if (!derivedKinds.has(node.kind)) continue;

    orphans.push({
      id: node.id,
      kind: node.kind,
      ...(node.path === undefined ? {} : { path: node.path }),
      humanVerified: isHumanVerified(node),
      because: "not-reproduced",
    });
  }

  return orphans;
}

/**
 * `true` when somebody put their name on this element.
 *
 * `human-verified` is the provenance the issue is about: ADR-0002:103 gives an
 * authored element `authoredBy` and an optional `reviewedAt`, and a human who
 * reviewed a node is the only party in the system who has claimed to have
 * understood it. Everything downstream — severity, whether a finding blocks —
 * keys off this and not off a confidence number, which ADR-0002:105-107 deleted
 * for exactly this reason.
 */
export function isHumanVerified(element: GraphNode | GraphEdge): boolean {
  if (element.provenance.derived) return false;
  if (element.provenance.authoredBy === "human") return true;
  // A v1 `source: "human-verified"` migrated onto the node. `carryLegacyServiceFields`
  // keeps it verbatim so a detector does not go quiet after an upgrade, and that
  // promise only holds if something reads it.
  const source = (element as { source?: unknown }).source;
  return typeof source === "string" && source === "human-verified";
}

/**
 * Node kinds an authored node of which can be *corroborated* by derivation.
 *
 * `datastructure` is deliberately absent: issue 0006 wires the extractor
 * registry, and until a rule emits one of these there is no evidence to compare
 * against. Adding it here before the rule exists would make every authored
 * `datastructure` in every project an orphan, for no reason but an enum.
 */
const ORPHANABLE_KINDS: ReadonlySet<string> = new Set(["module", "external"]);

/**
 * Fields a human may have written onto a node derivation owns structurally.
 *
 * `summary` and `owner` are the authored half of a derived node. Nothing else
 * crosses, and in particular not `provenance` — see the note on `mergeDerived`.
 */
function carryHumanNodeFields(previous: GraphNode): Partial<GraphNode> {
  const carried: Partial<GraphNode> = {};
  if (typeof previous.summary === "string" && previous.summary.length > 0) {
    carried.summary = previous.summary;
  }
  if (previous.owner !== undefined) carried.owner = previous.owner;
  if (previous.tech !== undefined) carried.tech = previous.tech;
  return carried;
}

function carryHumanEdgeFields(previous: GraphEdge): Partial<GraphEdge> {
  const carried: Partial<GraphEdge> = {};
  if (previous.note !== undefined) carried.note = previous.note;
  if (previous.label !== undefined) carried.label = previous.label;
  return carried;
}

/** Present so a caller can tell a dropped edge from a filtered one. */
export function edgeEndpointsLive(edge: GraphEdge, liveNodeIds: ReadonlySet<string>): boolean {
  if (edge.dangling === true) return true;
  return liveNodeIds.has(edge.from) && liveNodeIds.has(edge.to);
}

export type { ProjectLayout, ArchitectureDocumentV2 };