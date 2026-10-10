import { createHash } from "node:crypto";

/**
 * ADR-0006 §3 — unknown-key preservation.
 *
 * `ArchitectureSchema` and `PromptQueueSchema` are built from plain `z.object()`,
 * which **strips** unknown keys in Zod v4. Every read went through
 * `schema.parse` and every write serialised `validation.data`, so the pipeline
 * was read -> strip -> write. Any key arkive does not recognise was destroyed
 * by the next write: user fields, fields a newer arkive had written, anything
 * added by hand.
 *
 * The fix is not `.passthrough()` and not `z.looseObject()`. The fix is to stop
 * treating the Zod output as the document:
 *
 *   read:   parsed = JSON.parse(raw)
 *           result = Schema.safeParse(parsed)   <- diagnostics only
 *           document = applyZodDefaults(parsed, result.data)
 *   write:  serialise `document`, never `result.data`
 *
 * The document is the user's. Zod supplies warnings about it. Keys Zod does not
 * know about are never removed.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Merge a Zod parse result into the object that was actually parsed, without
 * letting Zod overwrite anything the document already contains.
 *
 * - A value present in `document` always wins. That is what stops the strip.
 * - A value present only in `zodOutput` is a schema default (or a default
 *   materialised for a nested object). It fills a gap the document left.
 * - Keys in `document` that Zod does not know about pass through untouched,
 *   at every level, including inside arrays of objects.
 *
 * The result is still schema-valid: `zodOutput` came from `safeParse`, and the
 * only values taken from it are the ones the document omitted.
 */
export function applyZodDefaults<T>(document: unknown, zodOutput: T): T {
  if (Array.isArray(document)) {
    if (!Array.isArray(zodOutput)) return document as T;
    return document.map((item, index) =>
      applyZodDefaults(item, zodOutput[index])
    ) as T;
  }

  if (isPlainObject(document) && isPlainObject(zodOutput)) {
    const merged: Record<string, unknown> = { ...document };
    for (const [key, defaultValue] of Object.entries(zodOutput)) {
      merged[key] = key in merged
        ? applyZodDefaults(merged[key], defaultValue)
        : defaultValue;
    }
    return merged as T;
  }

  return (document === undefined ? zodOutput : document) as T;
}

/**
 * Copy every key `zodSource` does not recognise from `source` onto `target`.
 *
 * `migrateV1ToV2` is a *semantic* transform: it reads named fields off a v1
 * document and builds a fresh v2 one, so a key the v1 schema did not know is
 * dropped on the floor. That is correct for the fields it renames and wrong
 * for everything else, and "wrong" here means a user field destroyed by the
 * next write — the exact class ADR-0006 §3 closes. v1 is still a stripping
 * schema and is left that way deliberately (loosening it would materialise its
 * `.default()`s into every existing user's file); the fix belongs on the write
 * side, and this is the write side.
 *
 * `zodSource` is the oracle, not a hand-written key list: whatever Zod knew
 * about is known, and whatever it did not is by definition the user's.
 *
 * A key the target already has is never overwritten. The migrated object is
 * authoritative for everything the schema knows about; this only fills in what
 * the schema does not have an opinion on.
 */
export function carryUnknownKeys<T>(
  source: unknown,
  zodSource: unknown,
  target: T,
  omit: ReadonlySet<string> = new Set()
): T {
  if (Array.isArray(source) && Array.isArray(zodSource)) {
    source.forEach((item, index) => {
      const zodItem = zodSource[index];
      const targetItem = Array.isArray(target) ? target[index] : undefined;
      if (zodItem !== undefined && targetItem !== undefined) {
        carryUnknownKeys(item, zodItem, targetItem, omit);
      }
    });
    return target;
  }

  if (!isPlainObject(source) || !isPlainObject(zodSource) || !isPlainObject(target)) {
    return target;
  }

  const sink = target as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (omit.has(key)) continue;

    const zodValue = zodSource[key];
    if (zodValue === undefined) {
      // Zod has never heard of it, so it is the user's. Never clobber.
      if (!(key in sink)) sink[key] = source[key];
      continue;
    }

    const targetValue = sink[key];
    if (
      (Array.isArray(source[key]) && Array.isArray(targetValue)) ||
      (isPlainObject(source[key]) && isPlainObject(targetValue))
    ) {
      carryUnknownKeys(source[key], zodValue, targetValue, omit);
    }
  }

  return target;
}

/**
 * `JSON.stringify` with object keys sorted, so two structurally identical
 * documents hash the same regardless of key order.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Content hash used to deduplicate snapshots.
 *
 * ADR-0002 bounds `arkive/history/` at 10 *distinct states*. Deduplicating on
 * the raw document does not work, because `project.lastUpdated` changes on
 * every write and would make every single write a distinct "state". Callers
 * normalise the volatile fields out before calling this — see
 * `architecture-file.ts`.
 */
export function contentHash(value: unknown, length = 12): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf-8")
    .digest("hex")
    .slice(0, length);
}

/**
 * Describe the keys a schema does not recognise, for a warning message.
 * Unknown keys are *not* an error — they are data this arkive version is too
 * old to understand, and the point is to say so, not to act.
 */
export function collectUnknownKeys(
  document: unknown,
  zodOutput: unknown,
  path = ""
): string[] {
  if (Array.isArray(document) && Array.isArray(zodOutput)) {
    const found: string[] = [];
    document.forEach((item, index) => {
      const zodItem = zodOutput[index];
      if (zodItem !== undefined) {
        found.push(...collectUnknownKeys(item, zodItem, `${path}[${index}]`));
      }
    });
    return found;
  }

  if (!isPlainObject(document) || !isPlainObject(zodOutput)) return [];

  const found: string[] = [];
  for (const key of Object.keys(document)) {
    const child = `${path}.${key}`.replace(/^\./, "");
    if (!(key in zodOutput)) {
      found.push(child);
      continue;
    }
    found.push(...collectUnknownKeys(document[key], zodOutput[key], child));
  }
  return found;
}