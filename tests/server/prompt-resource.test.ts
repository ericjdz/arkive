// tests/server/prompt-resource.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { addPrompt } from "../../src/io/prompt-queue.js";
import { readPrompts } from "../../src/server/resources.js";

describe("architecture://prompts resource", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-pr-"));
    const arch = createEmptyArchitecture("pr-test", "Prompt resource test");
    writeArchitecture(tempDir, arch);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty queue when no prompts exist", async () => {
    const uri = new URL("architecture://prompts");
    const result = await readPrompts(tempDir, uri);
    expect(result.contents).toHaveLength(1);
    const body = JSON.parse(result.contents[0].text as string);
    expect(body.prompts).toEqual([]);
    expect(body.pending).toBe(0);
  });

  it("returns prompts with summary counts", async () => {
    addPrompt(tempDir, ["web"], "First prompt");
    addPrompt(tempDir, ["api"], "Second prompt");

    const uri = new URL("architecture://prompts");
    const result = await readPrompts(tempDir, uri);
    const body = JSON.parse(result.contents[0].text as string);
    expect(body.prompts).toHaveLength(2);
    expect(body.pending).toBe(2);
    expect(body.total).toBe(2);
  });
});
