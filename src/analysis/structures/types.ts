/**
 * The structure-extractor contract.
 *
 * ## Why this is a second interface and not a field on `Extractor`
 *
 * `src/analysis/extractors/types.ts` is the *import* contract: it answers "what
 * does this specifier point at", and it resolves against the filesystem through
 * `ProjectLayout`. This one answers a different question — "what shape does this
 * declaration have, and where is it used" — and it needs something the import
 * contract has no room for: **positions inside the declaration**. A field is at
 * a line; an interface body spans a range; a Zod object literal has a shape that
 * has to be matched with braces before it can be read at all. Bolting
 * `structures?: ExtractedStructure[]` onto `ExtractResult` would have made the
 * import walker pay for declaration parsing on every file of every language,
 * including the ones whose structure extractors do not exist yet.
 *
 * The separation also keeps the honesty rules apart. An import extractor that
 * cannot read a file must return `complete: false` or it has silently reported
 * the absence of imports. A structure extractor that cannot read a *declaration*
 * must do the same for the same reason, and the two `complete` flags are counted
 * separately because they fail for different reasons and a reader needs to know
 * which one dropped the coverage.
 *
 * ## The three things a new format has to know
 *
 * 1. Which file extensions it claims (`extensions`).
 * 2. Its own id, which namespaces every `rule` it produces (`id`). A rule id
 *    that reads `zod/datastructure-node` tells a reader which format produced
 *    the claim without opening the file that did it. Same rule as
 *    `extractors/types.ts`, same reason.
 * 3. How to read a declaration (`extract`).
 *
 * That is the whole contract. Resolution against the filesystem arrives through
 * `ProjectLayout`, so a structure extractor never calls `fs` itself, and the
 * walker never learns a format name.
 *
 * ## What a structure extractor may not do
 *
 * Emit a value. Not in a field's type, not in a `note`, not in a shape's `form`.
 * `src/analysis/structures/redact.ts` is the mechanism and the reason; the short
 * form is that anything which ends up in the document is read through it first.
 */

import type { ProjectLayout } from "../extractors/types.js";

/**
 * How the declaration was written.
 *
 * Transport naming only, exactly as `ImportForm` is: it never changes what a
 * structure *is*, and two structures with different forms and the same fields are
 * the same shape for every question this layer answers. It is carried because
 * "is this validated at the boundary" is the difference between an interface used
 * as documentation and a Zod schema used as a gate, and that question is
 * answerable only at extraction time.
 */
export type StructureForm =
  // TypeScript / JavaScript
  | "interface"
  | "type-alias"
  | "class"
  // Zod
  | "zod-object"
  // Additive, for formats added later
  | (string & {});

/**
 * One field of a data structure.
 *
 * **Three properties, no more.** Name, type, optionality. That is the entire
 * derived surface, and it is exactly the surface ADR-0002:71 puts on the derived
 * side of the ledger: "Field names, types, and structure from type
 * declarations."
 *
 * There is no `value`, no `example`, no `default`, and no `description` field,
 * and their absence is structural rather than a policy: a `description` on a Zod
 * schema is a string literal written by whoever wrote the schema, and it
 * routinely contains example payloads. The fields below cannot hold one.
 */
export interface StructureField {
  /** The field's name. Never redacted — ADR-0002:71. */
  name: string;
  /**
   * The field's type, with every literal replaced by its kind.
   *
   * `password: z.string()` → `"string"`. `status: "draft" | "live"` →
   * `"string"` with `literals: 2`. `retries: 3` → `"number"` with
   * `literals: 1`. The constraint survives; the members do not.
   */
  type: string;
  /**
   * `?` in TypeScript, `.optional()` / `.nullish()` / `.default()` in Zod.
   *
   * `complete: false` when the extractor could not tell — an optionality that
   * cannot be established is not the same fact as an absent one, and guessing
   * would make a field look required when it is not.
   */
  optional: boolean;
  /** 1-based line the field is declared on. The `evidence` a reader opens. */
  line: number;
  /**
   * How many literal tokens this field's declared type contained.
   *
   * Present only when non-zero. A field typed `"a" | "b" | "c"` records `3`,
   * which tells a reader the field is a closed set without telling them what is
   * in it. This is the whole reason redaction costs nothing structurally: the
   * fact that survives is the *width* of the constraint, not its contents.
   */
  literals?: number;
}

/**
 * A data structure declared in a file.
 *
 * `name` is the declared name. `path` is carried separately because two modules
 * may both declare a `User`, and a graph that conflates them produces a coupling
 * count that means nothing.
 */
