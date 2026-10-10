import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_CLAIM_LEASE_MS,
  PROMPT_QUEUE_FILENAME,
  ackPrompt,
  addPrompt,
  claimNextPrompt,
  failPrompt,
  reapExpiredClaims,
  readPromptQueue,
  writePromptQueue,
  createEmptyQueue,
  promptQueuePath,
} from "../../src/io/prompt-queue.js";
import { FAULT_BEFORE_RENAME_ENV } from "../../src/io/atomic-write.js";

const execAsync = promisify(exec);
const REPO_ROOT = process.cwd();
const CLI_TIMEOUT = 90_000;
// ESM import specifiers for absolute Windows paths must be file:// URLs.
const QUEUE_MODULE = pathToFileURL(join(REPO_ROOT, "src", "io", "prompt-queue.ts")).href;

interface OnDiskPrompt {
  id: string;
  status: string;
  claimExpiresAt?: string;
  claimedAt?: string;
  completedAt?: string;
  agent?: string;
}

function readOnDisk(dir: string): { version: string; prompts: OnDiskPrompt[] } {
  return JSON.parse(readFileSync(promptQueuePath(dir), "utf-8"));
}

/**
 * Run one real, separate process against the queue. The point of these tests is
 * that the lock is taken by the filesystem, not by a JavaScript call frame, so
 * an in-process interleaving would not exercise it.
 */
