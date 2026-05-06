import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOpenViewer } from "../../src/server/tools.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("open_viewer MCP tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-viewer-test-"));
    const arch = createEmptyArchitecture("test", "test");
    writeFileSync(join(tempDir, "architecture.json"), JSON.stringify(arch, null, 2), "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error when architecture.json is missing", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "arkive-viewer-empty-"));
    const result = await handleOpenViewer(emptyDir, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("architecture.json");

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns a URL with specified port", async () => {
    // Use a random high port to avoid conflicts
    const port = 49000 + Math.floor(Math.random() * 1000);
    const result = await handleOpenViewer(tempDir, { port });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.url).toBe(`http://localhost:${port}`);
    expect(body.port).toBe(port);
    expect(body.alreadyRunning).toBe(false);

    // Cleanup: we need to close the server. Since activeViewerServer is module-level,
    // we import and use resetActiveViewer if available, or just let the process clean up
  });
});
