// tests/server/prompt-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { addPrompt } from "../../src/io/prompt-queue.js";
import {
  handleListPrompts,
  handleClaimNextPrompt,
  handleAckPrompt,
} from "../../src/server/tools.js";

describe("MCP prompt tool handlers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-pt-"));
    const arch = createEmptyArchitecture("pt-test", "Prompt tools test");
    writeArchitecture(tempDir, arch);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("list_prompts", () => {
    it("returns empty list when no prompts exist", async () => {
      const result = await handleListPrompts(tempDir, {});
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.prompts).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.pending).toBe(0);
    });

    it("returns all prompts with counts", async () => {
      addPrompt(tempDir, ["web"], "First");
      addPrompt(tempDir, ["api"], "Second");

      const result = await handleListPrompts(tempDir, {});
      const body = JSON.parse(result.content[0].text);
      expect(body.total).toBe(2);
      expect(body.pending).toBe(2);
      expect(body.prompts).toHaveLength(2);
    });

    it("filters by status when provided", async () => {
      addPrompt(tempDir, ["web"], "First");
      addPrompt(tempDir, ["api"], "Second");

      const { claimNextPrompt } = await import("../../src/io/prompt-queue.js");
      claimNextPrompt(tempDir);

      const result = await handleListPrompts(tempDir, { status: "pending" });
      const body = JSON.parse(result.content[0].text);
      expect(body.prompts).toHaveLength(1);
      expect(body.prompts[0].prompt).toBe("Second");
    });
  });

  describe("claim_next_prompt", () => {
    it("claims the oldest pending prompt", async () => {
      addPrompt(tempDir, ["web"], "First");
      addPrompt(tempDir, ["api"], "Second");

      const result = await handleClaimNextPrompt(tempDir, { agent: "claude-opus" });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      expect(body.claimed).toBe(true);
      expect(body.prompt.prompt).toBe("First");
      expect(body.prompt.status).toBe("claimed");
      expect(body.prompt.agent).toBe("claude-opus");
    });

    it("returns claimed=false when queue is empty", async () => {
      const result = await handleClaimNextPrompt(tempDir, {});
      const body = JSON.parse(result.content[0].text);
      expect(body.claimed).toBe(false);
      expect(body.prompt).toBeNull();
    });
  });

  describe("ack_prompt", () => {
    it("acknowledges a claimed prompt", async () => {
      addPrompt(tempDir, ["web"], "Do something");
      const { claimNextPrompt, readPromptQueue } = await import("../../src/io/prompt-queue.js");
      claimNextPrompt(tempDir);

      const queue = readPromptQueue(tempDir);
      if (!queue.success) throw new Error(queue.error);
      const id = queue.data.prompts[0].id;

      const result = await handleAckPrompt(tempDir, { promptId: id, outcome: "done" });
      expect(result.isError).toBeFalsy();
    });

    it("returns error for unknown prompt id", async () => {
      const result = await handleAckPrompt(tempDir, { promptId: "p-999", outcome: "done" });
      expect(result.isError).toBe(true);
    });

    it("supports failed outcome", async () => {
      addPrompt(tempDir, ["web"], "Do something");
      const { claimNextPrompt, readPromptQueue } = await import("../../src/io/prompt-queue.js");
      claimNextPrompt(tempDir);

      const queue = readPromptQueue(tempDir);
      if (!queue.success) throw new Error(queue.error);
      const id = queue.data.prompts[0].id;

      const result = await handleAckPrompt(tempDir, { promptId: id, outcome: "failed" });
      expect(result.isError).toBeFalsy();

      const after = readPromptQueue(tempDir);
      if (after.success) {
        expect(after.data.prompts[0].status).toBe("failed");
      }
    });
  });
});
