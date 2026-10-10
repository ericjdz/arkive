import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createViewerServer } from "../../src/cli/commands/serve.js";

describe("Learning Progress API", () => {
  let dir: string;
  let app: ReturnType<typeof createViewerServer>["app"];
  let server: ReturnType<typeof createViewerServer>["server"];
  let baseUrl: string;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "arkive-learn-"));
    mkdirSync(join(dir, "arkive"), { recursive: true });
    writeFileSync(
      join(dir, "arkive", "architecture.json"),
      JSON.stringify({ version: "1.0.0", project: { name: "test" }, services: [], connections: [], decisions: [], dataFlows: [], history: [], stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] } })
    );
    const result = createViewerServer(dir);
    app = result.app;
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

  afterEach(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/learning/progress returns null when no progress file exists", async () => {
    const res = await fetch(`${baseUrl}/api/learning/progress`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBeNull();
  });

  it("PUT /api/learning/progress saves and GET retrieves it", async () => {
    const progress = {
      projectName: "test",
      startedAt: "2026-05-09T00:00:00.000Z",
      lastActivityAt: "2026-05-09T00:00:00.000Z",
      concepts: [],
      totalQuestions: 0,
      correctAnswers: 0,
    };

    const putRes = await fetch(`${baseUrl}/api/learning/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(progress),
    });
    expect(putRes.status).toBe(200);
    const putData = (await putRes.json()) as { ok: boolean };
    expect(putData.ok).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/learning/progress`);
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as { projectName: string; totalQuestions: number };
    expect(getData.projectName).toBe("test");
    expect(getData.totalQuestions).toBe(0);
  });

  it("PUT /api/learning/progress rejects invalid body", async () => {
    const res = await fetch(`${baseUrl}/api/learning/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
  });
});