async function runInChild(dir: string, script: string, ...args: string[]): Promise<string> {
  const runner = join(dir, `runner-${Math.abs(script.length * 31 + args.join("").length)}.mts`);
  writeFileSync(runner, script, "utf-8");
  const quoted = [runner, ...args].map((a) => `"${a}"`).join(" ");
  const { stdout } = await execAsync(`npx tsx ${quoted}`, {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

const claimScript = (dir: string): string => `
import { claimNextPrompt } from ${JSON.stringify(QUEUE_MODULE)};
const r = claimNextPrompt(${JSON.stringify(dir)}, process.argv[2]);
process.stdout.write(JSON.stringify({
  success: r.success,
  id: r.success ? r.data?.id ?? null : null,
  agent: r.success ? r.data?.agent ?? null : null,
}));
`;

const addScript = (dir: string): string => `
import { addPrompt } from ${JSON.stringify(QUEUE_MODULE)};
const r = addPrompt(${JSON.stringify(dir)}, [], "racing add");
process.stdout.write(JSON.stringify({ success: r.success, id: r.success ? r.data.id : null }));
`;

describe("regression J — claiming is genuinely atomic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-claim-"));
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a one-prompt queue yields the prompt to exactly one of two claims", () => {
    addPrompt(tempDir, [], "Only one of us should get this");

    const first = claimNextPrompt(tempDir, "agent-a");
    const second = claimNextPrompt(tempDir, "agent-b");

    expect(first.success && first.data?.agent).toBe("agent-a");
    // The loser gets nothing, not a second copy of work already in flight.
    expect(second.success).toBe(true);
    expect(second.success && second.data).toBeNull();

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts).toHaveLength(1);
    expect(onDisk.prompts[0].status).toBe("claimed");
    expect(onDisk.prompts[0].agent).toBe("agent-a");
  });

  it("two OS processes racing for the same prompt: exactly one wins", async () => {
    addPrompt(tempDir, [], "Contended prompt");

    // The case the README's "atomically claim" was always describing and never
    // delivering: two independent writers, one prompt, one winner.
    const [a, b] = await Promise.all([
      runInChild(tempDir, claimScript(tempDir), "agent-a"),
      runInChild(tempDir, claimScript(tempDir), "agent-b"),
    ]);

    const results = [a, b].map((stdout) => JSON.parse(stdout) as { success: boolean; id: string | null; agent: string | null });
    const winners = results.filter((r) => r.success && r.id !== null);

    expect(winners).toHaveLength(1);
    expect(winners[0].agent).toMatch(/^agent-[ab]$/);

    // Exactly one claim on disk — not two writers each believing they won.
    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts).toHaveLength(1);
    expect(onDisk.prompts.filter((p) => p.status === "claimed")).toHaveLength(1);
  }, CLI_TIMEOUT);

  it("fourteen processes over a ten-prompt queue hand out ten distinct prompts", async () => {
    for (let i = 0; i < 10; i += 1) addPrompt(tempDir, [], `prompt ${i}`);

    const attempts = await Promise.all(
      Array.from({ length: 14 }, (_, i) => runInChild(tempDir, claimScript(tempDir), `agent-${i}`))
    );

    const claimed = attempts
      .map((stdout) => JSON.parse(stdout) as { success: boolean; id: string | null })
      .filter((r) => r.success && r.id !== null)
      .map((r) => r.id);

    // Fourteen agents, ten prompts, ten winners — and no prompt issued twice.
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed).size).toBe(10);

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts.filter((p) => p.status === "claimed")).toHaveLength(10);
    expect(onDisk.prompts.filter((p) => p.status === "pending")).toHaveLength(0);
  }, CLI_TIMEOUT);

  it("concurrent adds do not collide on generated ids", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runInChild(tempDir, addScript(tempDir)))
    );

    const ids = results.map((stdout) => (JSON.parse(stdout) as { id: string }).id);
    expect(new Set(ids).size).toBe(8);

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts).toHaveLength(8);
    expect(new Set(onDisk.prompts.map((p) => p.id)).size).toBe(8);
  }, CLI_TIMEOUT);

  it("the lock does not survive the operation that took it", () => {
    addPrompt(tempDir, [], "one");
    claimNextPrompt(tempDir, "agent");
    expect(existsSync(`${promptQueuePath(tempDir)}.lock`)).toBe(false);
  });

  it("a torn write during a claim leaves the queue intact and fails cleanly", () => {
    addPrompt(tempDir, [], "one");
    addPrompt(tempDir, [], "two");
    const before = readFileSync(promptQueuePath(tempDir), "utf-8");

    process.env[FAULT_BEFORE_RENAME_ENV] = "throw";
    const result = claimNextPrompt(tempDir, "agent");
    delete process.env[FAULT_BEFORE_RENAME_ENV];

    expect(result.success).toBe(false);
    expect(readFileSync(promptQueuePath(tempDir), "utf-8")).toBe(before);
    expect(readdirSync(join(tempDir, "arkive")).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("an abandoned lock is broken rather than deadlocking forever", () => {
    const lockPath = `${promptQueuePath(tempDir)}.lock`;
    writeFileSync(
      promptQueuePath(tempDir),
      JSON.stringify({
        version: "1.0.0",
        prompts: [
          { id: "p-001", targetServices: [], prompt: "orphan lock", status: "pending", createdAt: "2026-05-07T00:00:00.000Z" },
        ],
      })
    );
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: "2020-01-01T00:00:00.000Z" }));
    // Backdate it past the staleness window: the holder is never coming back.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    const result = claimNextPrompt(tempDir, "agent");

    expect(result.success && result.data?.id).toBe("p-001");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("a claimed prompt has a lease, so a crashed agent cannot wedge the queue", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-lease-"));
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedPrompts(prompts: Record<string, unknown>[]): void {
    writeFileSync(
      promptQueuePath(tempDir),
      JSON.stringify(
        {
          version: "1.0.0",
          prompts: prompts.map((p, i) => ({
            id: `p-${String(i + 1).padStart(3, "0")}`,
            targetServices: [],
            prompt: `prompt ${i}`,
            status: "pending",
            createdAt: "2026-05-07T00:00:00.000Z",
            ...p,
          })),
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
  }

  it("stamps claimExpiresAt on the claim, and it reaches disk", () => {
    const t0 = Date.parse("2026-05-07T12:00:00.000Z");
    addPrompt(tempDir, [], "leased");

    const claim = claimNextPrompt(tempDir, "agent", { leaseMs: 60_000, now: t0 });

    expect(claim.success).toBe(true);
    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts[0].claimExpiresAt).toBeTruthy();
    expect(Date.parse(onDisk.prompts[0].claimExpiresAt!)).toBe(t0 + 60_000);
  });

  it("a claim is honoured until the lease runs out, then the same prompt is reissued", () => {
    const t0 = Date.parse("2026-05-07T12:00:00.000Z");
    addPrompt(tempDir, [], "wedged by a crash");

    expect(claimNextPrompt(tempDir, "doomed", { leaseMs: 1000, now: t0 }).success).toBe(true);

    // Still inside the lease: nothing to take.
    const during = claimNextPrompt(tempDir, "other", { now: t0 + 999 });
    expect(during.success && during.data).toBeNull();

    // Lease expired: the prompt is back in play, and it is the same prompt.
    const after = claimNextPrompt(tempDir, "other", { now: t0 + 1001 });
    expect(after.success).toBe(true);
    expect(after.success && after.data?.prompt).toBe("wedged by a crash");
    expect(after.success && after.data?.agent).toBe("other");

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts[0].agent).toBe("other");
    expect(Date.parse(onDisk.prompts[0].claimedAt!)).toBe(t0 + 1001);
  });

  it("releases an expired claim with no leftover lease fields", () => {
    const t0 = Date.parse("2026-05-07T12:00:00.000Z");
    addPrompt(tempDir, [], "lease hygiene");
    claimNextPrompt(tempDir, "doomed", { leaseMs: 1000, now: t0 });

    reapExpiredClaims(tempDir, t0 + 5000);

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts[0].status).toBe("pending");
    expect(onDisk.prompts[0].claimExpiresAt).toBeUndefined();
    expect(onDisk.prompts[0].claimedAt).toBeUndefined();
    expect(onDisk.prompts[0].agent).toBeUndefined();
  });

  it("reapExpiredClaims reports what it released, and nothing when idle", () => {
    const t0 = Date.parse("2026-05-07T12:00:00.000Z");
    addPrompt(tempDir, [], "a");
    addPrompt(tempDir, [], "b");
    claimNextPrompt(tempDir, "doomed", { leaseMs: 1000, now: t0 });

    const idle = reapExpiredClaims(tempDir, t0 + 100);
    expect(idle.success).toBe(true);
    expect(idle.success && idle.released).toEqual([]);

    const due = reapExpiredClaims(tempDir, t0 + 5000);
    expect(due.success && due.released).toEqual(["p-001"]);
  });

  it("un-wedges a prompt that was already wedged by an older arkive", () => {
    // No `claimExpiresAt` at all — written by a version that predates the lease,
    // which is every claim already sitting in a real prompt-queue.json today.
    seedPrompts([
      { status: "claimed", claimedAt: "2020-01-01T00:00:00.000Z", agent: "long-dead" },
    ]);

    const claim = claimNextPrompt(tempDir, "rescuer");

    expect(claim.success && claim.data?.id).toBe("p-001");
    expect(claim.success && claim.data?.agent).toBe("rescuer");
  });

  it("does not un-wedge a recent claim that predates the lease field", () => {
    seedPrompts([
      { status: "claimed", claimedAt: new Date(Date.now() - 1000).toISOString(), agent: "still-working" },
    ]);

    const claim = claimNextPrompt(tempDir, "impatient");

    expect(claim.success && claim.data).toBeNull();
    expect(readOnDisk(tempDir).prompts[0].agent).toBe("still-working");
  });

  it("ack clears the lease and marks the prompt done", () => {
    addPrompt(tempDir, [], "finish me");
    const claim = claimNextPrompt(tempDir, "agent");
    expect(claim.success && claim.data?.id).toBe("p-001");

    expect(ackPrompt(tempDir, "p-001").success).toBe(true);

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts[0].status).toBe("done");
    expect(onDisk.prompts[0].claimExpiresAt).toBeUndefined();
    expect(onDisk.prompts[0].completedAt).toBeTruthy();
  });

  it("fail clears the lease and marks the prompt failed", () => {
    addPrompt(tempDir, [], "break me");
    claimNextPrompt(tempDir, "agent");

    expect(failPrompt(tempDir, "p-001").success).toBe(true);

    const onDisk = readOnDisk(tempDir);
    expect(onDisk.prompts[0].status).toBe("failed");
    expect(onDisk.prompts[0].claimExpiresAt).toBeUndefined();
  });

  it("a completed prompt is never reaped back into the queue", () => {
    // Uses the real clock throughout: a completed prompt has no lease left to
    // expire, so no amount of elapsed time can reopen it.
    addPrompt(tempDir, [], "finish me");
    claimNextPrompt(tempDir, "agent");
    ackPrompt(tempDir, "p-001");

    const released = reapExpiredClaims(tempDir, Date.now() + 60 * 60 * 1000);

    expect(released.success && released.released).toEqual([]);
    expect(readOnDisk(tempDir).prompts[0].status).toBe("done");
  });

  it("the default lease is ten minutes", () => {
    expect(DEFAULT_CLAIM_LEASE_MS).toBe(10 * 60 * 1000);
  });
});