export interface ExtractedStructure {
  /** The declared name, e.g. `ServiceRecord`, `UserSchema`. */
  name: string;
  /** Repo-relative, posix. The file this was declared in. */
  path: string;
  /**
   * Which extractor read this.
   *
   * Carried rather than inferred from `form`. An earlier version derived it —
   * `"zod-object"` meant Zod, everything else meant `ts-types` — and that is a
   * rule that silently mislabels the first new format anybody writes: a
   * `sql-table` shape came out carrying `"ts-types/datastructure-node"` as its
   * provenance, which is a fabricated citation about which analysis produced
   * the claim. `form` describes the shape; this says who looked.
   */
  extractorId: string;
  /** How it was written. See `StructureForm`. */
  form: StructureForm;
  /** 1-based line the declaration starts on. */
  line: number;
  /** `true` when the declaration is exported. */
  exported: boolean;
  /** Fields, in declaration order. May be empty — see below. */
  fields: StructureField[];
  /**
   * Names of other structures this one's fields refer to.
   *
   * A field's type text is redacted type syntax, and `owner: User` names a
   * structure that may be declared in another file. Recording the names lets the
   * deriver link the two shapes without re-lexing, and lets a reader answer "what
   * is nested inside this record" without opening three files.
   *
   * Only names that resolve to a known `datastructure` become edges. An
   * unresolved name is recorded here and produces no edge, because an edge to a
   * node that does not exist is a dangling reference, and ADR-0001:141-145 wants
   * those reported rather than fabricated.
   */
  references?: string[];
}

/**
 * A place a file touches a data structure.
 *
 * This is what turns "there is a `ServiceRecord` shape" into "six modules touch
 * it". The issue's own words: *"A data structure touched by twelve modules is a
 * coupling point, and it should be visible without reading twelve modules."*
 * Without usages, the coupling is a fact only the author of each of the twelve
 * files knows.
 */
export interface StructureUsage {
  /** The structure being used. Resolved against declarations, not assumed. */
  name: string;
  /** Repo-relative, posix. The file that touches it. */
  path: string;
  /** 1-based line. */
  line: number;
  /**
   * Which direction this module touches the shape.
   *
   * - `reads` — the shape is consumed: a parameter, a field type, a cast.
   * - `writes` — the shape is produced: a literal object annotated with it, a
   *   `new`, a Zod parse of untrusted input into it.
   *
   * A line that does neither is not a usage. An ambiguous site is dropped rather
   * than guessed at, because a wrong direction is a wrong fact about data flow
   * and a missing one is visible as a missing one.
   */
  direction: "reads" | "writes";
  /**
   * The construction that established this direction.
   *
   * Carried so a reader can audit the call without opening the file, and so a
   * `reads` edge is visibly a read rather than a defaulted write. The vocabulary
   * is closed and lexical — `new`, `annotated-literal`, `satisfies`, `parse()`,
   * `safeParse()`, `type-reference` — because an open one would grow a value
   * nobody can enumerate and quietly stop meaning anything.
   */
  establishedBy: string;
  /**
   * Every line this construction accounts for, when that is not just `line`.
   *
   * A function whose return type is `Invoice` and whose body is `return {…}`
   * produces one write, evidenced at the `return`, whose *declaration* also sits
   * on the signature line. The signature carries a `: Invoice` type reference,
   * and without this the same declaration is counted as a read as well — which
   * makes every module that constructs a shape also report as consuming it, and
   * answers "which modules read this" with "the ones that write it".
   *
   * This exists so the reconciliation happens in one place rather than in each
   * extractor: a `.ts` file is claimed by two extractors, and only one of them
   * knows what a return statement means.
   */
  constructionLines?: number[];
}

/**
 * A mapping from one shape into another, with the mapping attached.
 *
 * ## Why this is separate from `StructureUsage`
 *
 * A usage says "this module touches that shape". A transformation says "this
 * module takes the fields of one shape and produces a different set". The second
 * is the one issue 0006 §3 is about: *"Silent reshaping between layers is where
 * real bugs live, and it is invisible in a module graph."* Burying it in the
 * coupling count would reproduce the invisibility it exists to remove.
 *
 * ## What counts as observable, and what does not
 *
 * Only mappings the source actually spells out. `SchemaA.parse(...)` is not a
 * mapping — nothing says what the output looks like. A return type annotated with
 * `SchemaB` from a function that reads a `SchemaA` is a claim the parser cannot
 * check. A field-by-field mapping — `{ id: a.id, name: a.name, ... }` written
 * against two known shapes, or a Zod `.pick()` / `.omit()` / `.extend()` chain —
 * is written down, and what it spells out is the mapping.
 *
 * So `fields` lists the mapped fields and `unmapped` lists the ones the target
 * declares that the source did not supply. A shape that gains a field with a
 * default nobody wrote is a real defect and it is exactly what this catches.
 */
