import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptQueueSchema, PromptStatus } from "../../src/schema/prompt-queue.js";
import {
  readPromptQueue,
  writePromptQueue,
  addPrompt,
  claimNextPrompt,
  ackPrompt,
  failPrompt,
  listPendingPrompts,
  createEmptyQueue,
  PROMPT_QUEUE_FILENAME,
} from "../../src/io/prompt-queue.js";

describe("PromptQueueSchema", () => {
  it("exports all prompt statuses", () => {
    expect(PromptStatus.enum.pending).toBe("pending");
    expect(PromptStatus.enum.claimed).toBe("claimed");
    expect(PromptStatus.enum.done).toBe("done");
    expect(PromptStatus.enum.failed).toBe("failed");
  });

  it("validates a valid prompt queue", () => {
    const data = {
      version: "1.0.0",
      prompts: [
        {
          id: "p-001",
          targetServices: ["web", "api"],
          prompt: "Refactor the API layer to use GraphQL",
          status: "pending",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      ],
    };
    const result = PromptQueueSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects prompt with empty prompt text", () => {
    const data = {
      version: "1.0.0",
      prompts: [
        {
          id: "p-001",
          targetServices: ["web"],
          prompt: "",
          status: "pending",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      ],
    };
    const result = PromptQueueSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects prompt with invalid status", () => {
    const data = {
      version: "1.0.0",
      prompts: [
        {
          id: "p-001",
          targetServices: ["web"],
          prompt: "Do something",
          status: "invalid-status",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      ],
    };
    const result = PromptQueueSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("allows empty prompts array", () => {
    const data = { version: "1.0.0", prompts: [] };
    const result = PromptQueueSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates all status values", () => {
    for (const status of ["pending", "claimed", "done", "failed"] as const) {
      const data = {
        version: "1.0.0",
        prompts: [
          {
            id: "p-001",
            targetServices: [],
            prompt: "test",
            status,
            createdAt: "2026-05-07T00:00:00.000Z",
          },
        ],
      };
      expect(PromptQueueSchema.safeParse(data).success).toBe(true);
    }
  });
});

describe("Prompt queue I/O", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-pq-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("readPromptQueue returns empty queue when file does not exist", () => {
    const result = readPromptQueue(tempDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompts).toEqual([]);
    }
  });

  it("writePromptQueue creates arkive directory and writes file", () => {
    const queue = createEmptyQueue();
    const result = writePromptQueue(tempDir, queue);
    expect(result.success).toBe(true);
    expect(existsSync(join(tempDir, "arkive", PROMPT_QUEUE_FILENAME))).toBe(true);
  });

  it("addPrompt appends a prompt and returns its id", () => {
    const result = addPrompt(tempDir, ["web", "api"], "Add GraphQL layer");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toMatch(/^p-\d{3}$/);
      expect(result.data.status).toBe("pending");
      expect(result.data.targetServices).toEqual(["web", "api"]);
    }
  });

  it("claimNextPrompt returns oldest pending and marks it claimed", () => {
    addPrompt(tempDir, ["web"], "First prompt");
    addPrompt(tempDir, ["api"], "Second prompt");

    const claim = claimNextPrompt(tempDir, "claude-opus");
    expect(claim.success).toBe(true);
    if (claim.success) {
      expect(claim.data?.prompt).toBe("First prompt");
      expect(claim.data?.status).toBe("claimed");
      expect(claim.data?.agent).toBe("claude-opus");
    }

    const queue = readPromptQueue(tempDir);
    if (queue.success) {
      expect(queue.data.prompts[0].status).toBe("claimed");
      expect(queue.data.prompts[1].status).toBe("pending");
    }
  });

  it("claimNextPrompt returns null when no pending prompts", () => {
    const claim = claimNextPrompt(tempDir);
    expect(claim.success).toBe(true);
    if (claim.success) {
      expect(claim.data).toBeNull();
    }
  });

  it("ackPrompt marks a claimed prompt as done", () => {
    addPrompt(tempDir, ["web"], "Do something");
    claimNextPrompt(tempDir);

    const queue = readPromptQueue(tempDir);
    if (!queue.success) throw new Error(queue.error);
    const id = queue.data.prompts[0].id;

    const ack = ackPrompt(tempDir, id);
    expect(ack.success).toBe(true);

    const after = readPromptQueue(tempDir);
    if (after.success) {
      expect(after.data.prompts[0].status).toBe("done");
      expect(after.data.prompts[0].completedAt).toBeDefined();
    }
  });

  it("failPrompt marks a claimed prompt as failed", () => {
    addPrompt(tempDir, ["web"], "Do something");
    claimNextPrompt(tempDir);

    const queue = readPromptQueue(tempDir);
    if (!queue.success) throw new Error(queue.error);
    const id = queue.data.prompts[0].id;

    const fail = failPrompt(tempDir, id);
    expect(fail.success).toBe(true);

    const after = readPromptQueue(tempDir);
    if (after.success) {
      expect(after.data.prompts[0].status).toBe("failed");
    }
  });

  it("listPendingPrompts returns only pending items", () => {
    addPrompt(tempDir, ["web"], "Pending one");
    addPrompt(tempDir, ["api"], "Pending two");
    claimNextPrompt(tempDir);

    const pending = listPendingPrompts(tempDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("Pending two");
  });
});
