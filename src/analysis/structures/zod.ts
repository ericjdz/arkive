import { stripJsNoise } from "../extractors/ts-js.js";
import { LineIndex } from "../source-text.js";
import { normaliseFieldName, redactTypeText, countLiterals } from "./redact.js";
import type {
  ExtractedStructure,
  StructureContext,
  StructureExtractor,
  StructureField,
  StructureResult,
  StructureTransformation,
  StructureUsage,
} from "./types.js";

/**
 * Zod schema extraction.
 *
 * ## Why Zod is its own extractor and not a mode of `ts-types.ts`
 *
 * A Zod schema is not a type declaration; it is a **runtime object built by
 * calls**. `z.object({ name: z.string(), age: z.number().min(0) })` has fields,
 * but it has them as *expressions*, and the type is recoverable only by reading
 * the expression tree. The arguments carry runtime values — `.default("hunter2")`,
 * `.describe("the admin password is hunter2")`, `.regex(/^sk_live_/)` — and every
 * one of those is a value this extractor must not emit.
 *
 * That is why this file cannot share a code path with the TypeScript reader even
 * though both use `stripJsNoise`. The TS reader splices type *syntax*; this one
 * reads call *expressions* and deliberately discards every argument.
 *
 * ## What is extracted
 *
 * - `const X = z.object({ … })` → a `datastructure` with one field per member.
 * - `z.string()`, `z.number()`, etc. → the field's type.
 * - `z.array(T)` → `T[]`.
 * - `.optional()` / `.nullish()` → `optional: true`.
 * - `.nullable()` → the type widens with `| null`.
 * - `.optional()`/`.default()` chains are read, **the argument is not**.
 * - `z.enum([...])` → the field's type, with the member *count* and no members.
 * - `.transform(fn)` → a field flag, not a call to follow.
 *
 * ## What is never extracted, and why that is the important part
 *
 * Every argument to every call. `z.string().min(8)` records `type: "string"` and
 * nothing about 8 — a length constraint is a validation rule, not a field of the
 * record, and the constraint's argument is a number that could be anything.
 * `.default(x)` records `optional: true` and discards `x` entirely. If `x` were
 * a secret, a schema-derived graph would publish it to a git remote, and no
 * redaction rule applied downstream could un-publish it.
 *
 * The test in `tests/analysis/structures/redaction.test.ts` is built around a
 * fixture with secret-shaped fields *and* secret-shaped defaults, and asserts
 * that no string from the fixture appears anywhere in the derived output.
 */

/** `z.` prefixed constructors, mapped to the type text a field records. */
const ZOD_SCALARS: ReadonlyMap<string, string> = new Map([
  ["string", "string"],
  ["number", "number"],
  ["bigint", "bigint"],
  ["boolean", "boolean"],
  ["date", "date"],
  ["symbol", "symbol"],
  ["null", "null"],
  ["undefined", "undefined"],
  ["void", "void"],
  ["any", "any"],
  ["unknown", "unknown"],
  ["never", "never"],
  ["nan", "number"],
]);

/**
 * Validation methods that wrap the type without changing it.
 *
 * These are recorded as *constraints*, not as types, and their arguments are
 * discarded. `z.string().min(8).max(64)` is a string field whose length is
 * constrained — the constraints are the schema author's intent and are useful —
 * but `8` and `64` are values, and this extractor does not emit values.
 *
 * `describe` is in this list deliberately. Its argument is prose, and prose in a
 * schema is exactly where an example payload gets written:
 * `.describe("example: { password: 'hunter2' }")`. It is the single most likely
 * place a secret lands in a committed file, and dropping the argument costs
 * nothing structural.
 */
const ZOD_CONSTRAINTS: ReadonlySet<string> = new Set([
  "min", "max", "length", "gt", "gte", "lt", "lte", "email", "url", "uuid", "cuid",
  "regex", "includes", "startsWith", "endsWith", "trim", "toLowerCase", "toUpperCase",
  "int", "positive", "nonnegative", "negative", "nonpositive", "multipleOf", "finite",
  "safe", "nonempty", "nullable", "describe", "brand", "catch", "default",
  "readonly", "deep", "strict", "passthrough", "strip",
]);

