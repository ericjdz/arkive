import { readFileSync, existsSync, mkdirSync, openSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARKIVE_DIR } from "./architecture-file.js";
import { PromptQueueSchema } from "../schema/prompt-queue.js";
import type { PromptQueue, QueuedPrompt } from "../schema/prompt-queue.js";
import { writeFileAtomic } from "./atomic-write.js";
import { applyZodDefaults, contentHash } from "./preserve.js";

export const PROMPT_QUEUE_FILENAME = "prompt-queue.json";

const LOCK_FILENAME = `${PROMPT_QUEUE_FILENAME}.lock`;

/** How long a claim is honoured before the reaper releases it. */
export const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1000;

/** A lock older than this belongs to a process that died holding it. */
const LOCK_STALE_MS = 30 * 1000;

/** Total time a caller will wait for the lock before giving up. */
const LOCK_TIMEOUT_MS = 5 * 1000;

const LOCK_POLL_MS = 5;

/**
 * `claimExpiresAt` is written by this module and is not in `QueuedPromptSchema`
 * — the schema is owned elsewhere and is being rewritten concurrently. It
 * survives anyway, because the queue obeys the same rule as the architecture
 * document (ADR-0006 §3): validate into a side channel, write the document.
 */
interface LeasedPrompt extends QueuedPrompt {
  claimExpiresAt?: string;
}

interface LeasedQueue {
  version: string;
  prompts: LeasedPrompt[];
}

export type QueueReadResult =
  | { success: true; data: PromptQueue }
  | { success: false; error: string };

export type PromptResult =
  | { success: true; data: QueuedPrompt }
  | { success: false; error: string };

export type ClaimResult =
  | { success: true; data: QueuedPrompt | null }
  | { success: false; error: string };

export type MutateResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function promptQueuePath(dir: string): string {
  return join(dir, ARKIVE_DIR, PROMPT_QUEUE_FILENAME);
}

export function createEmptyQueue(): PromptQueue {
  return { version: "1.0.0", prompts: [] };
}

/** Hash of the queue file as it currently stands; `null` when absent. */
function queueFileHash(dir: string): string | null {
  const path = promptQueuePath(dir);
  if (!existsSync(path)) return null;
  try {
    return contentHash(readFileSync(path, "utf-8"), 64);
  } catch {
    return null;
  }
}

