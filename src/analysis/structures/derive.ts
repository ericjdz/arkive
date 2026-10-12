import type { GraphEdge, GraphNode } from "../../schema/graph.js";
import { derivedFrom } from "../../schema/provenance.js";
import { defaultStructureRegistry } from "./registry.js";
import type { StructureRegistry } from "./registry.js";
import {
  RULE_DATASTRUCTURE_NODE,
  RULE_SHAPE_EDGE,
  RULE_TRANSFORM_EDGE,
} from "./types.js";
import type {
  ExtractedStructure,
  StructureField,
  StructureLayout,
  StructureResult,
  StructureTransformation,
  StructureUsage,
} from "./types.js";

/**
 * Data-structure derivation — issue 0006, the second half of layer 1.
 *
 * ## What comes out
 *
 * - a `datastructure` node per declaration, carrying `fields[]`;
 * - a `derives_from` edge from the defining `module` to each shape it declares.
 *   ADR-0002:88 puts `derives_from` in the authored column — "entirely… a claim
 *   no parser observes" — and that is right for the design sense of the word
 *   ("this schema was *derived from* that one"). It is not right for the
 *   mechanical one: `interface Service` is declared in `src/service.ts`, at a
 *   line, and a rule observed that. So this edge is derived, with the
 *   declaration line as evidence, and the design-sense claim is left to
 *   `decides_from`-style authored edges and to decisions;
 * - a `reads` or `writes` edge from each touching `module` to each shape, with
 *   every site as evidence — the coupling surface issue 0006 §2 asks for, and the
 *   answer to "which modules write this shape";
 * - a `derives_from` edge between two shapes where the source **writes the
 *   mapping down** (`.pick()`, `.omit()`), with `fields`, `unmapped` and
 *   `dropped` attached to the edge rather than described in prose.
 *
 * ## The coverage rule, which is the part that matters most
 *
 * Structures fold into `parseCoverage` rather than inventing a parallel number.
 * `deriveFromScan` reports **one** coverage figure, the minimum of the import and
 * structure passes, and `reconcile` prints that one. A `structureCoverage` living
 * beside `parseCoverage` would be a number a caller could display or not, and a
 * caller displaying only the first has reintroduced exactly the failure
 * ADR-0002:141-149 was written against: a graph that looks complete because the
 * incomplete half is on a line nobody printed.
 *
 * So a repository whose TypeScript files parse as imports but whose Zod schemas
 * cannot be read is a 60%-derived repository, and the reader is told 60%. The
 * breakdown is still reported — per-format counts, unsupported extensions, and
 * unresolved name references — because "which 60%" is a different question from
 * "is it 60%", and a number without its composition is half an answer.
 *
 * ## The part that is deliberately small
 *
 * A usage resolves by name: within the file that declares the shape, or to a
 * name declared exactly once across the whole repository. A `Service` declared
 * in four files is not linked from a fifth that names it, because linking it
 * would be a guess about which four this reference means. Guessed edges are
 * worse than missing ones — a missing edge is visible, and a wrong one is
 * indistinguishable from a right one.
 *
 * ## A gap in the graph schema, recorded rather than papered over
 *
 * A shape that *contains* another shape (`owner: User` inside `Service`) has no
 * edge kind. `EdgeKindSchema` (`src/schema/graph.ts:51-58`) has `imports`,
 * `calls`, `reads`, `writes`, `derives_from` and `decided_by`, and none of them
 * means "contains". `derives_from` would be a category error and `reads` is
 * already spoken for.
 *
 * So containment rides on the node as `shapeReferences` and produces no edge. It
 * is real structure and it is visible, and it is not modelled as a relationship
 * it is not. Adding a `contains` edge kind is a schema change and belongs to
 * whoever owns `src/schema/`.
 */
export interface StructureDerivation {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Fraction of structure-bearing files that were extracted completely, 0–1.
   *
   * Reported for composition and folded into the headline by `deriveFromScan`.
   * Never displayed instead of the headline.
   */
  coverage: number;
  /** Files a structure extractor claimed and read completely. */
  filesRead: number;
  /** Files a structure extractor claimed and could not fully read. */
  filesIncomplete: number;
  /**
   * Files in a format arkive has no structure extractor for, by extension.
   *
   * Counted, and named, because "no extractor exists" and "the extractor gave
   * up" are different facts with different fixes.
   */
  unsupported: Array<{ extension: string; files: number }>;
  /** Per-format file/structure counts, for the coverage report. */
  byFormat: Record<string, { files: number; structures: number; incomplete: number }>;
  /**
   * Name references that did not resolve to a declaration.
   *
   * Reported, never guessed. Each entry is a hole in the graph whose exact shape
   * is named, which is the difference between a gap and an absence.
   */
  unresolved: Array<{ name: string; path: string; line: number; why: string }>;
  /** Everything the pass wants the reader to know. */
  notes: string[];
}

