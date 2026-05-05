import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleUpdateArchitecture,
  handleRecordDecision,
  handleCheckDrift,
  ARCHITECTURE_TOOLS,
} from "../../src/server/tools.js";
import { writeArchitecture, readArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("MCP tool handlers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-tools-"));
    const arch = createEmptyArchitecture("tool-test", "Tool test");
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("declares 3 tools by name", () => {
    expect(ARCHITECTURE_TOOLS.map((t) => t.name).sort()).toEqual([
      "check_drift",
      "record_decision",
      "update_architecture",
    ]);
  });

  describe("update_architecture", () => {
    it("adds new services and history entry", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Added web client",
        services: [
          {
            id: "web",
            name: "Web",
            type: "frontend",
            technology: "Next.js",
            description: "UI",
            dependencies: [],
          },
        ],
      });
      expect(result.isError).toBeFalsy();

      const reread = readArchitecture(tempDir);
      expect(reread.success).toBe(true);
      if (reread.success) {
        expect(reread.data.services).toHaveLength(1);
        expect(reread.data.services[0].id).toBe("web");
        expect(reread.data.history.some((h) => h.summary === "Added web client")).toBe(true);
      }
    });

    it("merges stack arrays without duplicating entries", async () => {
      const arch = createEmptyArchitecture("stack-test", "Stack test");
      arch.stack.framework = ["Next.js"];
      writeArchitecture(tempDir, arch);

      await handleUpdateArchitecture(tempDir, {
        summary: "Update stack",
        stack: { framework: ["Next.js", "Express"] },
      });

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.stack.framework.sort()).toEqual(["Express", "Next.js"]);
    });

    it("returns isError when the merged result fails validation", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Bad connection",
        connections: [
          { from: "ghost", to: "phantom", protocol: "HTTP", description: "Bad" },
        ],
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text.toLowerCase()).toContain("ghost");
    });

    it("returns isError when architecture.json is missing", async () => {
      rmSync(tempDir, { recursive: true, force: true });
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "n/a",
        services: [],
      });
      expect(result.isError).toBe(true);
    });

    it("removes a service and cleans up related connections and dependencies", async () => {
      const arch = createEmptyArchitecture("remove-service-test", "Remove service test");
      arch.services = [
        {
          id: "web",
          name: "Web",
          type: "frontend",
          technology: "Next.js",
          description: "UI",
          dependencies: ["api"],
        },
        {
          id: "api",
          name: "API",
          type: "backend",
          technology: "Node.js",
          description: "Backend",
          dependencies: [],
        },
      ];
      arch.connections = [
        {
          from: "web",
          to: "api",
          protocol: "HTTP",
          description: "Web calls API",
        },
        {
          from: "api",
          to: "web",
          protocol: "Webhook",
          description: "API notifies Web",
        },
      ];
      writeArchitecture(tempDir, arch);

      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Remove API",
        removeServiceIds: ["api"],
      });
      expect(result.isError).toBeFalsy();

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.services.map((s) => s.id)).toEqual(["web"]);
      expect(reread.data.connections).toHaveLength(0);
      expect(reread.data.services[0].dependencies).toEqual([]);
    });

    it("removes a connection by key", async () => {
      const arch = createEmptyArchitecture("remove-connection-test", "Remove connection test");
      arch.services = [
        {
          id: "web",
          name: "Web",
          type: "frontend",
          technology: "Next.js",
          description: "UI",
          dependencies: [],
        },
        {
          id: "api",
          name: "API",
          type: "backend",
          technology: "Node.js",
          description: "Backend",
          dependencies: [],
        },
      ];
      arch.connections = [
        { from: "web", to: "api", protocol: "HTTP", description: "keep" },
        { from: "api", to: "web", protocol: "Webhook", description: "remove" },
      ];
      writeArchitecture(tempDir, arch);

      await handleUpdateArchitecture(tempDir, {
        summary: "Remove connection",
        removeConnectionKeys: ["api->web:Webhook"],
      });

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.connections.map((c) => `${c.from}->${c.to}:${c.protocol}`)).toEqual([
        "web->api:HTTP",
      ]);
    });

    it("removes a data flow by name", async () => {
      const arch = createEmptyArchitecture("remove-dataflow-test", "Remove data flow test");
      arch.dataFlows = [
        { name: "Keep", steps: [{ actor: "user", action: "Do keep" }] },
        { name: "Remove", steps: [{ actor: "user", action: "Do remove" }] },
      ];
      writeArchitecture(tempDir, arch);

      await handleUpdateArchitecture(tempDir, {
        summary: "Remove data flow",
        removeDataFlowNames: ["Remove"],
      });

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.dataFlows.map((f) => f.name)).toEqual(["Keep"]);
    });

    it("removes first and then adds new entries in the same call", async () => {
      const arch = createEmptyArchitecture("remove-add-test", "Remove add test");
      arch.services = [
        {
          id: "old-api",
          name: "Old API",
          type: "backend",
          technology: "Express",
          description: "Old backend",
          dependencies: [],
        },
      ];
      writeArchitecture(tempDir, arch);

      await handleUpdateArchitecture(tempDir, {
        summary: "Replace API",
        removeServiceIds: ["old-api"],
        services: [
          {
            id: "new-api",
            name: "New API",
            type: "backend",
            technology: "Fastify",
            description: "New backend",
            dependencies: [],
          },
        ],
      });

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.services.map((s) => s.id)).toEqual(["new-api"]);
    });
  });

  describe("record_decision", () => {
    it("appends a decision and a history entry", async () => {
      const result = await handleRecordDecision(tempDir, {
        topic: "Database",
        decision: "PostgreSQL",
        rationale: "Relational data fits the domain",
        alternatives: [{ name: "MongoDB", whyNot: "Document model adds complexity" }],
        relatedServices: [],
      });
      expect(result.isError).toBeFalsy();

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.decisions).toHaveLength(1);
      expect(reread.data.decisions[0].topic).toBe("Database");
      expect(reread.data.decisions[0].id).toMatch(/^dec-\d{3,}$/);
      expect(
        reread.data.history.some((h) => h.action === "architecture_decision")
      ).toBe(true);
    });

    it("auto-increments decision IDs", async () => {
      await handleRecordDecision(tempDir, {
        topic: "A", decision: "X", rationale: "r1",
        alternatives: [{ name: "Y", whyNot: "z" }], relatedServices: [],
      });
      await handleRecordDecision(tempDir, {
        topic: "B", decision: "X", rationale: "r2",
        alternatives: [{ name: "Y", whyNot: "z" }], relatedServices: [],
      });
      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      const ids = reread.data.decisions.map((d) => d.id);
      expect(ids).toEqual(["dec-001", "dec-002"]);
    });

    it("returns isError when relatedServices reference unknown ids", async () => {
      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [{ name: "A", whyNot: "B" }],
        relatedServices: ["nonexistent"],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("check_drift", () => {
    it("returns a structured drift report", async () => {
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { express: "^4.0.0" } }),
        "utf-8"
      );
      const result = await handleCheckDrift(tempDir);
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      const body = JSON.parse(text);
      expect(body).toHaveProperty("warnings");
      expect(body).toHaveProperty("summary");
      expect(typeof body.summary.total).toBe("number");
    });

    it("flags stale stack entries", async () => {
      const arch = createEmptyArchitecture("drift-test", "Drift");
      arch.stack.framework = ["Fastify"];
      writeArchitecture(tempDir, arch);
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { express: "^4.0.0" } }),
        "utf-8"
      );
      const result = await handleCheckDrift(tempDir);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.warnings.some((w: { subject: string }) => w.subject === "Fastify")).toBe(true);
    });
  });
});