/** Methods that mark the field optional. */
const OPTIONAL_METHODS: ReadonlySet<string> = new Set(["optional", "nullish", "default", "catch"]);

/** Methods that introduce a runtime transformation, which is not a type. */
const TRANSFORM_METHODS: ReadonlySet<string> = new Set(["transform", "pipe", "preprocess", "refine", "superRefine"]);

/**
 * `.pick()` / `.omit()` — the two Zod methods that state a mapping outright.
 *
 * Both take a set of field names and produce a different shape. That is a
 * transformation written down rather than inferred, which is the only kind issue
 * 0006 §3 can honestly record.
 */
const PICK_METHODS: ReadonlySet<string> = new Set(["pick", "omit", "extend", "partial", "required", "merge", "catchall"]);

export const zodStructureExtractor: StructureExtractor = {
  id: "zod",
  format: "Zod schemas",
  extensions: [".ts", ".tsx", ".mts", ".cts"],

  extract(ctx: StructureContext): StructureResult {
    const stripped = stripJsNoise(ctx.source);
    if (!stripped.complete) {
      return {
        structures: [],
        usages: [],
        transformations: [],
        complete: false,
        note: `unterminated literal at ${stripped.note ?? "end of file"}; ` +
          `no schema was read from this file rather than a partial one`,
      };
    }

    // **The blanked text is what gets parsed**, not the source.
    //
    // That sounds backwards for a reader that wants `z.enum(["a","b"])`, and it
    // is not: every part of a schema this extractor reads — `z.object`, the
    // member separators, `.optional()`, `.default(`, `.omit(` — survives
    // blanking, because none of them is a literal. What does not survive is
    // every string and every comment, and a comment inside a `z.object` body
    // otherwise merges itself into the next member and swallows its name.
    //
    // It also means redaction here is structural rather than filtered: there is
    // no code path from a source literal to a field's `type`, because the text
    // those types are read from does not contain literals.
    const code = stripped.code;
    const lines = new LineIndex(ctx.source);

    const structures: ExtractedStructure[] = [];
    const transformations: StructureTransformation[] = [];
    const complete = { ok: true as boolean, note: undefined as string | undefined };

    const binding = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*/g;
    binding.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = binding.exec(code)) !== null) {
      const name = match[1];
      const expressionAt = match.index + match[0].length;
      const chain = readChain(code, expressionAt);

      if (chain === null) continue;

      const object = chain.find((link) => link.callee === "z.object" || link.callee === "z.strictObject");

      if (object === undefined) {
        // `const PublicUser = UserSchema.omit({ secret: true })` declares no
        // `z.object`, and it is still a shape — arguably the most interesting one
        // in the file, because it is the one that crosses the trust boundary.
        // It is derived from the base schema's own field list rather than from a
        // second parse, which is what makes the derived shape exactly the base
        // shape's fields, minus or plus the ones `.omit`/`.pick` names.
        const derived = deriveFromChain(ctx, code, lines, structures, name, chain, match.index);
        if (derived !== null) structures.push(derived);
        continue;
      }

      const body = object.argument === null ? null : readBraceBody(code, object.argument);
      if (body === null) {
        complete.ok = false;
        complete.note = `schema "${name}" has an unbalanced z.object body; the file ` +
          `was not fully read rather than partially`;
        continue;
      }

      const fields = readObjectMembers(ctx, code, body.start, body.end);

      structures.push({
        name,
        path: ctx.path,
        extractorId: zodStructureExtractor.id,
        form: "zod-object",
        line: lines.lineAt(match.index),
        // Checked on the matched text rather than on the text *before* the match:
        // the match starts at `export`, so a lookbehind would examine whatever
        // happened to precede the declaration and report every exported schema
        // as unexported.
        exported: /\bexport\b/.test(match[0]),
        fields,
      });
    }

    const usages = collectUsages(code, ctx.path, lines);
    collectTransformations(ctx, code, lines, structures, transformations);

    return {
      structures,
      usages,
      transformations,
      complete: complete.ok,
      ...(complete.note !== undefined ? { note: complete.note } : {}),
    };
  },
};