export interface StructureDeriveOptions {
  /** A different registry — how a test proves "a new format is one file". */
  registry?: StructureRegistry;
}

/** A source file, with its contents already read. */
export interface StructureSource {
  path: string;
  source: string;
}

export function deriveStructures(
  files: readonly StructureSource[],
  layout: StructureLayout,
  options: StructureDeriveOptions = {}
): StructureDerivation {
  const registry = options.registry ?? defaultStructureRegistry;
  const edges = new Map<string, GraphEdge>();
  const notes: string[] = [];
  const unresolved: Array<{ name: string; path: string; line: number; why: string }> = [];
  const undeclaredNames = new Set<string>();
  const unsupportedMap = new Map<string, number>();
  const byFormat: Record<string, { files: number; structures: number; incomplete: number }> = {};

  const declarations: ExtractedStructure[] = [];
  const byPathAndName = new Map<string, ExtractedStructure>();
  const byName = new Map<string, ExtractedStructure[]>();
  const allUsages: Array<{ usage: StructureUsage; extractorId: string }> = [];
  const allTransformations: Array<{ mapping: StructureTransformation; extractorId: string }> = [];

  let filesClaimed = 0;
  let filesRead = 0;
  let filesIncomplete = 0;

  // --- pass 1: one run per (file, extractor) ---------------------------------
  //
  // Single pass on purpose. Extraction is the expensive part of this layer — it
  // lexes every file — and `arkive reconcile` runs it on every commit inside a
  // 200ms hook budget (ADR-0005). Running each extractor once and keeping its
  // answer is the difference between one lex and three.

  for (const file of files) {
    const claiming = registry.forPath(file.path);
    if (claiming.length === 0) {
      const extension = extensionOf(file.path);
      unsupportedMap.set(extension, (unsupportedMap.get(extension) ?? 0) + 1);
      continue;
    }

    filesClaimed += 1;
    let fileComplete = true;

    for (const extractor of claiming) {
      const bucket = (byFormat[extractor.id] ??= { files: 0, structures: 0, incomplete: 0 });
      bucket.files += 1;

      let result: StructureResult;
      try {
        result = extractor.extract({
          path: file.path,
          dir: parentOf(file.path),
          source: file.source,
          layout,
        });
      } catch (err) {
        // An extractor that throws has not reported the absence of structures.
        // It has failed to look, and that difference is the entire subject.
        bucket.incomplete += 1;
        fileComplete = false;
        notes.push(
          `structure extractor "${extractor.id}" failed on ${file.path}: ${(err as Error).message}`
        );
        continue;
      }

      if (!result.complete) {
        bucket.incomplete += 1;
        fileComplete = false;
        notes.push(
          `${extractor.format} could not fully read ${file.path}` +
            (result.note !== undefined ? `: ${result.note}` : "") +
            `. Whatever it did find is in the graph; the file is counted as ` +
            `incomplete, so the coverage number below says so.`
        );
        // Whatever it did find is **kept**. A file that yielded three of four
        // declarations is partial evidence, and partial evidence with an honest
        // coverage number beats no evidence at all. What it must never become is
        // a silent claim of completeness — and `filesIncomplete` is what prevents
        // that.
      }

      for (const structure of result.structures) {
        bucket.structures += 1;
        declarations.push(structure);
        byPathAndName.set(`${structure.path}::${structure.name}`, structure);
        const existing = byName.get(structure.name);
        if (existing === undefined) byName.set(structure.name, [structure]);
        else existing.push(structure);
      }

      for (const usage of result.usages) allUsages.push({ usage, extractorId: extractor.id });
      for (const mapping of result.transformations) {
        allTransformations.push({ mapping, extractorId: extractor.id });
      }
    }

    if (fileComplete) filesRead += 1;
    else filesIncomplete += 1;
  }

  // --- nodes -----------------------------------------------------------------

  const nodes = declarations.map((structure) => structureNode(structure));

  // --- edges: module → shape --------------------------------------------------

  for (const structure of declarations) {
    addEdge(edges, {
      id: `derives_from:${moduleId(structure.path)}->${structureNodeId(structure.path, structure.name)}`,
      from: moduleId(structure.path),
      to: structureNodeId(structure.path, structure.name),
      kind: "derives_from",
      rule: `${extractorIdFor(structure)}/${RULE_DATASTRUCTURE_NODE}`,
      evidence: [`${structure.path}:${structure.line}`],
      note: "declared in this module",
    });
  }

  // --- edges: module ⇄ shape, the coupling surface ----------------------------
  //
  // Usages are reconciled across extractors first, and that step is not
  // cosmetic. `ts-types` reads `function f(): Invoice { return {…} }` as a
  // *write* (the return type plus a returned literal is a construction), while
  // `zod` — which claims the same `.ts` file and knows nothing about return
  // statements — reads the same `: Invoice` as a *read*. Without reconciliation
  // both edges are emitted, every module that constructs a shape is also counted
  // as consuming it, and "which modules read this shape" answers with the set of
  // modules that write it. That is not a slightly wrong number; it is the
  // number the issue's §2 asks the reader to trust.
  const writeSites = new Set<string>();
  for (const entry of allUsages) {
    if (entry.usage.direction !== "writes") continue;
    for (const line of entry.usage.constructionLines ?? [entry.usage.line]) {
      writeSites.add(`${entry.usage.path}:${line}:${entry.usage.name}`);
    }
  }

  const seenUsage = new Set<string>();
  for (const { usage, extractorId } of allUsages) {
    if (usage.direction === "reads") {
      if (writeSites.has(`${usage.path}:${usage.line}:${usage.name}`)) continue;
    }
    const target = resolveDeclaration(usage.name, usage.path, byPathAndName, byName);
    if (target === undefined) {
      // Two different failures, reported differently.
      //
      // **Declared nowhere.** The name is a type from a dependency, a global, or
      // a class this layer does not derive. Reporting each one would be a
      // finding per occurrence: `Error`, `Map` and `Date` are referenced
      // thousands of times in an ordinary repository and none of them is a hole
      // in this graph. Counted, never listed.
      //
      // **Declared in more than one place.** The reference is real and cannot be
      // resolved. That *is* a hole — a coupling edge that exists and is not in
      // the graph — and it is listed with its location.
      const candidates = byName.get(usage.name);
      if (candidates !== undefined && candidates.length > 1) {
        unresolved.push({
          name: usage.name,
          path: usage.path,
          line: usage.line,
          why: `declared in ${candidates.length} files; this reference does not say which`,
        });
      } else {
        undeclaredNames.add(usage.name);
      }
      continue;
    }

    const shapeId = structureNodeId(target.path, target.name);
    const key = `${usage.path}:${usage.line}:${usage.name}:${usage.direction}`;
    if (seenUsage.has(key)) continue;
    seenUsage.add(key);

    addEdge(edges, {
      id: `${usage.direction}:${moduleId(usage.path)}->${shapeId}`,
      from: moduleId(usage.path),
      to: shapeId,
      kind: usage.direction,
      rule: `${extractorId}/${RULE_SHAPE_EDGE}`,
      evidence: [`${usage.path}:${usage.line}`],
      // The note carries the basis of the claim. `reads` and `writes` are not
      // interchangeable, and a reader should not have to open five modules to
      // learn which one a given edge is.
      note:
        `${usage.direction === "writes" ? "constructs" : "consumes"} ${usage.name} ` +
        `via ${usage.establishedBy}`,
    });
  }

  // --- edges: shape → shape, where the source writes the mapping down ---------

  for (const { mapping, extractorId } of allTransformations) {
    const from = byPathAndName.get(`${mapping.path}::${mapping.from}`);
    const to = byPathAndName.get(`${mapping.path}::${mapping.to}`);
    if (from === undefined || to === undefined) {
      unresolved.push({
        name: `${mapping.from} -> ${mapping.to}`,
        path: mapping.path,
        line: mapping.line,
        why: "one side of the mapping is not a declaration this run could reproduce",
      });
      continue;
    }

    addEdge(edges, {
      id:
        `derives_from:${structureNodeId(to.path, to.name)}->` +
        `${structureNodeId(from.path, from.name)}`,
      from: structureNodeId(to.path, to.name),
      to: structureNodeId(from.path, from.name),
      kind: "derives_from",
      rule: `${extractorId}/${RULE_TRANSFORM_EDGE}`,
      evidence: [`${mapping.path}:${mapping.line}`],
      note: describeMapping(mapping),
      // The mapping rides on the edge as data, not as prose. `EdgeSchema` is a
      // `looseObject` (ADR-0006 §3), so it survives a read/write round trip
      // without a schema change — and it has to be structured, because "which
      // fields cross this boundary" is a question a walkthrough asks and a
      // sentence cannot answer it.
      extra: {
        mapping: {
          fields: mapping.fields,
          unmapped: mapping.unmapped,
          dropped: mapping.dropped,
        },
      },
    });
  }

  // --- coverage ---------------------------------------------------------------

  const unsupported = [...unsupportedMap.entries()]
    .map(([extension, count]) => ({ extension, files: count }))
    .sort((a, b) => b.files - a.files || (a.extension < b.extension ? -1 : 1));

  if (unsupported.length > 0) {
    const total = unsupported.reduce((sum, entry) => sum + entry.files, 0);
    notes.push(
      `${total} file(s) are in a format arkive has no data-structure extractor for ` +
        `(${unsupported.map((entry) => `${entry.extension} × ${entry.files}`).join(", ")}). ` +
        `They are in the module graph and absent from the shape graph, so the shape half ` +
        `of this repository is only as complete as the formats listed here.`
    );
  }

  if (filesClaimed === 0) {
    notes.push(
      `no data-structure extractor claimed any of the ${files.length} scanned file(s); ` +
        `the derived graph below is a module graph with no shapes in it`
    );
  }

  if (unresolved.length > 0) {
    // One entry per (name, file), with the line count. The same ambiguous name
    // referenced forty times in one module is one hole, not forty, and a report
    // that lists it forty times is a report nobody reaches the end of.
    const grouped = new Map<string, { entry: typeof unresolved[number]; count: number }>();
    for (const entry of unresolved) {
      const key = `${entry.path}::${entry.name}`;
      const existing = grouped.get(key);
      if (existing === undefined) grouped.set(key, { entry, count: 1 });
      else existing.count += 1;
    }

    const sample = [...grouped.values()]
      .slice(0, 5)
      .map(({ entry, count }) => `${entry.name} at ${entry.path}:${entry.line} ×${count} (${entry.why})`)
      .join("; ");

    notes.push(
      `${grouped.size} reference(s) named a data structure that exists in more than one ` +
        `file and could not be attributed to one of them, so they produced no edge. ` +
        `First: ${sample}${grouped.size > 5 ? `; and ${grouped.size - 5} more` : ""}. ` +
        `Unresolved rather than guessed — two shapes sharing one name are two shapes, ` +
        `and a wrong edge is indistinguishable from a right one.`
    );
  }

  if (undeclaredNames.size > 0) {
    // Counted, not listed. `Error`, `Map` and every type imported from a
    // dependency land here, and none of them is a gap in this graph — listing
    // them would bury the ambiguous references above, which are the ones a
    // reader can act on.
    notes.push(
      `${undeclaredNames.size} distinct type name(s) were referenced in a type position ` +
        `and match no data structure in this repository (a dependency's type, a global, ` +
        `or a construct with no record shape); they produced no edges and are not listed.`
    );
  }

  return {
    nodes: nodes.sort(byId),
    edges: [...edges.values()].sort(byId),
    coverage: filesClaimed === 0 ? 1 : filesRead / filesClaimed,
    filesRead,
    filesIncomplete,
    unsupported,
    byFormat,
    unresolved: unresolved.sort(
      (a, b) => a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1
    ),
    notes,
  };
}

