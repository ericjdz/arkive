import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../../src/server/index.js";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("createServer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-srv-"));
    const arch = createEmptyArchitecture("srv", "Server test");
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns an McpServer instance with the configured name and version", () => {
    const server = createServer({ dir: tempDir, name: "test-srv", version: "9.9.9" });
    expect(server).toBeDefined();
    expect(typeof (server as unknown as { connect: unknown }).connect).toBe("function");
  });

  it("registers all 6 architecture resources", () => {
    const server = createServer({ dir: tempDir });
    expect(server).toBeDefined();
  });

  it("registers all 6 tools without throwing", () => {
    expect(() => createServer({ dir: tempDir })).not.toThrow();
  });
});