/**
 * One link in a method chain: `z.object` in `z.object({…}).strict().optional()`.
 */
interface ChainLink {
  /**
   * The qualified callee, e.g. `z.object`, `CredentialsSchema.omit`, `string`.
   *
   * Qualified on purpose. `const PublicUser = UserSchema.omit({…})` names its
   * base shape through the receiver, and the receiver is what links the derived
   * shape back to the shape it came from — so it has to survive the read rather
   * than being reduced to `omit`.
   */
  callee: string;
  /** The last dotted segment: the method or function being called. */
  method: string;
  /**
   * The receiver, or `""` for a bare call. `CredentialsSchema.omit` has receiver
   * `CredentialsSchema`; `z.object` has `z`.
   *
   * This is what names the shape a derived schema came from, so it has to
   * survive separately from the method — `Base.omit` says "a shape derived from
   * `Base`", and reducing it to `omit` throws that away.
   */
  receiver: string;
  /** Offset of the argument list's `{`, when the call takes one. Null when it
   *  takes none, which is not the same as "unreadable". */
  argument: number | null;
  /** Every argument's source span, recorded so nothing from inside is emitted. */
  argumentSpans: Array<{ start: number; end: number }>;
  /** Offset of the `(` that opened the argument list. */
  openParen: number;
  /** Offset of the `)` that closed it. */
  closeParen: number;
}

/**
 * A schema derived from another by `.pick()` / `.omit()` / `.extend()`.
 *
 * ## Why this exists
 *
 * `const PublicUser = UserSchema.omit({ password: true })` is the single most
 * architecture-relevant declaration in a typical service, and without it the
 * graph shows `UserSchema` and nothing else. It is the shape that crosses the
 * trust boundary, and it is invisible.
 *
 * So it becomes a `datastructure` node in its own right, with fields computed
 * from the base schema's field list — which means the derived node's fields are
 * **exactly** the base node's fields minus the named ones, by construction rather
 * than by a second parse of the same object literal.
 *
 * The transformation edge to the base schema is emitted separately, and the two
 * halves are consistent because they come from the same field list.
 *
 * Returns `null` when the chain's base is not a shape this file already read.
 * A miss is a missing node, not a wrong one: `db.schema("users").omit({…})`
 * names something this layer cannot resolve, and inventing a shape for it would
 * be a fact about a database rather than about this code.
 */
function deriveFromChain(
  ctx: StructureContext,
  code: string,
  lines: LineIndex,
  known: readonly ExtractedStructure[],
  name: string,
  chain: readonly ChainLink[],
  bindingAt: number
): ExtractedStructure | null {
  const base = chain[0];
  if (base === undefined) return null;

  const source = known.find((entry) => entry.name === base.receiver);
  if (source === undefined) return null;

  const picker = chain.find((link) => link.method === "pick" || link.method === "omit");
  if (picker === undefined || picker.argument === null) return null;

  const body = readBraceBody(code, picker.argument);
  if (body === null) return null;

  const named = new Set(
    code
      .slice(body.start, body.end)
      .split(",")
      .map((member) => /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(member)?.[1] ?? "")
      .filter((entry) => entry.length > 0)
  );
  if (named.size === 0) return null;

  const keep = (field: { name: string }): boolean =>
    picker.method === "pick" ? named.has(field.name) : !named.has(field.name);

  return {
    name,
    path: ctx.path,
    extractorId: zodStructureExtractor.id,
    form: "zod-object",
    line: lines.lineAt(bindingAt),
    // `bindingAt` is the offset of the whole `export const X =` match, so the
    // slice starts at `export` itself rather than before it.
    exported: /\bexport\b/.test(ctx.source.slice(bindingAt, bindingAt + 8)),
    fields: source.fields.filter(keep),
  };
}

