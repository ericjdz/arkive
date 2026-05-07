import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { createViewerServer } from "../../src/cli/commands/serve.js";
import type { Server } from "node:http";

describe("HTTP prompt queue endpoints", () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-pq-http-"));
    const arch = createEmptyArchitecture("pq-test", "Prompt queue test");
    arch.services.push(
      { id: "web", name: "Web", type: "frontend", technology: "Next.js", description: "UI", dependencies: [] },
      { id: "api", name: "API", type: "backend", technology: "Express", description: "REST", dependencies: [] },
    );
    writeArchitecture(tempDir, arch);

    const result = createViewerServer(tempDir);
    server = result.server;
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
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

  it("GET /api/prompts returns empty queue initially", async () => {
    const res = await fetch(`${baseUrl}/api/prompts`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.prompts).toEqual([]);
  });

  it("POST /api/prompts adds a prompt", async () => {
    const res = await fetch(`${baseUrl}/api/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetServices: ["web", "api"],
        prompt: "Add authentication",
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.id).toMatch(/^p-\d{3}$/);
    expect(data.status).toBe("pending");

    const list = await fetch(`${baseUrl}/api/prompts`);
    const listData = await list.json();
    expect(listData.prompts).toHaveLength(1);
  });

  it("POST /api/prompts rejects empty prompt text", async () => {
    const res = await fetch(`${baseUrl}/api/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetServices: ["web"], prompt: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/prompts/:id removes a prompt", async () => {
    const addRes = await fetch(`${baseUrl}/api/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetServices: ["web"], prompt: "Test" }),
    });
    const { id } = await addRes.json();

    const delRes = await fetch(`${baseUrl}/api/prompts/${id}`, { method: "DELETE" });
    expect(delRes.ok).toBe(true);

    const list = await fetch(`${baseUrl}/api/prompts`);
    const listData = await list.json();
    expect(listData.prompts).toHaveLength(0);
  });

  it("DELETE /api/prompts/:id returns 404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/prompts/p-999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
