import { stripJsNoise } from "../extractors/ts-js.js";
import { LineIndex } from "../source-text.js";
import { normaliseFieldName, spliceRedacted } from "./redact.js";
import type {
  ExtractedStructure,
  StructureContext,
  StructureExtractor,
  StructureField,
  StructureResult,
  StructureUsage,
} from "./types.js";

/**
 * TypeScript / JavaScript data-structure extraction.
 *
 * ## The four declaration forms, and why all four
 *
 * `interface X {}`, `type X = {}`, `class X {}` property declarations, and
 * `declare module`-less ambient shapes. They are one extractor because they
 * share a lexer — `stripJsNoise` already exists and is already honest about
 * comments and strings — and splitting them would mean four extractors claiming
 * `.ts`, which `ExtractorRegistry`'s duplicate-claim guard throws on.
 *
 * ## The thing this file must not do
 *
 * It must not read a value. There is no code path from a source literal to a
 * `StructureField.type`: every type is spliced through `spliceRedacted`, which
 * replaces literals with their kind. See `src/analysis/structures/redact.ts` for
 * why a transformer is used rather than a denylist.
 *
 * ## What a regex can and cannot read here
 *
 * It can read declarations, because a declaration has a fixed shape: a keyword,
 * a name, a brace-delimited body, `name: Type` separated by `;` or a newline.
 * That is enough for the overwhelming majority of interfaces and type aliases in
 * real code.
 *
 * It cannot read:
 * - a type spanning a nested `z.object({...})` (Zod's file, not this one);
 * - computed or conditional members (`[K in keyof T]: ...`);
 * - declarations inside a namespace block beyond the first nesting level.
 *
 * Each of those sets `complete: false` for the file rather than producing a
 * half-read shape, because a `datastructure` node with three of nine fields is
 * indistinguishable from a `datastructure` node with three fields.
 */

/** Keywords that introduce a declaration this extractor owns. */
const DECLARATION_KEYWORDS = ["interface", "class", "enum"] as const;

/**
 * Where a member is *not* a field.
 *
 * A class declaration carries methods, and a `type` alias carries index
 * signatures. Both are real, and neither is a field of the record the shape
 * describes. Dropping them is not the same as failing to read them: the shape's
 * fields are complete, and the methods are behaviour the `calls` edge kinds
 * cover (ADR-0001:72).
 */
const NON_FIELD_MEMBERS = new Set([
  "constructor",
  "prototype",
  "constructor.name",
]);

export const tsStructureExtractor: StructureExtractor = {
  id: "ts-types",
  format: "TypeScript declarations",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"],

  extract(ctx: StructureContext): StructureResult {
    const structures: ExtractedStructure[] = [];
    const complete = { ok: true as boolean, note: undefined as string | undefined };

    // The import extractor blanks comments and string literals while preserving
    // length, which is what makes `file:line` evidence honest
    // (`src/analysis/extractors/ts-js.ts:30-37`). Reusing it here means this file
    // inherits that property instead of re-deriving it, and a structure's
    // evidence points at the same lines the import edge does.
    const stripped = stripJsNoise(ctx.source);
    if (!stripped.complete) {
      return {
        structures: [],
        usages: [],
        transformations: [],
        complete: false,
        note: `unterminated literal at ${stripped.note ?? "end of file"}; ` +
          `no structure was read from this file rather than a partial one`,
      };
    }

    const code = stripped.code;
    const lines = new LineIndex(ctx.source);

    for (const keyword of DECLARATION_KEYWORDS) {
      readDeclarations(code, ctx, keyword, lines, structures, complete);
    }
    readTypeAliases(code, ctx, lines, structures, complete);

    const usages = collectUsages(code, ctx, lines);

    return {
      structures,
      usages,
      transformations: [],
      complete: complete.ok,
      ...(complete.note !== undefined ? { note: complete.note } : {}),
    };
  },
};

/**
 * `interface X { … }` and `class X { … }`.
 *
 * Both are scanned with the same body reader because both put their fields in a
 * brace-delimited block whose members are `name: Type`. The difference — a class
 * also has a heritage clause and methods — is handled by the member reader, which
 * drops what is not a field.
 */