/**
 * Read a method chain, recording argument spans without reading their contents.
 *
 * The spans exist so that "there was an argument here" is distinguishable from
 * "there was no argument here" in the coverage report. A `z.object(` with no
 * closing paren anywhere in the file returns `null`, which is a coverage loss;
 * a `z.object({…})` with an unreadable *field* is not.
 */
function readChain(code: string, start: number): ChainLink[] | null {
  const links: ChainLink[] = [];
  let at = start;
  let openedAnything = false;

  for (;;) {
    const skip = skipWhitespace(code, at);
    const call = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(skip));
    if (call === null) break;

    const method = call[1];
    // The receiver prefix keeps its trailing dot — `z.object`, not `zobject`.
    // Losing it is silent: `zobject` is not a `z.` call, so the schema reader
    // finds no `z.object` and reports a file with no shapes in it.
    const receiver = call[0].slice(0, call[0].indexOf(method)).replace(/\s+/g, "");
    const callee = `${receiver}${method}`;
    const openParen = skip + call[0].length - 1;
    const closeParen = matchParen(code, openParen);
    if (closeParen === -1) return openedAnything ? links : null;

    const argumentSpans = splitArguments(code, openParen + 1, closeParen);
    const firstArgument = argumentSpans[0];
    const argument =
      firstArgument === undefined
        ? null
        : firstBraceOffset(code, firstArgument.start, firstArgument.end);

    links.push({
      callee,
      method,
      receiver: receiver.replace(/\.$/, ""),
      argument,
      argumentSpans,
      openParen,
      closeParen,
    });
    openedAnything = true;

    // Continue through `.foo(` until something that is not a call.
    const next = skipWhitespace(code, closeParen + 1);
    if (code[next] !== ".") break;
    at = next + 1;
  }

  return openedAnything ? links : null;
}

/**
 * Offset of a call's `{` argument, or `null` when it takes none.
 *
 * Skips leading whitespace rather than testing `code[start] === "{"` directly,
 * because `z.object({\n  …` puts a newline between the paren and the brace and a
 * one-character check reads that as "no argument" — a `z.object` with no body,
 * which is not a thing and therefore reads as a file with no schemas in it.
 */
function firstBraceOffset(code: string, start: number, end: number): number | null {
  const at = skipWhitespace(code, start);
  return at < end && code[at] === "{" ? at : null;
}

function skipWhitespace(code: string, at: number): number {
  let i = at;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
}

function matchParen(code: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Argument spans of a call, splitting on top-level commas. */
function splitArguments(
  code: string,
  start: number,
  end: number
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let argumentStart = start;
  let sawContent = false;

  for (let i = start; i < end; i += 1) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      if (code.slice(argumentStart, i).trim().length > 0) {
        spans.push({ start: argumentStart, end: i });
      }
      argumentStart = i + 1;
      sawContent = false;
      continue;
    }
    if (!/\s/.test(char)) sawContent = true;
  }

  if (code.slice(argumentStart, end).trim().length > 0 || sawContent) {
    spans.push({ start: argumentStart, end: end });
  }
  return spans;
}

interface BraceBody {
  start: number;
  end: number;
}

function readBraceBody(code: string, braceAt: number): BraceBody | null {
  let depth = 0;
  for (let i = braceAt; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start: braceAt + 1, end: i };
    }
  }
  return null;
}

/**
 * `name: z.string()` members of a `z.object({ … })` body.
 *
 * A member's value is a chain; the chain's *type* is what the field records and
 * the chain's *arguments* are what it never does.
 *
 * The body is read from the **blanked** text, so a comment inside the object
 * literal cannot merge into the next member and take its name with it. A quoted
 * key (`{ "user-password": z.string() }`) is blanked too, so it is recovered
 * from the original at the same offsets — the same splice trick
 * `ts-types.ts` uses, and for the same reason: blanking preserves length, so an
 * offset in one is an offset in the other.
 */