/**
 * One `datastructure` node.
 *
 * Built as a plain record and narrowed once at the end, because `NodeSchema` is a
 * `looseObject` (`src/schema/graph.ts:60`): the field list and the shape
 * references are unknown keys to it, and ADR-0006 §3 requires unknown keys to
 * survive a read/write round trip rather than requiring a schema change to store
 * a derived payload.
 */
function structureNode(structure: ExtractedStructure): GraphNode {
  const record: Record<string, unknown> = {
    id: structureNodeId(structure.path, structure.name),
    kind: "datastructure",
    name: structure.name,
    // Not a description. Anything more would be a claim no rule observed, and
    // ADR-0002:71 puts "what the shape means" in the authored column.
    summary: "",
    path: structure.path,
    fields: structure.fields,
    structureForm: structure.form,
    structureExported: structure.exported,
    fieldCount: structure.fields.length,
    ...(structure.references !== undefined && structure.references.length > 0
      ? { shapeReferences: structure.references }
      : {}),
    provenance: derivedFrom(`${extractorIdFor(structure)}/${RULE_DATASTRUCTURE_NODE}`, [
      `${structure.path}:${structure.line}`,
    ]),
  };
  return record as unknown as GraphNode;
}

/**
 * The extractor id that produced a structure.
 *
 * Carried on `ExtractedStructure.extractorId` rather than recovered from the
 * form. An earlier version inferred it — `"zod-object"` meant Zod, everything
 * else meant `ts-types` — and that silently mislabelled the first new format
 * anybody wrote: a `sql-table` shape came out carrying
 * `"ts-types/datastructure-node"` as its provenance, which is a fabricated
 * citation about which analysis produced the claim. The recovery is kept as a
 * fallback so a hand-written extractor that forgets the field still produces
 * something rather than `undefined` in a persisted document.
 */