function readDeclarations(
  code: string,
  ctx: StructureContext,
  keyword: string,
  lines: LineIndex,
  out: ExtractedStructure[],
  state: { ok: boolean; note: string | undefined }
): void {
  const pattern = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?${keyword}\\s+([A-Za-z_$][\\w$]*)([^\\{]*)\\{`,
    "g"
  );

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const name = match[1];
    const braceAt = match.index + match[0].length - 1;
    const body = readBraceBody(code, braceAt);

    if (body === null) {
      state.ok = false;
      state.note = `${keyword} "${name}" has an unbalanced body; the file was not ` +
        `fully read rather than partially`;
      continue;
    }

    const fields = readMembers(ctx, code, body.start, body.end, lines);

    out.push({
      name,
      path: ctx.path,
      extractorId: tsStructureExtractor.id,
      form: keyword === "interface" ? "interface" : keyword === "class" ? "class" : "enum",
      line: lines.lineAt(match.index),
      exported: isExported(match[0]),
      fields,
      ...referencesOf(fields),
    });
  }
}

/**
 * `type X = { … }`.
 *
 * Only object-literal aliases produce a shape. `type Id = string` is a name for
 * a primitive, not a record, and emitting a `datastructure` node for it would put
 * a one-field-less node in the graph that answers no question — "what does a
 * `UserId` contain" has the answer "nothing", which is not the kind of answer
 * worth a node and an edge set.
 *
 * `type X = A | B` and `type X = A & B` are unions and intersections of other
 * shapes. They are not recorded as shapes because the shape they describe is
 * already recorded, twice, and a third node that is the union of two would make
 * the coupling count report three modules where there are two.
 */
function readTypeAliases(
  code: string,
  ctx: StructureContext,
  lines: LineIndex,
  out: ExtractedStructure[],
  state: { ok: boolean; note: string | undefined }
): void {
  const pattern = /\b(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^={}]*?>)?\s*=\s*(?=\{)/g;

  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    const name = match[1];
    // `\s*` before the lookahead is greedy and consumes the space before `{`, so
    // `match[0]` ends one character *before* the brace. `length - 1` points at
    // that space, `readBraceBody` returns null, and every object-literal type
    // alias in the repository silently derives with zero fields — a shape that
    // exists in no file.
    const braceAt = match.index + match[0].length;
    const body = readBraceBody(code, braceAt);

    if (body === null) {
      state.ok = false;
      state.note = `type alias "${name}" has an unbalanced body; the file was not ` +
        `fully read rather than partially`;
      continue;
    }

    const fields = readMembers(ctx, code, body.start, body.end, lines);

    out.push({
      name,
      path: ctx.path,
      extractorId: tsStructureExtractor.id,
      form: "type-alias",
      line: lines.lineAt(match.index),
      exported: isExported(match[0]),
      fields,
      ...referencesOf(fields),
    });
  }
}

interface BraceBody {
  /** Offset just past the opening brace. */
  start: number;
  /** Offset of the closing brace. */
  end: number;
}

/**
 * The span between a `{` and its match.
 *
 * `null` when there is no match — a truncated file, or a brace inside a template
 * that the blanker did not remove. The caller turns that into `complete: false`
 * rather than into an empty field list.
 */
function readBraceBody(code: string, braceAt: number): BraceBody | null {
  let depth = 0;
  for (let i = braceAt; i < code.length; i += 1) {
    const char = code[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start: braceAt + 1, end: i };
    }
  }
  return null;
}

/**
 * Read `name: Type` members out of a declaration body.
 *
 * Split on `;` and on newlines at depth zero, because both are member
 * separators in TypeScript and a body that uses only one of them is common.
 * Splitting on either alone loses half of every real interface.
 *
 * A member that is not a field — a method, an index signature, a `get`/`set`, a
 * computed key — is skipped without marking the file incomplete. It is a
 * *different kind of member*, not an unreadable one, and counting it as a
 * failure would drop the coverage of every class in the repository to zero.
 */
function readMembers(
  ctx: StructureContext,
  code: string,
  start: number,
  end: number,
  lines: LineIndex
): StructureField[] {
  const fields: StructureField[] = [];
  const body = code.slice(start, end);

  for (const span of splitMembers(body)) {
    const raw = body.slice(span.start, span.end);
    // The span is member-relative and `text` is trimmed, so the member's real
    // start has to be recovered before any offset arithmetic. Getting this wrong
    // by even one character shifts every field's type text — and a type text
    // citing the wrong span is a type text that is quietly wrong, which is worse
    // than a missing field.
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) continue;

    const member = parseMember(
      ctx,
      code,
      start + span.start + leading,
      span.end + start,
      text,
      lines
    );
    if (member === null) continue;
    if (NON_FIELD_MEMBERS.has(member.name)) continue;
    fields.push(member.field);
  }

  return fields;
}

/**
 * Member spans within a body, in source order, relative to the body.
 *
 * Newline-separated members are the case that matters. `interface Point {\n  x: number\n  y: number\n}`
 * has no semicolons at all, and a splitter that only looked for `;` would report
 * one field of type `number y: number`.
 */
function splitMembers(body: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let memberStart = 0;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
    else if (char === "}" || char === ")" || char === "]" || char === ">") depth -= 1;
    else if (depth === 0 && char === ";") {
      spans.push({ start: memberStart, end: i });
      memberStart = i + 1;
    } else if (depth === 0 && char === "\n") {
      // Only a separator if what follows starts a new member. A multi-line type
      // annotation continues across the newline, and `x: {\n a: 1\n}` must not
      // become two members.
      const rest = body.slice(i + 1).trimStart();
      if (rest.length === 0) {
        // End of the body. The pending member is **flushed**, not dropped —
        // without this the last field of every semicolon-free interface
        // disappears, because there is nothing after it to trigger a split.
        spans.push({ start: memberStart, end: i });
        memberStart = i + 1;
        continue;
      }
      if (!startsMember(rest)) continue;
      spans.push({ start: memberStart, end: i });
      memberStart = i + 1;
    }
  }

  if (memberStart < body.length) spans.push({ start: memberStart, end: body.length });
  return spans.filter((span) => body.slice(span.start, span.end).trim().length > 0);
}

/** Does this text begin something that can only be a new member? */
function startsMember(text: string): boolean {
  // A member name followed by a type annotation, a quoted key, an accessor, or
  // a modifier. The modifier and accessor alternatives matter: without them
  // `get size(): number` does not start a member, so it merges with whatever
  // follows it and the *next* real field is lost inside it.
  return /^(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|override\s+|declare\s+)?(?:[A-Za-z_$][\w$]*\s*[?]?\s*:|["']|(?:get|set)\s)/.test(
    text
  );
}

interface ParsedMember {
  name: string;
  field: StructureField;
}

/**
 * One `name?: Type` member.
 *
 * `null` for anything that is not a field. The rejections are deliberate and
 * each one has a reason:
 *
 * - `[key: string]: T` — an index signature. It has no field name and describes
 *   the shape of *unknown* keys; emitting it as a field named `[key: string]`
 *   would put a literal that is not a field into a field list.
 * - `readonly x: T` — the `readonly` is stripped and the field is recorded,
 *   because mutability is not part of the record's identity.
 * - `new (): T` and `get x(): T` — accessors, not fields.
 * - a bare `x` with no `:` — a method name or a property shorthand; there is no
 *   type to record.
 */
function parseMember(
  ctx: StructureContext,
  code: string,
  start: number,
  end: number,
  text: string,
  lines: LineIndex
): ParsedMember | null {
  // Strip modifiers by *offset*, not by string replacement. The type text is
  // spliced out of `code[start…end]` by byte position, so every character
  // removed from the front has to be added back to the offset or the type comes
  // from the wrong place — which is a plausible-looking wrong type rather than
  // an obvious failure.
  let offset = 0;
  let body = text;
  const modifiers =
    /^(?:readonly\s+|static\s+|declare\s+|abstract\s+|override\s+|public\s+|private\s+|protected\s+)+/;
  const stripped = modifiers.exec(body);
  if (stripped !== null) {
    offset += stripped[0].length;
    body = body.slice(offset);
  }

  if (body.startsWith("[") || body.startsWith("(") || body.startsWith("new ")) return null;
  if (/^(?:get|set)\s/.test(body)) return null;

  const colon = findTopLevelColon(body);
  if (colon === -1) return null;

  const rawName = body.slice(0, colon).trim();
  // A method signature's "name" is `render()` — the parentheses are the tell.
  // Emitting it as a field called `render()` puts a call signature into a field
  // list, and a reader counting the fields of a record counts behaviour as data.
  if (rawName.includes("(") || rawName.includes(")") || rawName.includes("<")) return null;

  const optional = rawName.endsWith("?");
  const name = normaliseFieldName(optional ? rawName.slice(0, -1).trim() : rawName);
  if (name.length === 0) return null;

  const spliced = spliceRedacted(ctx.source, code, start + offset + colon + 1, end);

  return {
    name,
    field: {
      name,
      type: spliced.text,
      optional,
      line: lines.lineAt(start),
      ...(spliced.literals > 0 ? { literals: spliced.literals } : {}),
    },
  };
}

/** The `:` that separates a member's name from its type, ignoring nesting. */
function findTopLevelColon(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{" || char === "(" || char === "[" || char === "<") depth += 1;
    else if (char === "}" || char === ")" || char === "]" || char === ">") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

/** Names of structures a field's type text refers to. */
function referencesOf(fields: readonly StructureField[]): { references?: string[] } {
  const names = new Set<string>();
  for (const field of fields) {
    for (const match of field.type.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
      if (!isBuiltInType(match[1])) names.add(match[1]);
    }
  }
  return names.size === 0 ? {} : { references: [...names].sort() };
}

/**
 * Type names that look like structures and are not.
 *
 * A list, not a rule, because there is no rule: `Promise` is a global type in
 * every project that uses it and a perfectly good user-defined interface in one
 * that does not. What this guards against is the common case — a field typed
 * `Promise<User>` should reference `User`, not also `Promise`, and emitting an
 * edge to a `datastructure:Promise` node that resolves to nothing is a dangling
 * reference the schema validator would then report as critical on every project
 * on earth.
 */
const BUILT_IN_TYPE_NAMES = new Set([
  "Array", "Promise", "Record", "Map", "Set", "Readonly", "Partial", "Required",
  "Pick", "Omit", "Exclude", "Extract", "ReturnType", "Parameters", "Awaited",
  "NonNullable", "Parameters", "InstanceType", "ThisType", "ConstructorParameters",
  "Date", "Error", "RegExp", "Function", "Object", "String", "Number", "Boolean",
  "Symbol", "BigInt", "JSON", "Math", "Reflect", "Buffer", "URL", "Uint8Array",
]);

function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPE_NAMES.has(name);
}

/**
 * Was this declaration exported?
 *
 * Read from the **matched text**, not from the characters before the match. The
 * match begins at `export`, so a lookbehind examines whatever preceded the
 * declaration and reports every exported interface in the repository as
 * unexported.
 */
function isExported(matchText: string): boolean {
  return /^\s*(?:export\b)/.test(matchText);
}

/**
 * Where a file touches a structure, and in which direction.
 *
 * ## The rule, and why it is a rule rather than a guess
 *
 * Issue 0006 §2 asks that "which modules write this shape" answer correctly, so
 * the direction has to be established from something. Four constructions state it
 * outright, and all four are lexical:
 *
 * | Construction | Direction | Why it is certain |
 * |---|---|---|
 * | `new Name(` | writes | A constructor invocation produces an instance. |
 * | `: Name = {` | writes | An object literal annotated with the type is constructed to it. |
 * | `satisfies Name` | writes | The literal was just built and checked against the type. |
 * | `Name.parse(x)` / `.safeParse(x)` | writes | The call validates input *into* the shape. |
 *
 * Everything else — a parameter annotation, a return type, a property type, a
 * generic argument — is a **read**, and that is not a guess either: a type
 * position with no construction attached to it is a position that consumes a
 * value.
 *
 * ## What is deliberately not claimed
 *
 * A variable annotated `: Name` with no initialiser is a read. It might later be
 * assigned by a call this layer cannot follow, and calling it a write would be a
 * claim about a construction that was never observed.
 *
 * Every usage carries `establishedBy` naming the construction that matched it, so
 * a reader can tell a `new Name(` write from a `: Name` read without opening the
 * file.
 */
function collectUsages(
  code: string,
  ctx: StructureContext,
  lines: LineIndex
): StructureUsage[] {
  const usages: StructureUsage[] = [];
  const writes = new Set<string>();

  const recordWrite = (
    name: string,
    line: number,
    establishedBy: string,
    constructionLines: number[] = [line]
  ): void => {
    if (isBuiltInType(name)) return;
    for (const at of constructionLines) writes.add(`${name}@${at}`);
    usages.push({
      name,
      path: ctx.path,
      line,
      direction: "writes",
      establishedBy,
      constructionLines: constructionLines.length > 1 ? constructionLines : undefined,
    });
  };

  // --- writes -----------------------------------------------------------------
  const construct = /\bnew\s+([A-Z][A-Za-z0-9_$]*)\s*[(<]/g;
  construct.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = construct.exec(code)) !== null) {
    recordWrite(match[1], lines.lineAt(match.index), "new");
  }

  // `: Name = {` — a literal built against an annotation. The `{` is what makes
  // it certain: `: Name = someFactory()` has no observed construction.
  const annotatedLiteral = /:\s*([A-Z][A-Za-z0-9_$]*)\s*=\s*\{/g;
  annotatedLiteral.lastIndex = 0;
  while ((match = annotatedLiteral.exec(code)) !== null) {
    recordWrite(match[1], lines.lineAt(match.index), "annotated-literal");
  }

  const satisfies = /\bsatisfies\s+([A-Z][A-Za-z0-9_$]*)/g;
  satisfies.lastIndex = 0;
  while ((match = satisfies.exec(code)) !== null) {
    recordWrite(match[1], lines.lineAt(match.index), "satisfies");
  }

  const parse = /\b([A-Z][A-Za-z0-9_$]*)\s*\.\s*(safeParse|safeParseAsync|parse|parseAsync|decode)\s*\(/g;
  parse.lastIndex = 0;
  while ((match = parse.exec(code)) !== null) {
    recordWrite(match[1], lines.lineAt(match.index), `${match[2]}()`);
  }

  // `function f(): Name { return { … } }` — a function whose declared return type
  // is the shape and whose body returns an object literal. This is *the* way a
  // TypeScript codebase produces a value, and without it the write side of every
  // pure function is invisible, which would make "which modules write this
  // shape" answer "the ones with a `new`" and under-report by an order of
  // magnitude.
  //
  // It is certain rather than guessed: the return type states what the literal
  // becomes, and the `return {` states that a literal is what leaves. Neither
  // alone is enough — `: Name` with a bare `return someFactory()` is a read,
  // and that case stays a read.
  const returnsLiteral = /\)\s*:\s*([A-Z][A-Za-z0-9_$]*)\s*\{/g;
  returnsLiteral.lastIndex = 0;
  while ((match = returnsLiteral.exec(code)) !== null) {
    const name = match[1];
    const signatureLine = lines.lineAt(match.index);
    const body = readBraceBody(code, match.index + match[0].length - 1);
    if (body === null) continue;

    const bodyText = code.slice(body.start, body.end);
    const returned = /\breturn\s*\{/.exec(bodyText);
    if (returned === null) continue;

    // Evidence points at the `return {`, which is where the value is actually
    // built, not at the signature. The signature is still listed as a line this
    // construction accounts for, because that is where the `: Name` type
    // reference sits — otherwise the same declaration counts as a read too.
    recordWrite(
      name,
      lines.lineAt(body.start + returned.index),
      "return-literal",
      [signatureLine, lines.lineAt(body.start + returned.index)]
    );
  }

  // --- reads ------------------------------------------------------------------
  const reference =
    /(?::|<|\bextends\b|\bimplements\b|\bas\b|\bsatisfies\b|\||&|=>)\s*([A-Z][A-Za-z0-9_$]*)/g;
  reference.lastIndex = 0;
  while ((match = reference.exec(code)) !== null) {
    const name = match[1];
    if (isBuiltInType(name)) continue;
    const line = lines.lineAt(match.index);
    // A write outranks a read at the same site: a literal constructed against a
    // type is both mentioned and produced, and recording only the read would
    // under-report the coupling that matters most.
    if (writes.has(`${name}@${line}`)) continue;
    usages.push({
      name,
      path: ctx.path,
      line,
      direction: "reads",
      establishedBy: "type-reference",
    });
  }

  return usages.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}