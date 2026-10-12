/**
 * Redaction. The guarantee that `arkive/architecture.json` cannot leak a secret.
 *
 * ## The threat model, stated once so the rest of this file can be short
 *
 * `arkive/architecture.json` is **committed to a git repository** and may be
 * read by anyone with access to it. It is not a private cache and not a local
 * database; it is a file that gets pushed. Every byte this layer writes to it
 * is therefore a byte that may be published.
 *
 * `docs/issues/0006-data-structure-extraction.md` §4 states the rule: *"Extract
 * structure and types only. Never literal values."* A schema that says
 * `password: z.string()` produces a field named `password` of type `string`. It
 * never produces `"hunter2"`, and it never produces `"hunter2"` with the quotes
 * stripped, truncated, base64'd, or written to a side file.
 *
 * ## Why the rule is expressed as a *transformer* and not as a filter
 *
 * The obvious implementation is a denylist: scan the finished node for anything
 * that looks like a secret and drop it. That is the wrong shape, for three
 * reasons that all point the same way:
 *
 * 1. A denylist is a guess about what a secret looks like. It misses whatever
 *    nobody thought of, and a miss here is silent and permanent.
 * 2. A denylist that fires has already seen the value, which means the value was
 *    in memory, in the derivation result, and possibly in a log line.
 * 3. A denylist can only be applied to *strings that look like values*. A field
 *    named `password` with type `"hunter2"` passes through it, because it looks
 *    like a perfectly ordinary field.
 *
 * So this file never produces a value in the first place. `redactTypeText` is
 * the only path by which source text reaches a field's `type`, and it replaces
 * every literal **token** with the **kind** of that token (`string`, `number`,
 * `boolean`). The shape of the type survives — a reader learns that a field is
 * constrained to three string literals — and none of the three do.
 *
 * `findLiteralTokens` is the auditor that backs the test. It is not on the
 * production path; it exists so `tests/analysis/structures/redaction.test.ts`
 * can assert the absence of every string literal in a derived fixture rather
 * than asserting the presence of a blocklist hit.
 */

/**
 * The word that replaces a string literal.
 *
 * A string literal *type* (`status: "draft" | "published"`) is a fact about the
 * shape: the field is constrained to a closed set. Dropping it entirely would
 * lose real structure. Keeping its contents would violate the rule above. So it
 * becomes `string`, and {@link StructureFieldLiteralCount} on the field records
 * that a constraint of that width exists.
 */
const STRING_KIND = "string";
const NUMBER_KIND = "number";

/**
 * `redactTypeText`, applied to every type string on its way out of an extractor.
 *
 * Runs on text the extractor *believes* is already value-free, which is exactly
 * why it is worth having: it is the backstop that makes a bug in a future
 * extractor unable to reach the document rather than able to.
 *
 * Replaces:
 * - `"…"` / `'…'` / `` `…` `` → `string`
 * - `true` / `false` → `boolean`
 * - bare numeric literals → `number`
 *
 * and normalises whitespace so that two runs over the same source produce
 * byte-identical output. `arkive reconcile` commits that output; a type string
 * that reformats itself between runs produces a diff on every run for no reason.
 */
export function redactTypeText(text: string): string {
  const replaced = text
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, STRING_KIND)
    .replace(/"(?:[^"\\\n]|\\[\s\S])*"/g, STRING_KIND)
    .replace(/'(?:[^'\\\n]|\\[\s\S])*'/g, STRING_KIND)
    .replace(/\b(?:true|false)\b/g, "boolean")
    .replace(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$])/g, NUMBER_KIND);

  return collapseTypeText(replaced);
}

/**
 * Tidy a type string: collapse runs of whitespace, drop empty union and
 * intersection members, de-duplicate adjacent members, and cap the length.
 *
 * The cap exists because a type is still source text. A pathological type such
 * as a 4,000-character generic instantiation is not structure a reader can use,
 * and a long string in a committed document is one more thing to review. Nothing
 * is lost by truncating here, because a type text contains no values —
 * {@link redactTypeText} has already guaranteed that.
 */
export function collapseTypeText(text: string): string {
  // Trimmed **first**. A type spliced out of source almost always begins with a
  // space (`: string` leaves one after the colon), and an untrimmed leading
  // segment is not equal to the identical segment that follows it — so
  // `"draft" | "live" | "archived"` deduped to `" string|string"` and recorded a
  // union of three as a union of two. A cosmetic normalisation that changes the
  // meaning of a type is worse than no normalisation at all.
  const collapsed = text
    .trim()
    .replace(/\s+/g, " ")
    // `:` is deliberately **not** in this class. Stripping the space after it
    // turns `{ host: string; port: number }` into `{host:string;port:number;}`,
    // which is still correct and no longer readable — and a nested object type
    // is exactly the case where a human is most likely to be reading it.
    .replace(/\s*([|,&<>(){};])\s*/g, "$1")
    .replace(/^(?:[|&]\s*)+|[|&]\s*$/g, "")
    .replace(/([|&])\s*\|/g, "$1");

  return dedupeAdjacent(collapsed).slice(0, MAX_TYPE_TEXT).trim();
}

/**
 * How long a recorded type may be before it is cut.
 *
 * 160 characters is comfortably longer than any type a person writes by hand
 * (`Map<string, Array<{ id: string; label: string }>>` is 48) and short enough
 * that one pathological declaration cannot dominate a document review.
 */
const MAX_TYPE_TEXT = 160;

function dedupeAdjacent(text: string): string {
  const parts = text.split("|").map((part) => part.trim());
  const out: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (out[out.length - 1] === part) continue;
    out.push(part);
  }
  return out.join("|");
}