function extractorIdFor(structure: ExtractedStructure): string {
  return structure.extractorId ?? (structure.form === "zod-object" ? "zod" : "ts-types");
}

/**
 * Resolve a name to the structure it means.
 *
 * Two rules, and the second is deliberately strict:
 *
 * 1. The file that declares it. Always right, and the common case.
 * 2. A name declared exactly once across the whole repository. Unambiguous even
 *    across a module boundary — a single `User` in a project has one meaning.
 *
 * Anything else returns `undefined` and the caller records an unresolved
 * reference. A `User` declared in four files is not resolved from a fifth, and
 * the difference between "I could not tell" and "I picked one" is exactly the
 * difference between a hole and a lie.
 */
function resolveDeclaration(
  name: string,
  fromPath: string,
  byPathAndName: ReadonlyMap<string, ExtractedStructure>,
  byName: ReadonlyMap<string, ExtractedStructure[]>
): ExtractedStructure | undefined {
  const local = byPathAndName.get(`${fromPath}::${name}`);
  if (local !== undefined) return local;

  const candidates = byName.get(name);
  if (candidates === undefined || candidates.length !== 1) return undefined;
  return candidates[0];
}

/** A one-line description of a mapping, for `EdgeSchema.note`. */
function describeMapping(mapping: StructureTransformation): string {
  const carried = mapping.fields.length;
  const parts = [
    `${carried} field${carried === 1 ? "" : "s"} carried` +
      (carried > 0 ? `: ${mapping.fields.map((pair) => pair.from).join(", ")}` : ""),
  ];
  if (mapping.dropped.length > 0) parts.push(`dropped ${mapping.dropped.join(", ")}`);
  if (mapping.unmapped.length > 0) {
    parts.push(`target declares ${mapping.unmapped.join(", ")} with no source here`);
  }
  return `${mapping.from} -> ${mapping.to}: ${parts.join("; ")}`;
}