function readObjectMembers(
  ctx: StructureContext,
  code: string,
  bodyStart: number,
  bodyEnd: number
): StructureField[] {
  const fields: StructureField[] = [];
  const body = code.slice(bodyStart, bodyEnd);

  for (const span of splitObjectMembers(body)) {
    const raw = body.slice(span.start, span.end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const colon = topLevelColon(text);
    if (colon === -1) continue;

    const memberAt = bodyStart + span.start + leading;
    const name = normaliseFieldName(fieldName(ctx, code, memberAt, memberAt + colon));
    if (name.length === 0) continue;

    // `colon` indexes into the trimmed member text, so the value expression
    // starts `leading` characters past the span. Slicing the value out of the
    // original text at the wrong offset produces a plausible wrong type rather
    // than an obvious failure, which is the worst kind.
    const field = readFieldType(ctx, code, { start: memberAt + colon + 1, end: bodyStart + span.end });

    fields.push({
      name,
      type: field.type,
      optional: field.optional,
      line: lineOf(ctx.source, memberAt),
      ...(field.literals > 0 ? { literals: field.literals } : {}),
    });
  }

  return fields;
}

/**
 * A member's key, from the original source.
 *
 * Read from `ctx.source` rather than the blanked text for exactly one reason: a
 * quoted key is a string literal, and the blanker blanks it. An identifier key
 * comes back unchanged, so this is correct for both without branching.
 *
 * Field names are not redacted (ADR-0002:71 puts them on the derived side, and
 * the issue's own example depends on it), so this is the one place a source
 * string reaches the graph — and it is a *name*, never a value.
 */
function fieldName(ctx: StructureContext, code: string, start: number, end: number): string {
  const blanked = code.slice(start, end).trim();
  if (blanked.length > 0) return blanked;
  return ctx.source.slice(start, end).trim().replace(/^["']|["']$/g, "");
}

/**
 * Member spans inside `z.object({ … })`, splitting on top-level commas.
 *
 * Spans stay **body-relative**. Returning absolute spans from a function whose
 * caller also holds the body is what made the first version of this file emit
 * field names like `z.string().regex(/^sk_live_/), rotatedOn`.
 */
function splitObjectMembers(body: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let memberStart = 0;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      spans.push({ start: memberStart, end: i });
      memberStart = i + 1;
    }
  }
  if (memberStart < body.length) spans.push({ start: memberStart, end: body.length });

  return spans.filter((span) => body.slice(span.start, span.end).trim().length > 0);
}

function topLevelColon(text: string): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString !== null) {
      if (char === "\\") i += 1;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(" || char === "<") depth += 1;
    else if (char === "}" || char === "]" || char === ")" || char === ">") depth -= 1;
    else if (char === ":" && depth === 0) return i;
  }
  return -1;
}

/**
 * The type a Zod expression produces.
 *
 * ### The whole argument of every call is discarded
 *
 * This function reads callee names and arity. It never reads what is inside a
 * `(` … `)`. That is the entire redaction guarantee for Zod, expressed as a
 * property of one function rather than as a filter applied afterwards.
 *
 * `.default("hunter2")` → the field becomes optional, and `hunter2` is never
 * assigned to anything. `.min(8)` → nothing. `.describe("password is hunter2")` →
 * nothing.
 */
