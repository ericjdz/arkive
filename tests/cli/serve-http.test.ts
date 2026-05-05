import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { createViewerServer } from "../../src/cli/commands/serve.js";
import type { Server } from "node:http";

describe("HTTP viewer server", () => {
  let tempDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-http-"));
    const arch = createEmptyArchitecture("http-test", "HTTP test");
    arch.services.push({
      id: "web",
      name: "Web",
      type: "frontend",
      technology: "Next.js",
      description: "UI",
      dependencies: [],
    });
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);

    const result = createViewerServer(tempDir);
    server = result.server;
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves /api/architecture with architecture data", async () => {
    const response = await fetch(`http://localhost:${port}/api/architecture`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.project.name).toBe("http-test");
    expect(data.services).toHaveLength(1);
  });

  it("returns 500 when architecture.json is missing", async () => {
    rmSync(join(tempDir, "architecture.json"));
    const response = await fetch(`http://localhost:${port}/api/architecture`);
    expect(response.status).toBe(500);
  });

  it("sets CORS headers", async () => {
    const response = await fetch(`http://localhost:${port}/api/architecture`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
