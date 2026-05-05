import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readOverview,
  readServices,
  readDecisions,
  readDataflows,
  readHistory,
  ARCHITECTURE_RESOURCES,
} from "../../src/server/resources.js";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("MCP resource handlers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-res-"));
    const arch = createEmptyArchitecture("res-test", "Resource test");
    arch.services.push({
      id: "web",
      name: "Web",
      type: "frontend",
      technology: "Next.js",
      description: "UI",
      dependencies: [],
    });
    arch.decisions.push({
      id: "dec-001",
      topic: "DB",
      decision: "Postgres",
      rationale: "Relational",
      alternatives: [{ name: "Mongo", whyNot: "Doc model" }],
      timestamp: new Date().toISOString(),
      relatedServices: [],
    });
    arch.dataFlows.push({
      name: "Login",
      steps: [{ actor: "web", action: "Submit form" }],
    });
    const result = writeArchitecture(tempDir, arch);
    if (!result.success) throw new Error(result.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("declares all 5 architecture:// resources", () => {
    const uris = ARCHITECTURE_RESOURCES.map((r) => r.uri);
    expect(uris).toEqual([
      "architecture://overview",
      "architecture://services",
      "architecture://decisions",
      "architecture://dataflows",
      "architecture://history",
    ]);
  });

  it("readOverview returns project + stack + counts as JSON", async () => {
    const result = await readOverview(tempDir, new URL("architecture://overview"));
    expect(result.contents).toHaveLength(1);
    const entry = result.contents[0];
    expect(entry.uri).toBe("architecture://overview");
    expect(entry.mimeType).toBe("application/json");
    const body = JSON.parse((entry as { text: string }).text);
    expect(body.project.name).toBe("res-test");
    expect(body.counts).toEqual({
      services: 1,
      connections: 0,
      decisions: 1,
      dataFlows: 1,
      history: 1,
    });
  });

  it("readServices returns services + connections", async () => {
    const result = await readServices(tempDir, new URL("architecture://services"));
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.services).toHaveLength(1);
    expect(body.services[0].id).toBe("web");
    expect(body.connections).toEqual([]);
  });

  it("readDecisions returns the decisions array", async () => {
    const result = await readDecisions(tempDir, new URL("architecture://decisions"));
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].id).toBe("dec-001");
  });

  it("readDataflows returns the dataFlows array", async () => {
    const result = await readDataflows(tempDir, new URL("architecture://dataflows"));
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.dataFlows).toHaveLength(1);
    expect(body.dataFlows[0].name).toBe("Login");
  });

  it("readHistory returns the history array", async () => {
    const result = await readHistory(tempDir, new URL("architecture://history"));
    const body = JSON.parse((result.contents[0] as { text: string }).text);
    expect(body.history).toHaveLength(1);
    expect(body.history[0].action).toBe("initial_scaffold");
  });

  it("propagates read errors when architecture.json is missing", async () => {
    rmSync(tempDir, { recursive: true, force: true });
    await expect(
      readOverview(tempDir, new URL("architecture://overview"))
    ).rejects.toThrow(/not found/);
  });
});