function readFieldType(
  ctx: StructureContext,
  code: string,
  span: { start: number; end: number }
): { type: string; optional: boolean; literals: number } {
  const chain = readChain(code, span.start) ?? [];

  /**
   * How many literals this value expression contained.
   *
   * Counted from the **original** text by comparing it against the blanked twin,
   * because the blanking is what removed them: `z.enum(["a","b"])` blanks to
   * `z.enum([        ])` and counting separators in that yields one member,
   * not two. `countLiterals` walks both strings in step and reports only what
   * the blanker removed, so the count is a fact about the source and not about
   * the redaction. The contents are never read — only how many there were.
   */
  const sourceLiterals = countLiterals(ctx.source, code, span.start, span.end).count;

  let type = "unknown";
  let optional = false;
  let literals = 0;

  for (const link of chain) {
    const method = link.method;

    if (link.callee.startsWith("z.")) {
      const scalar = ZOD_SCALARS.get(method);
      if (scalar !== undefined) {
        type = scalar;
        continue;
      }
      switch (method) {
        case "object":
        case "strictObject":
        case "looseObject":
          type = "object";
          continue;
        case "array": {
          const inner = elementTypeOfArgument(code, link);
          type = inner === null ? "array" : `${inner}[]`;
          continue;
        }
        case "tuple":
          type = "tuple";
          continue;
        case "record":
          type = "record";
          continue;
        case "map":
          type = "map";
          continue;
        case "set":
          type = "set";
          continue;
        case "enum": {
          // The members are values. Their *count* is structure.
          literals = enumMemberCount(ctx, code, link, sourceLiterals);
          type = "string";
          continue;
        }
        case "nativeEnum":
          type = "enum";
          continue;
        case "literal":
          literals = Math.max(1, sourceLiterals);
          type = "string";
          continue;
        case "union":
        case "discriminatedUnion": {
          type = "union";
          continue;
        }
        case "intersection":
          type = "intersection";
          continue;
        case "function":
          type = "function";
          continue;
        case "promise":
          type = "Promise";
          continue;
        case "custom":
        case "instanceof":
          type = "custom";
          continue;
        default:
          type = method;
          continue;
      }
    }

    if (OPTIONAL_METHODS.has(method)) {
      optional = true;
      continue;
    }
    if (method === "nullable") {
      type = type === "unknown" ? "null" : `${type}|null`;
      continue;
    }
    if (PICK_METHODS.has(method)) {
      type = `${type}`;
      continue;
    }
    if (ZOD_CONSTRAINTS.has(method)) continue;
    if (TRANSFORM_METHODS.has(method)) continue;
  }

  // Belt and braces. Nothing above assigns a source slice to `type`, so this
  // should never change anything — which is the point. It is the assertion that
  // a future edit that does assign one is caught here rather than in a repository
  // somebody else clones.
  return { type: redactTypeText(type), optional, literals };
}

/**
 * The element type of `z.array(T)`.
 *
 * Read from the **callee name** of the inner call, never from its arguments.
 * `z.array(z.enum(["a","b"]))` is `string[]` — an array of a three-word type —
 * and `z.array(z.string().min(8))` is `string[]` with a length constraint the
 * graph has no field to put, because a constraint is not part of the record.
 */
function elementTypeOfArgument(code: string, link: ChainLink): string | null {
  const argument = link.argumentSpans[0];
  if (argument === undefined) return null;

  const inner = code.slice(argument.start, argument.end);
  const call = /\bz\.([A-Za-z_$][\w$]*)/.exec(inner);
  if (call === null) return null;

  const method = call[1];
  const scalar = ZOD_SCALARS.get(method);
  if (scalar !== undefined) return scalar;
  if (method === "object" || method === "strictObject" || method === "looseObject") return "object";
  if (method === "enum") return "string";
  return method;
}

/**
 * How many members a `z.enum([...])` has.
 *
 * A count and nothing else. The members are string literals in the source and
 * this extractor does not emit string literals — which is the whole point of
 * `redact.ts`, and the reason a `z.enum(["draft", "live"])` records a
 * two-valued field without recording what the two values are.
 *
 * The count comes from `countLiterals` on the **original** text rather than from
 * separators in the blanked text. The blanker replaces each member with spaces,
 * commas included, so counting separators there reports one member for any enum
 * at all — a number that is confidently wrong rather than obviously absent.
 *
 * A native TypeScript enum (`z.nativeEnum(Role)`) names its members as
 * identifiers rather than literals, so the literal count is zero and the field
 * is recorded as `enum` with no width. A missed count, not a wrong one.
 */