/**
 * Add or merge an edge.
 *
 * Same rationale as `derive.ts:386` — evidence is an array because one edge
 * between two shapes has many sites, and forty files constructing one shape
 * produce one edge carrying forty `file:line` entries.
 */
function addEdge(
  edges: Map<string, GraphEdge>,
  incoming: {
    id: string;
    from: string;
    to: string;
    kind: GraphEdge["kind"];
    rule: string;
    evidence: string[];
    note?: string;
    extra?: Record<string, unknown>;
  }
): void {
  const existing = edges.get(incoming.id);
  if (existing === undefined) {
    edges.set(incoming.id, {
      ...(incoming.extra ?? {}),
      id: incoming.id,
      from: incoming.from,
      to: incoming.to,
      kind: incoming.kind,
      ...(incoming.note !== undefined ? { note: incoming.note } : {}),
      provenance: derivedFrom(incoming.rule, [...incoming.evidence]),
    } as unknown as GraphEdge);
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

/** File-level module node id. Matches `derive.ts`'s `fileNodeId`. */
export function moduleId(path: string): string {
  return `module:${path}`;
}

/**
 * Data-structure node id: `datastructure:<path>::<Name>`.
 *
 * Namespaced by the declaring file, so two modules that both declare a `User`
 * are two nodes rather than one node wearing both sets of fields. Merging them
 * would produce a shape that exists in no file, which is the 62066bc shape under
 * a different name.
 */
export function structureNodeId(path: string, name: string): string {
  return `datastructure:${path}::${name}`;
}

/**
 * The coupling surface issue 0006 §2 describes: how many modules touch a shape,
 * and which ones write it.
 *
 * A pure function over the derived graph. It exists so the question has one
 * answer in one place — the alternative is five call sites each writing their own
 * `filter`, and one of them eventually forgetting the `writes` case.
 */
export function describeCoupling(
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  shapeId: string
): {
  writes: string[];
  reads: string[];
  /** Total distinct modules touching the shape. */
  modules: number;
} {
  const writes: string[] = [];
  const reads: string[] = [];

  for (const edge of graph.edges) {
    if (edge.to !== shapeId) continue;
    if (edge.kind === "writes") writes.push(edge.from);
    else if (edge.kind === "reads") reads.push(edge.from);
  }

  const distinct = new Set([...writes, ...reads]);
  return {
    writes: [...new Set(writes)].sort(),
    reads: [...new Set(reads)].sort(),
    modules: distinct.size,
  };
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "(no extension)" : base.slice(dot).toLowerCase();
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type { StructureField, StructureLayout };