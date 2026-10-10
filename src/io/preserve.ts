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