function enumMemberCount(
  ctx: StructureContext,
  code: string,
  link: ChainLink,
  sourceLiterals: number
): number {
  const argument = link.argumentSpans[0];
  if (argument === undefined) return 0;

  const blanked = code.slice(argument.start, argument.end).trim();
  if (!blanked.startsWith("[") || !blanked.endsWith("]")) return 0;

  void ctx;
  return sourceLiterals;
}

/** 1-based line of a byte offset. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Where a file touches a schema, and in which direction.
 *
 * The same rule as `ts-types.ts`, and for the same reason: direction has to come
 * from a construction that states it. A schema is additionally *validated* by
 * `X.parse(...)` / `X.safeParse(...)`, which is a write — the shape is being
 * produced from untrusted input at a trust boundary, and that is the single most
 * interesting fact about a Zod schema in a graph.
 *
 * A schema's own declaration is not a usage. It is a definition, and it gets its
 * `derives_from` edge from the module, not a `writes` edge from itself.
 */
function collectUsages(code: string, path: string, lines: LineIndex): StructureUsage[] {
  const usages: StructureUsage[] = [];
  const writes = new Set<string>();

  const parse = /\b([A-Z][A-Za-z0-9_$]*)\s*\.\s*(safeParse|safeParseAsync|parse|parseAsync|decode)\s*\(/g;
  parse.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = parse.exec(code)) !== null) {
    const name = match[1];
    const line = lines.lineAt(match.index);
    writes.add(`${name}@${line}`);
    usages.push({ name, path, line, direction: "writes", establishedBy: `${match[2]}()` });
  }

  const newExpression = /\bnew\s+([A-Z][A-Za-z0-9_$]*)\s*[(<]/g;
  newExpression.lastIndex = 0;
  while ((match = newExpression.exec(code)) !== null) {
    const name = match[1];
    const line = lines.lineAt(match.index);
    if (writes.has(`${name}@${line}`)) continue;
    writes.add(`${name}@${line}`);
    usages.push({ name, path, line, direction: "writes", establishedBy: "new" });
  }

  const annotated = /:\s*([A-Z][A-Za-z0-9_$]*)\s*=\s*\{/g;
  annotated.lastIndex = 0;
  while ((match = annotated.exec(code)) !== null) {
    const name = match[1];
    const line = lines.lineAt(match.index);
    if (writes.has(`${name}@${line}`)) continue;
    writes.add(`${name}@${line}`);
    usages.push({ name, path, line, direction: "writes", establishedBy: "annotated-literal" });
  }

  const reference =
    /(?::|<|\bextends\b|\bimplements\b|\bas\b|\bsatisfies\b|\||&|=>)\s*([A-Z][A-Za-z0-9_$]*)/g;
  reference.lastIndex = 0;
  while ((match = reference.exec(code)) !== null) {
    const name = match[1];
    // A field typed `Record<string, Owner>` references `Owner`, not `Record`.
    // Without this every shape in the repository acquires a reference to
    // `datastructure::Record`, which resolves to nothing and is then reported as
    // an unresolved reference on every single file.
    if (isGlobalTypeName(name)) continue;
    const line = lines.lineAt(match.index);
    if (writes.has(`${name}@${line}`)) continue;
    usages.push({
      name,
      path,
      line,
      direction: "reads",
      establishedBy: "type-reference",
    });
  }

  return usages.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Type names that appear in type positions and are not user shapes.
 *
 * Duplicated from `ts-types.ts` rather than imported, because a structure
 * extractor must be self-contained: `ts-types.ts` is one file a user can copy
 * to add a language, and a copy that imports half of another extractor is not
 * one file. The cost is a list that has to be updated twice when a global type
 * is added, which is a visible cost rather than a silent one — a type missing
 * here produces an unresolved reference, and that is reported.
 */
const GLOBAL_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Array", "Promise", "Record", "Map", "Set", "Readonly", "Partial", "Required",
  "Pick", "Omit", "Exclude", "Extract", "ReturnType", "Parameters", "Awaited",
  "NonNullable", "InstanceType", "ThisType", "ConstructorParameters", "Date",
  "Error", "RegExp", "Function", "Object", "String", "Number", "Boolean",
  "Symbol", "BigInt", "JSON", "Math", "Reflect", "Buffer", "URL", "Uint8Array",
  "ZodType", "ZodError", "ZodIssue", "Infer",
]);

