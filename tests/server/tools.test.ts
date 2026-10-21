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
    tempDir = mkdtempSync(join(tmpdir(), "arkive-tools-"));
    const arch = createEmptyArchitecture("tool-test", "Tool test");
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("declares 8 tools by name", () => {
    // Issue 0009 consolidates: the list_prompts / claim_next_prompt / ack_prompt
    // trio is one `prompts` tool, and the walkthrough traversals are one
    // `walkthrough` tool. 9 - 3 + 1 + 1 = 8, never a tenth.
    expect(ARCHITECTURE_TOOLS).toHaveLength(8);
    expect(ARCHITECTURE_TOOLS.map((t) => t.name).sort()).toEqual([
      "check_drift",
      "open_viewer",
      "prompts",
      "record_decision",
      "scaffold_project",
      "update_architecture",
      "walkthrough",
      "why_does_this_exist",
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

    it("updates an existing authored node instead of reverting it from the stale v1 projection", async () => {
      // Regression: `readArchitecture` returns `services` projected from the
      // pre-call graph. Node edits do not update that copy, and
      // `writeArchitecture` folds a stored v1 view back onto the graph. The
      // result was an update that reported success, wrote a history entry, and
      // silently kept the old authored values.
      // Seed a v1-authored node, which is written with a `services[]`
      // projection beside the graph — the shape that exposed the bug.
      const seeded = await handleUpdateArchitecture(tempDir, {
        summary: "Seed the viewer",
        services: [
          {
            id: "viewer",
            name: "Viewer",
            type: "frontend",
            technology: "React + Vite",
            description: "Interactive React UI",
            dependencies: [],
          },
        ],
      });
      expect(seeded.isError).toBeFalsy();

      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Correct the viewer's authored half",
        nodes: [
          {
            id: "viewer",
            kind: "service",
            name: "Viewer",
            summary: "Single-file HTML viewer",
            tech: "TypeScript",
            authoredBy: "agent",
          },
        ],
      });
      expect(result.isError).toBeFalsy();

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      const node = reread.data.nodes.find((candidate) => candidate.id === "viewer");
      expect(node?.summary).toBe("Single-file HTML viewer");
      expect(node?.tech).toBe("TypeScript");
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
      // The edge is the stored relationship; the connection is its projection.
      // A removal that updates only one of them is a removal the next write
      // undoes by re-projecting the survivor.
      expect(reread.data.edges.map((e) => e.id)).toEqual(["calls:web->api"]);
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
        subjects: [],
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

    it("does not fold the stale v1 projection back onto the graph", async () => {
      // Regression: recording a decision used to write the `services[]` copy
      // that `readArchitecture` attached from the pre-call graph. The writer
      // folded it back as a v1 edit, stamping a meaningless `legacyType` onto
      // nodes the call never touched.
      const seeded = await handleUpdateArchitecture(tempDir, {
        summary: "seed a node",
        nodes: [{ id: "svc", kind: "service", name: "Svc", authoredBy: "agent" }],
      });
      expect(seeded.isError).toBeFalsy();

      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [{ name: "A", whyNot: "B" }],
        subjects: [{ kind: "node", ref: "svc" }],
      });
      expect(result.isError).toBeFalsy();

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      const node = reread.data.nodes.find((candidate) => candidate.id === "svc");
      expect(node?.legacyType).toBeUndefined();
    });

    it("auto-increments decision IDs", async () => {
      await handleRecordDecision(tempDir, {
        topic: "A", decision: "X", rationale: "r1",
        alternatives: [{ name: "Y", whyNot: "z" }], subjects: [],
      });
      await handleRecordDecision(tempDir, {
        topic: "B", decision: "X", rationale: "r2",
        alternatives: [{ name: "Y", whyNot: "z" }], subjects: [],
      });
      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      const ids = reread.data.decisions.map((d) => d.id);
      expect(ids).toEqual(["dec-001", "dec-002"]);
    });

    it("returns isError when subjects reference an unknown node", async () => {
      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [{ name: "A", whyNot: "B" }],
        subjects: [{ kind: "node", ref: "nonexistent" }],
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("nonexistent");
    });

    it("refuses v1 `relatedServices` and names the field that replaced it", async () => {
      // The field is *declared* in the input schema purely so this refusal is
      // loud. A silent strip would drop the subjects between the call and the
      // file, which is the exact failure this product exists to prevent.
      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [{ name: "A", whyNot: "B" }],
        relatedServices: ["web"],
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("relatedServices");
      expect(text).toContain("subjects");
      // Nothing was written.
      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.decisions).toHaveLength(0);
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
