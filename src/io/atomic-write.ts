import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * Transactional file writes.
 *
 * ADR-0006 §2: "no path, schema, or configuration change may destroy user data
 * silently". A bare `writeFileSync` truncates the destination before the new
 * bytes land. A crash, a full disk, or a concurrent reader at that instant sees
 * a truncated document, and the agent that owns the document has no way to
 * recover it.
 *
 * The sequence here is:
 *
 *   write <tmp in the same directory> -> fsync(file) -> rename -> fsync(dir)
 *
 * The `rename` is the commit point. It is atomic on POSIX and on NTFS, so a
 * reader sees either the whole old file or the whole new one, never a mixture,
 * and a crash before the rename leaves the previous version untouched.
 */

/**
 * Test-only fault injection. Set `ARKIVE_FAULT_BEFORE_RENAME` to `throw` (or
 * any other value) to fail with an exception after the temp file is fsynced but
 * before the commit rename, or to `exit` to hard-kill the process there.
 *
 * Used by tests to pin ADR-0006 regression test F: a failure between temp-write
 * and rename must leave the original file byte-intact.
 */
export const FAULT_BEFORE_RENAME_ENV = "ARKIVE_FAULT_BEFORE_RENAME";

/** Temp files older than this are leftovers from a crash, not live work. */
const STALE_TEMP_MS = 60 * 60 * 1000;

const TEMP_SUFFIX = ".tmp";

export interface AtomicWriteOptions {
  /**
   * Force the fault-injection path regardless of the environment. Exists so
   * tests can exercise the torn-write path without mutating `process.env`.
   */
  faultBeforeRename?: boolean | "exit";
}

function shouldFault(mode: boolean | "exit" | undefined): "throw" | "exit" | null {
  if (mode === true) return "throw";
  if (mode === "exit") return "exit";

  const configured = process.env[FAULT_BEFORE_RENAME_ENV];
  if (!configured) return null;
  return configured === "exit" ? "exit" : "throw";
}

/** `true` when `path` is one of our own leftover temp files. */
export function isTempFile(path: string): boolean {
  return basename(path).endsWith(TEMP_SUFFIX) && basename(path).startsWith(".");
}

function tempPathFor(filePath: string): string {
  // The temp file must live in the destination directory: `rename` is only
  // atomic within a single filesystem, and `/tmp` is frequently a different one.
  const unique = `${process.pid}.${randomBytes(6).toString("hex")}`;
  return join(dirname(filePath), `.${basename(filePath)}.${unique}${TEMP_SUFFIX}`);
}

/**
 * Best-effort directory fsync so the rename itself survives a power loss.
 * Windows cannot open a directory as a file, so failure here is expected and
 * ignored on every platform.
 */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported on this platform. The rename is still atomic.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Write `contents` to `filePath` atomically: the destination either keeps its
 * previous bytes or gains the complete new ones. Creates parent directories.
 *
 * Throws on failure, having left both the destination and the directory clean.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Renaming over an existing file would otherwise reset its permissions to the
  // mode the temp file was created with.
  const existingStat = statSync(filePath, { throwIfNoEntry: false });
  const mode = existingStat ? existingStat.mode & 0o777 : 0o644;

  const tmpPath = tempPathFor(filePath);
  let fd: number | undefined;

  try {
    fd = openSync(tmpPath, "wx", mode);
    writeFileSync(fd, contents, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    const fault = shouldFault(options.faultBeforeRename);
    if (fault === "exit") process.exit(70);
    if (fault === "throw") {
      throw new Error(`Injected fault before committing ${filePath}`);
    }

    renameSync(tmpPath, filePath); // The commit point.
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best effort: a leftover temp file is inert and cleaned up later.
    }
    throw err;
  }

  syncDirectory(dir);
}

/**
 * Remove temp files abandoned by a crashed process.
 *
 * A hard crash between temp-write and rename leaves a dot-prefixed `.tmp` file
 * behind. It is inert — no reader looks at it — but it should not accumulate.
 */
export function cleanupStaleTempFiles(dir: string, olderThanMs = STALE_TEMP_MS): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  const cutoff = Date.now() - olderThanMs;

  for (const entry of entries) {
    if (!isTempFile(entry)) continue;
    const full = join(dir, entry);
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;
      rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // Another process may have cleaned it up first.
    }
  }

  return removed;
}