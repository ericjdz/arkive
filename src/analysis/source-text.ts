/**
 * Shared text utilities for extractors.
 *
 * These live outside `src/analysis/extractors/` on purpose: they are not
 * language knowledge, they are mechanics every lexer needs, and keeping them
 * out of the extractor directory is what lets "add a language = one file in
 * `extractors/`" stay literally true.
 */

/**
 * Byte-offset to 1-based line number.
 *
 * Built once per file in O(n) with `indexOf`, then answered in O(log n) per
 * query. A linear `content.split("\n")` per match would be O(matches × lines),
 * which is the difference between a 5,000-file scan finishing in a second and
 * finishing in ten.
 */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) {
      this.starts.push(at + 1);
    }
  }

  /** 1-based line containing byte `offset`. Offsets past the end clamp to the last line. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/**
 * Replace `[start, end)` ranges with spaces, keeping every newline.
 *
 * Newlines are the whole point: an extractor that blanks a comment must still be
 * able to report `file:line` for the statement after it. A blanker that
 * deleted the text instead would silently shift every subsequent line number,
 * which would make every `evidence` entry after the first comment a lie.
 */
export function blankRanges(
  source: string,
  ranges: ReadonlyArray<readonly [number, number]>
): string {
  if (ranges.length === 0) return source;

  const ordered = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;

  for (const [rawStart, rawEnd] of ordered) {
    const start = Math.max(rawStart, cursor);
    const end = Math.max(rawEnd, cursor);
    if (end <= start) continue;
    if (rawStart > cursor) parts.push(source.slice(cursor, rawStart));
    parts.push(source.slice(start, end).replace(/[^\n]/g, " "));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}