export function readPromptQueue(dir: string): QueueReadResult {
  const path = promptQueuePath(dir);
  if (!existsSync(path)) {
    return { success: true, data: createEmptyQueue() };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { success: false, error: `Failed to read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { success: false, error: `Failed to parse ${path}: ${(err as Error).message}` };
  }

  const validation = PromptQueueSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `prompt-queue.json validation failed: ${validation.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  // ADR-0006 §3: `claimExpiresAt` and any future field survive the round trip.
  return { success: true, data: applyZodDefaults(parsed, validation.data) };
}

// --- Single-writer lock ----------------------------------------------------
//
// ADR-0006 §5. Three writers exist by design — the HTTP viewer, MCP over
// stdio, and the CLI — and `claimNextPrompt` used to be an unguarded
// read-modify-write. Two agents reading the same pending prompt both got it,
// both ran it, and the loser's `ack` then failed against a queue it had never
// actually written. The lock plus the hash compare-and-swap below is what makes
// README.md's "atomically claim the oldest pending prompt" true.

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(dir: string): string {
  return join(dir, ARKIVE_DIR, LOCK_FILENAME);
}

/** Thrown to unwind out of the lock without writing anything. */
class QueueWriteAborted extends Error {}

function acquireQueueLock(dir: string): () => void {
  mkdirSync(join(dir, ARKIVE_DIR), { recursive: true });
  const lockPath = lockPathFor(dir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf-8"
        );
      } finally {
        closeSync(fd);
      }

      return () => {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Already released.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // The lock vanished between the open and the stat; retry.
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the prompt queue lock at ${lockPath}. ` +
            `Another arkive process may be stuck. Delete the lock file if you are sure it is not.`
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * Run `mutate` as the single writer of the queue.
 *
 * The queue is re-read *inside* the lock, so the value `mutate` sees is the one
 * that gets written. Before committing, `commit()` re-hashes the file; if it no
 * longer matches what was read, something bypassed the lock and the mutation is
 * abandoned rather than clobbering it.
 */
function withQueueLock<T>(
  dir: string,
  mutate: (queue: LeasedQueue, commit: () => void) => T
): MutateResult<T> {
  let release: () => void;
  try {
    release = acquireQueueLock(dir);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  try {
    const read = readPromptQueue(dir);
    if (!read.success) return read;

    const queue = read.data as LeasedQueue;
    const expectedHash = queueFileHash(dir);

    const commit = (): void => {
      if (queueFileHash(dir) !== expectedHash) {
        throw new QueueWriteAborted(
          `${promptQueuePath(dir)} changed underneath this operation; refusing to overwrite it`
        );
      }
      const written = writeQueueUnlocked(dir, queue);
      if (!written.success) throw new QueueWriteAborted(written.error);
    };

    return { success: true, data: mutate(queue, commit) };
  } catch (err) {
    if (err instanceof QueueWriteAborted) {
      return { success: false, error: err.message };
    }
    throw err;
  } finally {
    release();
  }
}

function writeQueueUnlocked(
  dir: string,
  queue: LeasedQueue
): { success: true; data: PromptQueue } | { success: false; error: string } {
  const validation = PromptQueueSchema.safeParse(queue);
  if (!validation.success) {
    return {
      success: false,
      error: `Invalid queue data: ${validation.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  const path = promptQueuePath(dir);
  mkdirSync(join(dir, ARKIVE_DIR), { recursive: true });

  try {
    writeFileAtomic(path, JSON.stringify(queue, null, 2) + "\n");
  } catch (err) {
    return { success: false, error: `Failed to write ${path}: ${(err as Error).message}` };
  }

  return { success: true, data: queue };
}

/**
 * Replace the whole queue.
 *
 * Takes the lock because this is a whole-document write: two concurrent callers
 * each holding a stale copy would otherwise silently drop one another's
 * prompts. Prefer `addPrompt` / `claimNextPrompt` / `ackPrompt`, which read
 * inside the lock and cannot lose a concurrent update.
 */
export function writePromptQueue(
  dir: string,
  queue: PromptQueue
): MutateResult<PromptQueue> {
  const requested = queue as LeasedQueue;

  const validation = PromptQueueSchema.safeParse(requested);
  if (!validation.success) {
    return {
      success: false,
      error: `Invalid queue data: ${validation.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  return withQueueLock(dir, () => {
    const path = promptQueuePath(dir);
    mkdirSync(join(dir, ARKIVE_DIR), { recursive: true });
    try {
      writeFileAtomic(path, JSON.stringify(requested, null, 2) + "\n");
    } catch (err) {
      throw new QueueWriteAborted(`Failed to write ${path}: ${(err as Error).message}`);
    }
    return requested as PromptQueue;
  });
}

export interface ClaimOptions {
  leaseMs?: number;
  /**
   * Injectable clock, so tests do not have to sleep. A claim taken with an
   * injected `now` far in the past is already expired against the real clock by
   * the time the next operation runs — that is correct, not a bug.
   */
  now?: number;
}

function nextPromptId(prompts: QueuedPrompt[]): string {
  let max = 0;
  for (const p of prompts) {
    const m = /^p-(\d+)$/.exec(p.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `p-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Release claims whose lease has run out.
 *
 * Without this, an agent that claimed a prompt and then crashed left it in
 * `claimed` forever: `claimNextPrompt` only ever selects `status === "pending"`,
 * so the prompt was wedged with no way back. Claims written by an older arkive
 * carry no `claimExpiresAt`, so their `claimedAt` plus a default lease is used
 * instead — that also un-wedges prompts wedged before this change.
 */
function reapExpired(queue: LeasedQueue, now: number): LeasedPrompt[] {
  const released: LeasedPrompt[] = [];

  for (const prompt of queue.prompts) {
    if (prompt.status !== "claimed") continue;

    const expiresAt = prompt.claimExpiresAt
      ? Date.parse(prompt.claimExpiresAt)
      : prompt.claimedAt
        ? Date.parse(prompt.claimedAt) + DEFAULT_CLAIM_LEASE_MS
        : Number.NaN;

    if (Number.isNaN(expiresAt) || expiresAt > now) continue;

    prompt.status = "pending";
    delete prompt.claimedAt;
    delete prompt.claimExpiresAt;
    delete prompt.agent;
    released.push(prompt);
  }

  return released;
}

export type ReapResult =
  | { success: true; released: string[] }
  | { success: false; error: string };

/**
 * Public reaper, so a wedged queue can be cleared without waiting for the next
 * claim attempt. Returns the ids released back to `pending`.
 */
export function reapExpiredClaims(dir: string, now = Date.now()): ReapResult {
  const result = withQueueLock(dir, (queue, commit) => {
    const released = reapExpired(queue, now);
    if (released.length > 0) commit();
    return released.map((p) => p.id);
  });

  return result.success
    ? { success: true, released: result.data }
    : result;
}

export function addPrompt(
  dir: string,
  targetServices: string[],
  prompt: string
): PromptResult {
  return withQueueLock(dir, (queue, commit) => {
    reapExpired(queue, Date.now());

    const newPrompt: LeasedPrompt = {
      id: nextPromptId(queue.prompts),
      targetServices,
      prompt,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    queue.prompts.push(newPrompt);
    commit();
    return newPrompt;
  });
}

/**
 * Atomically claim the oldest pending prompt.
 *
 * Holds the queue lock across the read, the mutation and the write, so two
 * concurrent callers are serialised and exactly one of them receives a given
 * prompt. The loser gets `{ success: true, data: null }` — there is nothing
 * left to claim — not a second copy of work already in flight.
 *
 * A claim carries a lease (`claimExpiresAt`). If the claiming agent dies, the
 * prompt returns to `pending` when the lease runs out instead of wedging.
 */
export function claimNextPrompt(
  dir: string,
  agent?: string,
  options: ClaimOptions = {}
): ClaimResult {
  return withQueueLock(dir, (queue, commit) => {
    const now = options.now ?? Date.now();
    reapExpired(queue, now);

    const pending = queue.prompts.find((p) => p.status === "pending");
    if (!pending) return null;

    pending.status = "claimed";
    pending.claimedAt = new Date(now).toISOString();
    pending.claimExpiresAt = new Date(
      now + (options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS)
    ).toISOString();
    if (agent) pending.agent = agent;

    commit();
    return pending;
  });
}

function transitionClaimedPrompt(
  dir: string,
  promptId: string,
  status: "done" | "failed"
): { success: true } | { success: false; error: string } {
  const result = withQueueLock(dir, (queue, commit) => {
    reapExpired(queue, Date.now());

    const prompt = queue.prompts.find((p) => p.id === promptId);
    if (!prompt) throw new QueueWriteAborted(`Prompt ${promptId} not found`);
    if (prompt.status !== "claimed") {
      throw new QueueWriteAborted(`Prompt ${promptId} is ${prompt.status}, expected claimed`);
    }

    prompt.status = status;
    prompt.completedAt = new Date().toISOString();
    delete prompt.claimExpiresAt;

    commit();
    return { success: true as const };
  });

  return result.success ? result.data : { success: false, error: result.error };
}

export function ackPrompt(
  dir: string,
  promptId: string
): { success: true } | { success: false; error: string } {
  return transitionClaimedPrompt(dir, promptId, "done");
}

export function failPrompt(
  dir: string,
  promptId: string
): { success: true } | { success: false; error: string } {
  return transitionClaimedPrompt(dir, promptId, "failed");
}

export function listPendingPrompts(dir: string): QueuedPrompt[] {
  const read = readPromptQueue(dir);
  if (!read.success) return [];
  return read.data.prompts.filter((p) => p.status === "pending");
}