export interface StructureTransformation {
  /** The structure being transformed. */
  from: string;
  /** The structure being produced. */
  to: string;
  /** Repo-relative, posix. Where the mapping is written. */
  path: string;
  /** 1-based line. */
  line: number;
  /**
   * Fields the mapping carries across, as `from > to` pairs.
   *
   * An identity mapping (`from === to`) is still recorded. "This shape is passed
   * through unchanged" is a fact, and it is the fact that makes the *other*
   * mappings on the same shape worth looking at.
   */
  fields: Array<{ from: string; to: string }>;
  /**
   * Target fields with no entry in `fields`.
   *
   * Non-empty is a finding, not a defect in itself: the target may declare an
   * optional field the mapping legitimately omits. It is recorded because "which
   * fields cross this boundary" is the question the issue opens with, and the
   * answer has to include the ones that did not.
   */
  unmapped: string[];
  /**
   * Source fields with no entry in `fields` — dropped, renamed, or computed.
   */
  dropped: string[];
}

/**
 * The result of reading one file for structures.
 *
 * `complete` carries the same obligation as `ExtractResult.complete`, and it is
 * reported for the same reason: a partial parse must never look like a complete
 * one. See the file comment for why the two coverage numbers are counted
 * separately rather than merged.
 */
export interface StructureResult {
  /** Structures declared in this file. May be empty; that is a claim. */
  structures: ExtractedStructure[];
  /** Places this file touches a structure declared anywhere in the scan. */
  usages: StructureUsage[];
  /** Mappings from one structure into another, spelled out in the source. */
  transformations: StructureTransformation[];
  /**
   * `false` when the extractor could not read this file with confidence.
   *
   * The file is then counted against `structureCoverage`, so a repository in
   * which a third of the declarations are unreadable reports a third of the
   * structure graph rather than a clean bill of health.
   */
  complete: boolean;
  /** Why it is not complete. Never set without `complete: false`. */
  note?: string;
}

/**
 * Read-only view of the repository a structure extractor resolves against.
 *
 * Deliberately a *subset* of `ProjectLayout`: a declaration is always inside a
 * file, so nothing here needs to know about search roots or Go modules. Narrower
 * than the import contract on purpose — every property a structure extractor
 * cannot use is a property it can get wrong.
 */
export interface StructureLayout {
  /** Every discovered file, repo-relative and posix-separated. */
  readonly hasFile: (relPath: string) => boolean;
  /** Every discovered directory, repo-relative and posix-separated. */
  readonly hasDirectory: (relPath: string) => boolean;
}

export interface StructureContext {
  /** Repo-relative, posix-separated. */
  readonly path: string;
  /** Directory containing the file, repo-relative and posix-separated. */
  readonly dir: string;
  /**
   * File contents, decoded as UTF-8.
   *
   * The *unredacted* source. An extractor needs it — line numbers, comments,
   * and the string literals that mark where a type ends — but nothing it reads
   * from here reaches the document without passing through
   * `src/analysis/structures/redact.ts`.
   */
  readonly source: string;
  readonly layout: StructureLayout;
}

export interface StructureExtractor {
  /**
   * Stable, lowercase, kebab-case. Used to namespace `rule` ids
   * (`<id>/datastructure-node`, `<id>/shape-edge`) and to key the per-format
   * coverage report, so it is part of the persisted document's vocabulary and
   * must not churn.
   */
  readonly id: string;
  /** Human name for the coverage report: "TypeScript declarations", "Zod". */
  readonly format: string;
  /** Lower-case extensions this extractor claims, each including the leading dot. */
  readonly extensions: readonly string[];
  extract(ctx: StructureContext): StructureResult;
}

/**
 * The rule ids a structure extractor emits. Namespaced with the extractor id at
 * emission, so this list is the complete vocabulary of `provenance.rule` for
 * derived data structures and nothing else may invent one.
 *
 * Same rule as `extractors/types.ts:168-174` and for the same reason: a rule id
 * is the answer to "how do I know this is true", and an answer that names its
 * own producer is checkable.
 */
export const RULE_DATASTRUCTURE_NODE = "datastructure-node";
export const RULE_SHAPE_EDGE = "shape-edge";
export const RULE_TRANSFORM_EDGE = "transform-edge";