/**
 * A field name, normalised.
 *
 * Field names are **not** redacted. ADR-0002:71 puts field names on the derived
 * side of the ledger, and the issue's own example depends on it: a reader has to
 * be able to learn that a field called `password` exists, because that is the
 * structural fact. What must never survive is the field's *value*.
 *
 * This function exists to bound a name, not to judge one. An object key in a
 * source file can be arbitrarily long and can contain control characters; a
 * committed document should not be able to carry either.
 */
export const MAX_FIELD_NAME = 120;

export function normaliseFieldName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0) return "";
  return cleaned.length > MAX_FIELD_NAME
    ? `${cleaned.slice(0, MAX_FIELD_NAME - 1)}…`
    : cleaned;
}

/**
 * Walk an arbitrary derived value and report every string literal in it.
 *
 * **Not on the production path.** It exists so the redaction guarantee is
 * tested by absence rather than by denylist: a fixture full of secret-shaped
 * fields is derived, this is run over the result, and the test asserts the list
 * is empty. A denylist that misses a secret fails to fire; a literal scanner
 * that reports every literal cannot.
 *
 * It reports *any* string literal, not a judged subset, which is what makes it
 * usable as an oracle. The test then subtracts the strings it expects
 * (field names, type words, rule ids) and asserts nothing else is left.
 */
export function findLiteralTokens(value: unknown, path = "$", out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(`${path} = ${JSON.stringify(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findLiteralTokens(entry, `${path}[${index}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      findLiteralTokens(entry, `${path}.${key}`, out);
    }
  }
  return out;
}

/**
 * How many literal tokens a source range contained, and of what kinds.
 *
 * Used by the TypeScript extractor to answer "is this field constrained to a
 * closed set?" without answering "which set?". A field whose type is three
 * string literals records `type: "string"` and `literals: 3` — the constraint is
 * structure, the members are values.
 *
 * Comments are skipped. A type annotation carrying a doc comment with a quoted
 * example (`/** the literal "red" *\/`) is common, and counting the example
 * would report a constraint the type does not have. The consequence of a
 * miscount is a slightly wrong count on one field; nothing derived from this
 * function is ever a value.
 */
export function countLiterals(
  source: string,
  code: string,
  start: number,
  end: number
): { count: number; kinds: Set<string> } {
  const kinds = new Set<string>();
  let count = 0;
  let i = start;

  while (i < end) {
    const raw = source[i];
    const blanked = code[i] !== raw;

    if (raw === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 || nl > end ? end : nl;
      continue;
    }
    if (raw === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 || close + 2 > end ? end : close + 2;
      continue;
    }

    if (blanked && (raw === '"' || raw === "'" || raw === "`")) {
      kinds.add(STRING_KIND);
      count += 1;
      i = skipQuoted(source, i, end);
      continue;
    }
    if (blanked && isNumericStart(source, i)) {
      kinds.add(NUMBER_KIND);
      count += 1;
      while (i < end && /[\w.]/.test(source[i])) i += 1;
      continue;
    }
    if (blanked) {
      // Blanked but not a literal: a regex body, or a run of whitespace inside a
      // template. Skip whatever the blanker skipped so the offsets stay aligned.
      i += 1;
      continue;
    }

    i += 1;
  }

  return { count, kinds };
}

function isNumericStart(source: string, at: number): boolean {
  if (!/[0-9]/.test(source[at])) return false;
  const before = source[at - 1];
  if (before !== undefined && /[\w$.]/.test(before)) return false;
  const after = source[at + 1];
  if (after !== undefined && /[\w$]/.test(after)) return false;
  return true;
}

function skipQuoted(source: string, start: number, end: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < end) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return end;
}

/**
 * Splice a source range against the same range of its blanked twin.
 *
 * `stripJsNoise` (`src/analysis/extractors/ts-js.ts:92`) replaces comments and
 * string literals with spaces while preserving length, which is what keeps
 * `evidence: ["file:line"]` honest. That same property is what makes this
 * possible: where `original[i] !== code[i]`, the original held a literal or a
 * comment, and there is no need to re-lex to find out which.
 *
 * Literals become their kind word. Comments are dropped. Everything else is
 * copied through and tidied by {@link collapseTypeText}.
 */
export function spliceRedacted(
  original: string,
  code: string,
  start: number,
  end: number
): { text: string; literals: number; kinds: Set<string> } {
  let out = "";
  let literals = 0;
  const kinds = new Set<string>();
  let i = start;

  while (i < end) {
    if (code[i] === original[i]) {
      out += original[i];
      i += 1;
      continue;
    }

    // A blanked region. Decide what it was from the original text.
    const raw = original[i];
    if (raw === '"' || raw === "'" || raw === "`") {
      out += STRING_KIND;
      literals += 1;
      kinds.add(STRING_KIND);
      i = skipQuoted(original, i, end);
      continue;
    }
    if (raw === "/" && (original[i + 1] === "/" || original[i + 1] === "*")) {
      const nl = original.indexOf("\n", i);
      const close = original.indexOf("*/", i + 2);
      if (raw === "/" && original[i + 1] === "/" && nl !== -1 && nl < end) {
        i = nl;
      } else {
        i = close === -1 || close + 2 > end ? end : close + 2;
      }
      continue;
    }
    if (isNumericStart(original, i)) {
      out += NUMBER_KIND;
      literals += 1;
      kinds.add(NUMBER_KIND);
      while (i < end && /[\w.]/.test(original[i])) i += 1;
      continue;
    }
    // A regex body, or the interior of a template. Nothing nameable survives it.
    i += 1;
  }

  return { text: collapseTypeText(out), literals, kinds };
}