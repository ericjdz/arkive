// tests/server/tool-consolidation.test.ts
//
// Issue 0009: the prompt-queue trio is one `prompts` tool and the walkthrough
// traversals are one `walkthrough` tool. Net count is 8, and the removal of
// the old names is intentional and backwards-incompatible.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { addPrompt, readPromptQueue } from "../../src/io/prompt-queue.js";
import { createServer } from "../../src/server/index.js";
import {
  ARCHITECTURE_TOOLS,
  PromptsInputSchema,
  WalkthroughInputSchema,
  __setWalkthroughEngineForTests,
  handlePrompts,
  handleUpdateArchitecture,
  handleWalkthrough,
} from "../../src/server/tools.js";

const EXPECTED_TOOLS = [
  "check_drift",
  "open_viewer",
  "prompts",
  "record_decision",
  "scaffold_project",
  "update_architecture",
  "walkthrough",
  "why_does_this_exist",
];

const REMOVED_TOOLS = ["list_prompts", "claim_next_prompt", "ack_prompt"];

function registeredToolNames(dir: string): string[] {
  const server = createServer({ dir });
  const internals = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internals._registeredTools).sort();
}

function bodyOf(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("0009 tool consolidation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-cons-"));
    const arch = createEmptyArchitecture("cons-test", "Consolidation test");
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    __setWalkthroughEngineForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ARCHITECTURE_TOOLS has length 8", () => {
    expect(ARCHITECTURE_TOOLS).toHaveLength(8);
    expect(ARCHITECTURE_TOOLS.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("registerTools registers exactly those 8 names", () => {
    expect(registeredToolNames(tempDir)).toEqual(EXPECTED_TOOLS);
  });

  it("does not register the removed prompt-queue names", () => {
    const names = registeredToolNames(tempDir);
    for (const removed of REMOVED_TOOLS) {
      expect(names).not.toContain(removed);
    }
    expect(ARCHITECTURE_TOOLS.map((t) => t.name)).not.toContain("dataShapes");
  });

  describe("prompts round-trip", () => {
    it("list returns an empty queue", async () => {
      const result = await handlePrompts(tempDir, { action: "list" });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as { prompts: unknown[]; total: number; pending: number };
      expect(body.prompts).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.pending).toBe(0);
    });

    it("claim on an empty queue returns claimed:false", async () => {
      const result = await handlePrompts(tempDir, { action: "claim" });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as { claimed: boolean; prompt: null };
      expect(body.claimed).toBe(false);
      expect(body.prompt).toBeNull();
    });

    it("list / claim / ack round-trips, preserving all trio behaviors", async () => {
      addPrompt(tempDir, ["web"], "First");
      addPrompt(tempDir, ["api"], "Second");

      const listed = (await handlePrompts(tempDir, { action: "list" })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(listed.isError).toBeFalsy();
      expect((bodyOf(listed) as { total: number }).total).toBe(2);

      // Status filter preserved.
      const filtered = (await handlePrompts(tempDir, { action: "list", status: "pending" })) as { content: Array<{ text: string }> };
      expect((bodyOf(filtered) as { prompts: Array<{ prompt: string }> }).prompts).toHaveLength(2);

      // Claim keeps the optional agent and is atomic via the queue CAS.
      const claimed = (await handlePrompts(tempDir, { action: "claim", agent: "test-agent" })) as { content: Array<{ text: string }> };
      const claimBody = bodyOf(claimed) as {
        claimed: boolean;
        prompt: { id: string; prompt: string; status: string; agent: string };
      };
      expect(claimBody.claimed).toBe(true);
      expect(claimBody.prompt.prompt).toBe("First");
      expect(claimBody.prompt.status).toBe("claimed");
      expect(claimBody.prompt.agent).toBe("test-agent");

      // done routes to ackPrompt.
      const acked = await handlePrompts(tempDir, {
        action: "ack",
        promptId: claimBody.prompt.id,
        outcome: "done",
      });
      expect(acked.isError).toBeFalsy();
      const after = readPromptQueue(tempDir);
      if (!after.success) throw new Error(after.error);
      expect(after.data.prompts[0].status).toBe("done");

      // failed routes to failPrompt.
      const claimed2 = (await handlePrompts(tempDir, { action: "claim" })) as { content: Array<{ text: string }> };
      const claim2 = bodyOf(claimed2) as { prompt: { id: string } };
      const failed = await handlePrompts(tempDir, {
        action: "ack",
        promptId: claim2.prompt.id,
        outcome: "failed",
      });
      expect(failed.isError).toBeFalsy();
      const afterFailed = readPromptQueue(tempDir);
      if (!afterFailed.success) throw new Error(afterFailed.error);
      expect(afterFailed.data.prompts[1].status).toBe("failed");
    });

    it("rejects an unknown action and an ack without a promptId", async () => {
      expect((await handlePrompts(tempDir, { action: "delete" })).isError).toBe(true);
      expect((await handlePrompts(tempDir, { action: "ack", outcome: "done" })).isError).toBe(true);
      expect((await handlePrompts(tempDir, { action: "ack", promptId: "p-999", outcome: "done" })).isError).toBe(true);
    });

    it("PromptsInputSchema discriminates on action", () => {
      expect(PromptsInputSchema.safeParse({ action: "list", status: "pending" }).success).toBe(true);
      expect(PromptsInputSchema.safeParse({ action: "claim", agent: "a" }).success).toBe(true);
      expect(
        PromptsInputSchema.safeParse({ action: "ack", promptId: "p-001", outcome: "failed" }).success
      ).toBe(true);
      expect(PromptsInputSchema.safeParse({ action: "list", status: "bogus" }).success).toBe(false);
    });
  });

  describe("walkthrough", () => {
    beforeEach(async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "walkthrough fixture",
        nodes: [
          { id: "web", kind: "service", name: "Web" },
          { id: "api", kind: "service", name: "API" },
          { id: "db", kind: "datastore", name: "DB" },
          { id: "island", kind: "service", name: "Island" },
        ],
        edges: [
          { id: "e-web-api", from: "web", to: "api", kind: "calls" },
          { id: "e-api-db", from: "api", to: "db", kind: "reads" },
        ],
      });
      if (result.isError) throw new Error(result.content[0].text);
    });

    it("topology takes no ref and lists every node and edge", async () => {
      const result = await handleWalkthrough(tempDir, { action: "topology" });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as {
        nodes: Array<{ id: string }>;
        edges: Array<{ id: string }>;
      };
      expect(body.nodes.map((n) => n.id).sort()).toEqual(["api", "db", "island", "web"]);
      expect(body.edges.map((e) => e.id).sort()).toEqual(["e-api-db", "e-web-api"]);
    });

    it("open resolves a node with edges by kind and defaults depth to 1", async () => {
      const result = await handleWalkthrough(tempDir, { action: "open", ref: "api" });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as {
        ref: string;
        inbound: Array<{ id: string }>;
        outbound: Array<{ id: string }>;
        dataShapes: unknown[];
        decisions: unknown[];
      };
      expect(body.ref).toBe("api");
      expect(body.inbound.map((e) => e.id)).toEqual(["e-web-api"]);
      expect(body.outbound.map((e) => e.id)).toEqual(["e-api-db"]);
      expect(body.dataShapes).toEqual([]);
      expect(body.decisions).toEqual([]);
    });

    it("open on a bad ref is an error, never an invented node", async () => {
      const result = await handleWalkthrough(tempDir, { action: "open", ref: "ghost" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ghost");
    });

    it("open rejects depth above 3", async () => {
      expect(WalkthroughInputSchema.safeParse({ action: "open", ref: "api", depth: 4 }).success).toBe(
        false
      );
      const result = await handleWalkthrough(tempDir, { action: "open", ref: "api", depth: 4 });
      expect(result.isError).toBe(true);
    });

    it("trace follows real edges with the kind at each hop", async () => {
      const result = await handleWalkthrough(tempDir, {
        action: "trace",
        entryRef: "web",
        exitRef: "db",
      });
      expect(result.isError).toBeFalsy();
      const body = bodyOf(result) as {
        hops: Array<{ from: string; to: string; via: string; kind: string }>;
      };
      expect(body.hops).toEqual([
        { from: "web", to: "api", via: "e-web-api", kind: "calls" },
        { from: "api", to: "db", via: "e-api-db", kind: "reads" },
      ]);
    });

    it("trace on a bad ref is an error, never an invented path", async () => {
      const badEntry = await handleWalkthrough(tempDir, {
        action: "trace",
        entryRef: "ghost",
        exitRef: "db",
      });
      expect(badEntry.isError).toBe(true);
      const badExit = await handleWalkthrough(tempDir, {
        action: "trace",
        entryRef: "web",
        exitRef: "ghost",
      });
      expect(badExit.isError).toBe(true);
    });

    it("trace with no live path is an error, never a fabricated hop", async () => {
      const result = await handleWalkthrough(tempDir, {
        action: "trace",
        entryRef: "db",
        exitRef: "island",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/no path/i);
    });

    it("trace without entryRef/exitRef fails validation", async () => {
      expect(WalkthroughInputSchema.safeParse({ action: "trace", entryRef: "web" }).success).toBe(
        false
      );
      expect((await handleWalkthrough(tempDir, { action: "trace", entryRef: "web" })).isError).toBe(
        true
      );
    });

    it("delegates to the injected engine when one is set", async () => {
      __setWalkthroughEngineForTests({
        topology: () => ({ success: true as const, data: { stubbed: "topology" } }),
        open: (_doc, ref, depth) => ({ success: true as const, data: { stubbed: `open:${ref}:${depth}` } }),
        trace: (_doc, entryRef, exitRef) => ({
          success: true as const,
          data: { stubbed: `trace:${entryRef}:${exitRef}` },
        }),
      });
      const result = await handleWalkthrough(tempDir, { action: "open", ref: "api", depth: 2 });
      expect(result.isError).toBeFalsy();
      expect(bodyOf(result)).toEqual({ stubbed: "open:api:2" });
    });

    it("surfaces engine errors as isError", async () => {
      __setWalkthroughEngineForTests({
        topology: () => ({ success: false as const, error: "stub engine says no" }),
        open: () => ({ success: false as const, error: "stub engine says no" }),
        trace: () => ({ success: false as const, error: "stub engine says no" }),
      });
      const result = await handleWalkthrough(tempDir, { action: "topology" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("stub engine says no");
    });
  });
});