describe("prompt queue durability", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-queue-"));
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a parseable queue even when the process dies mid-write", () => {
    addPrompt(tempDir, [], "survives");
    const before = readFileSync(promptQueuePath(tempDir), "utf-8");

    process.env[FAULT_BEFORE_RENAME_ENV] = "throw";
    addPrompt(tempDir, [], "never lands");
    delete process.env[FAULT_BEFORE_RENAME_ENV];

    expect(readFileSync(promptQueuePath(tempDir), "utf-8")).toBe(before);
    const read = readPromptQueue(tempDir);
    expect(read.success).toBe(true);
    expect(read.success && read.data.prompts).toHaveLength(1);
  });

  it("preserves unknown keys on prompts — the queue follows the same rule as the document", () => {
    writeFileSync(
      promptQueuePath(tempDir),
      JSON.stringify({
        version: "1.0.0",
        "x-queue-level": "keep me too",
        prompts: [
          {
            id: "p-001",
            targetServices: [],
            prompt: "hand-annotated",
            status: "pending",
            createdAt: "2026-05-07T00:00:00.000Z",
            "x-user-field": "keep me",
          },
        ],
      }),
      "utf-8"
    );

    addPrompt(tempDir, [], "triggers a rewrite");

    const after = JSON.parse(readFileSync(promptQueuePath(tempDir), "utf-8"));
    expect(after.prompts[0]["x-user-field"]).toBe("keep me");
    expect(after["x-queue-level"]).toBe("keep me too");
  });

  it("persists the lease field, which the queue schema does not declare", () => {
    addPrompt(tempDir, [], "leased");
    claimNextPrompt(tempDir, "agent", { leaseMs: 5000 });

    addPrompt(tempDir, [], "second write");

    expect(readOnDisk(tempDir).prompts[0].claimExpiresAt).toBeTruthy();
  });

  it("a corrupt queue is a read error, not a silent empty queue", () => {
    writeFileSync(promptQueuePath(tempDir), "{ not json", "utf-8");
    expect(readPromptQueue(tempDir).success).toBe(false);
  });

  it("a queue with an unknown status is rejected rather than coerced", () => {
    writeFileSync(
      promptQueuePath(tempDir),
      JSON.stringify({
        version: "1.0.0",
        prompts: [
          { id: "p-001", targetServices: [], prompt: "x", status: "in-flight-ish", createdAt: "2026-05-07T00:00:00.000Z" },
        ],
      })
    );
    expect(readPromptQueue(tempDir).success).toBe(false);
  });

  it("writePromptQueue still replaces the whole queue", () => {
    const result = writePromptQueue(tempDir, createEmptyQueue());
    expect(result.success).toBe(true);
    expect(existsSync(join(tempDir, "arkive", PROMPT_QUEUE_FILENAME))).toBe(true);
  });

  it("refuses to write an invalid queue", () => {
    const result = writePromptQueue(tempDir, { version: "1.0.0", prompts: "nope" } as never);
    expect(result.success).toBe(false);
  });
});