function isGlobalTypeName(name: string): boolean {
  return GLOBAL_TYPE_NAMES.has(name);
}

/**
 * `.pick({ a: true })` and `.omit({ b: true })` chains.
 *
 * ## The only transformation this layer claims to see
 *
 * These two methods state a field mapping in the source. `ServiceRecord.omit({
 * internalNotes: true })` says, in the file, that the produced shape is the
 * source shape minus one named field. That is a transformation with its mapping
 * written down, and it is emitted with `evidence` pointing at the line.
 *
 * Everything else a transformation looks like — `.transform(fn)`, a mapping
 * function, a DTO assembled field by field across two files — is not emitted.
 * ADR-0002:150-152 is explicit that a rule firing on a fraction of the cases is
 * worse than a rule that does not fire, and a transformation edge that guesses
 * its mapping would produce exactly the confident wrong structure issue 0006's
 * own risk section warns about.
 *
 * The direction is `from` the picked shape `to` the result. Both names come from
 * the same expression, so the edge resolves without a heuristic.
 */
function collectTransformations(
  ctx: StructureContext,
  code: string,
  lines: LineIndex,
  structures: readonly ExtractedStructure[],
  out: StructureTransformation[]
): void {
  const byName = new Map(structures.map((structure) => [structure.name, structure]));

  const pattern = /\b([A-Za-z_$][\w$]*)\.(pick|omit)\s*\(\s*\{/g;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const sourceName = match[1];
    const method = match[2] as "pick" | "omit";
    const source = byName.get(sourceName);
    if (source === undefined) continue;

    const openBrace = match.index + match[0].length - 1;
    const body = readBraceBody(code, openBrace);
    if (body === null) continue;

    const named = new Set(
      code
        .slice(body.start, body.end)
        .split(",")
        .map((member) => /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(member)?.[1] ?? "")
        .filter((name) => name.length > 0)
    );
    if (named.size === 0) continue;

    const targetName = enclosingBindingName(code, match.index);
    if (targetName === null) continue;

    const target = byName.get(targetName);
    const all = source.fields.map((field) => field.name);
    const chosen = method === "pick" ? [...named].sort() : all.filter((name) => !named.has(name)).sort();

    out.push({
      from: sourceName,
      to: targetName,
      path: ctx.path,
      line: lines.lineAt(match.index),
      fields: chosen.map((name) => ({ from: name, to: target?.fields.find((f) => f.name === name)?.name ?? name })),
      unmapped: target === undefined ? [] : target.fields.map((field) => field.name).filter((name) => !chosen.includes(name)).sort(),
      dropped: method === "omit" ? [...named].sort() : all.filter((name) => !named.has(name)).sort(),
    });
  }
}

/**
 * The `const X =` a call site sits inside.
 *
 * Walking backwards to the nearest `const`/`let`/`var` and reading the name is
 * how the *result* of `ServiceRecord.omit({…})` is named. It is a lexical
 * lookup, not a scope analysis: a call inside a function body would name the
 * function's nearest enclosing binding. That is a miss, not a wrong answer —
 * `readBraceBody` and the `byName` lookup both fail and nothing is emitted —
 * and a lexical miss is visible as a missing edge where a wrong one would be
 * visible only by being wrong.
 */
function enclosingBindingName(code: string, at: number): string | null {
  const before = code.slice(0, at);
  const pattern = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*[^;{]*$/;
  const found = pattern.exec(before);
  return found === null ? null : found[1];
}