import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleUpdateArchitecture,
  handleRecordDecision,
  handleWhyDoesThisExist,
  UpdateArchitectureInputSchema,
} from "../../src/server/tools.js";
import {
  writeArchitecture,
  readArchitecture,
  architecturePath,
} from "../../src/io/architecture-file.js";
import {
  projectDecidedBy,
  whyDoesThisExist,
} from "../../src/io/decisions.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { derivedFrom } from "../../src/schema/provenance.js";
import type { ArchitectureDocumentV2 } from "../../src/schema/graph.js";

/**
 * `docs/issues/0008-decision-attachment.md`.
 *
 * Every test here is one of the issue's acceptance criteria or one of the four
 * demonstrations it asks for, and each is written so that the naive
 * implementation of the same feature fails it. The interesting assertions are
 * the negative ones: `decided_by` must not be stored, a tombstoned subject must
 * not be an error, and a decision attached to a derived node must arrive with
 * the evidence attached.
 */

function body(result: { content: Array<{ text: string }>; isError?: boolean }): any {
  return JSON.parse(result.content[0].text);
}

function errorText(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

/** A decision with a real rejected alternative, the way one should be written. */
const POSTGRES = {
  topic: "Primary datastore",
  decision: "PostgreSQL",
  rationale: "The domain is relational and the queries are already joins",
  alternatives: [
    { name: "MongoDB", whyNot: "every aggregate we rely on stops being a first-class query" },
  ],
};

describe("decision attachment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-decisions-"));
    const written = writeArchitecture(tempDir, createEmptyArchitecture("dec", "Decisions"));
    if (!written.success) throw new Error(written.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Attach at creation
  // ---------------------------------------------------------------------------

  describe("attach at creation", () => {
    it("produces a decided_by edge with no manual linking step", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Add the billing module",
        nodes: [
          { id: "module:billing", kind: "module", name: "billing", summary: "", path: "src/billing" },
        ],
        decisions: [POSTGRES],
      });
      expect(result.isError).toBeFalsy();

      const payload = body(result);

      // The decision attached itself to the node the same call created.
      expect(payload.decisions[0].subjects).toEqual([
        { kind: "node", ref: "module:billing" },
      ]);

      // And the projection carries the edge.
      expect(payload.decidedBy).toHaveLength(1);
      expect(payload.decidedBy[0]).toMatchObject({
        id: "decided_by:module:billing->dec-001",
        from: "module:billing",
        to: "dec-001",
        kind: "decided_by",
      });

      // The caller's next move is a traversal, not an edit.
      const why = body(await handleWhyDoesThisExist(tempDir, { nodeId: "module:billing" }));
      expect(why.claims).toHaveLength(1);
      expect(why.claims[0].decision.rationale).toBe(POSTGRES.rationale);
      expect(why.claims[0].rejectedAlternatives).toEqual(POSTGRES.alternatives);
    });

    it("never stores the decided_by edge on disk", async () => {
      // ADR-0001:78-88 — it is a projection. Storing it would put decisions in
      // the blast radius of node deletion, which is the property the ADR
      // explicitly traded away.
      await handleUpdateArchitecture(tempDir, {
        summary: "Add the billing module",
        nodes: [{ id: "module:billing", kind: "module", name: "billing", summary: "" }],
        decisions: [POSTGRES],
      });

      const onDisk = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
      expect(onDisk.edges.some((edge: { kind: string }) => edge.kind === "decided_by")).toBe(false);

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.edges.some((edge) => edge.kind === "decided_by")).toBe(false);
      // The subject survived, which is what makes the projection reconstructible.
      expect(reread.data.decisions[0].subjects).toEqual([
        { kind: "node", ref: "module:billing" },
      ]);
    });

    it("attaches a decision to an edge created in the same call", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Wire the modules together",
        nodes: [
          { id: "module:a", kind: "module", name: "a", summary: "" },
          { id: "module:b", kind: "module", name: "b", summary: "" },
        ],
        edges: [{ id: "calls:a->b", from: "module:a", to: "module:b", kind: "calls" }],
        decisions: [
          {
            ...POSTGRES,
            topic: "How the modules talk",
            // An edge id is a name the author chose, so an edge subject is
            // explicit; auto-attachment covers what the call created.
          },
        ],
      });
      expect(result.isError).toBeFalsy();
      const payload = body(result);
      expect(payload.decisions[0].subjects).toEqual(
        expect.arrayContaining([
          { kind: "node", ref: "module:a" },
          { kind: "node", ref: "module:b" },
          { kind: "edge", ref: "calls:a->b" },
        ])
      );
      expect(payload.decidedBy).toHaveLength(3);
    });

    it("refuses to author a decided_by edge — it is not a storable kind", () => {
      // ADR-0001 makes this a compile-time question at the type level
      // (`StorableEdgeKind`); this asserts the runtime half agrees.
      const parsed = UpdateArchitectureInputSchema.safeParse({
        summary: "hand-maintain the link",
        edges: [{ id: "x", from: "a", to: "dec-001", kind: "decided_by" }],
      });
      expect(parsed.success).toBe(false);
    });

    it("attaches through the deprecated services surface too", async () => {
      // The deprecated `services` array is folded onto the graph *inside*
      // `writeArchitecture`, so its node ids are not in the graph when the
      // subjects are validated. Refusing them would make the old surface unable
      // to attach a decision at all.
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Add a service, with a decision",
        services: [
          {
            id: "api",
            name: "API",
            type: "backend",
            technology: "Node.js",
            description: "HTTP surface",
            dependencies: [],
          },
        ],
        decisions: [POSTGRES],
      });
      expect(result.isError).toBeFalsy();
      const payload = body(result);
      expect(payload.decisions[0].subjects).toEqual([{ kind: "node", ref: "api" }]);
      expect(payload.decidedBy[0]).toMatchObject({ from: "api", kind: "decided_by" });
    });

    it("lets an edge point at a service the same call adds by its v1 name", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Add a service and wire it, together",
        services: [
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
            description: "HTTP surface",
            dependencies: [],
          },
        ],
        edges: [{ id: "calls:web->api", from: "web", to: "api", kind: "calls" }],
      });
      expect(result.isError).toBeFalsy();
      expect(body(result).edges.created).toEqual(["calls:web->api"]);
    });

    it("refuses an edge pointing at a node that is not there and not arriving", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Wire to nothing",
        edges: [{ id: "calls:a->ghost", from: "a", to: "ghost", kind: "calls" }],
      });
      expect(result.isError).toBe(true);
      const text = errorText(result);
      expect(text).toContain("ghost");
      expect(text).toContain("not resolve to a live node");
    });

    it("refuses to point an edge at a tombstoned node", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "Add then remove",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
      });
      await handleUpdateArchitecture(tempDir, {
        summary: "Remove it",
        removeServiceIds: ["module:x"],
      });
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Wire to a tombstone",
        nodes: [{ id: "module:y", kind: "module", name: "y", summary: "" }],
        edges: [{ id: "calls:y->x", from: "module:y", to: "module:x", kind: "calls" }],
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("tombstoned");
    });
  });

  // ---------------------------------------------------------------------------
  // 2 + 3. Subject validation: unknown vs tombstoned
  // ---------------------------------------------------------------------------

  describe("subject validation", () => {
    beforeEach(async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "Two modules",
        nodes: [
          { id: "module:a", kind: "module", name: "a", summary: "" },
          { id: "module:b", kind: "module", name: "b", summary: "" },
        ],
      });
    });

    it("errors on an unknown node id", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Attach to a typo",
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "module:z" }] }],
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("module:z");

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.decisions).toHaveLength(0);
    });

    it("accepts a tombstoned node id — removal does not destroy rationale", async () => {
      // ADR-0001:131-137. The node was legitimately removed; the decision that
      // explains it is kept on purpose. Refusing to record it would make the
      // tool reject a correct operation, which is the exact mistake the issue
      // calls out.
      const removal = await handleUpdateArchitecture(tempDir, {
        summary: "Drop module:b",
        removeServiceIds: ["module:b"],
      });
      expect(removal.isError).toBeFalsy();

      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Record why module:b was the way it was",
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "module:b" }] }],
      });
      expect(result.isError).toBeFalsy();

      const payload = body(result);
      expect(payload.decisions[0].claims[0].resolution).toBe("tombstoned");
      // The difference from "unknown" is visible, not silent.
      expect(payload.decisions[0].claims[0].caveats.join(" ")).toContain("no longer exists");
    });

    it("still refuses an id that never existed, after a removal", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Attach to a typo",
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "never-existed" }] }],
      });
      expect(result.isError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Reach-through
  // ---------------------------------------------------------------------------

  describe("reach-through", () => {
    beforeEach(async () => {
      // The shape `deriveModules` emits: a directory node per directory and a
      // node per file, both carrying `path`.
      await handleUpdateArchitecture(tempDir, {
        summary: "Derived module tree",
        nodes: [
          { id: "module:dir:src/io", kind: "module", name: "io", summary: "", path: "src/io" },
          {
            id: "module:src/io/tools.ts",
            kind: "module",
            name: "tools.ts",
            summary: "",
            path: "src/io/tools.ts",
          },
        ],
        edges: [
          { id: "imports:io->tools", from: "module:dir:src/io", to: "module:src/io/tools.ts", kind: "imports" },
        ],
        decisions: [
          {
            ...POSTGRES,
            topic: "Why io is its own module",
            subjects: [{ kind: "node", ref: "module:dir:src/io" }],
          },
        ],
      });
    });

    it("finds a parent node's decision from its module children", async () => {
      const child = body(
        await handleWhyDoesThisExist(tempDir, { nodeId: "module:src/io/tools.ts" })
      );
      expect(child.claims).toHaveLength(1);
      expect(child.claims[0].claim.via).toBe("inherited");
      expect(child.claims[0].claim.depth).toBe(1);
      expect(child.claims[0].claim.attachedTo).toEqual({
        kind: "node",
        id: "module:dir:src/io",
      });
      expect(child.summary.inherited).toBe(1);
    });

    it("reports the hop count through a deeper subtree", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "Root module",
        nodes: [{ id: "module:dir:src", kind: "module", name: "src", summary: "", path: "src" }],
        decisions: [
          {
            ...POSTGRES,
            topic: "Why src is the root",
            subjects: [{ kind: "node", ref: "module:dir:src" }],
          },
        ],
      });
      const deep = body(
        await handleWhyDoesThisExist(tempDir, { nodeId: "module:src/io/tools.ts" })
      );
      const inherited = deep.claims.filter(
        (c: { claim: { via: string } }) => c.claim.via === "inherited"
      );
      // `src/io` is one hop away, `src` is two. Both reach the file, and each
      // says how far it came, so a reader is never told a decision from the
      // repository root explains a single file as directly as one from its own
      // directory.
      expect(
        inherited
          .map((c: { claim: { depth: number; attachedTo: { id: string } } }) => [
            c.claim.depth,
            c.claim.attachedTo.id,
          ])
          .sort((a: unknown, b: unknown) => (a as number[])[0] - (b as number[])[0])
      ).toEqual([
        [1, "module:dir:src/io"],
        [2, "module:dir:src"],
      ]);
    });

    it("does not let a sibling path prefix claim a decision", () => {
      // `src/io-extra` is not under `src/io`, and `src/io-x.ts` is not a child
      // of it. A naive `startsWith` gets both wrong.
      const graph: ArchitectureDocumentV2 = {
        ...createEmpty("graph"),
        nodes: [
          node("module:dir:src/io", "io", "src/io"),
          node("module:dir:src/io-extra", "io-extra", "src/io-extra"),
          node("module:src/io-x.ts", "io-x.ts", "src/io-x.ts"),
        ],
        decisions: [
          {
            id: "dec-001",
            topic: "t",
            decision: "d",
            rationale: "r",
            alternatives: [{ name: "a", whyNot: "b" }],
            timestamp: "2026-01-01T00:00:00.000Z",
            subjects: [{ kind: "node", ref: "module:dir:src/io" }],
          },
        ],
      };
      expect(whyDoesThisExist(graph, "module:dir:src/io-extra").claims).toHaveLength(0);
      expect(whyDoesThisExist(graph, "module:src/io-x.ts").claims).toHaveLength(0);
    });

    it("reaches only through live ancestors", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "Remove the directory node",
        removeServiceIds: ["module:dir:src/io"],
      });
      const child = body(
        await handleWhyDoesThisExist(tempDir, { nodeId: "module:src/io/tools.ts" })
      );
      // The deciding node is gone. Its rationale is still in the document, but
      // it no longer reaches anything: a decision recorded for a deleted parent
      // is not silently re-pointed at its orphans.
      expect(child.claims).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Confidence gates
  // ---------------------------------------------------------------------------

  describe("confidence gates", () => {
    it("distinguishes a decision about an inferred node from one about a verified node", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A derived node and an authored one",
        nodes: [
          {
            id: "module:src/io/tools.ts",
            kind: "module",
            name: "tools.ts",
            summary: "",
            path: "src/io/tools.ts",
            rule: "ts-js/module-node",
            evidence: ["src/io/tools.ts:1"],
          },
          { id: "service:api", kind: "service", name: "api", summary: "HTTP surface" },
        ],
        decisions: [
          {
            ...POSTGRES,
            topic: "The derived module",
            subjects: [{ kind: "node", ref: "module:src/io/tools.ts" }],
          },
          {
            ...POSTGRES,
            topic: "The authored service",
            decision: "One deployable",
            subjects: [{ kind: "node", ref: "service:api" }],
            authoredBy: "human",
          },
        ],
      });

      const derived = body(
        await handleWhyDoesThisExist(tempDir, { nodeId: "module:src/io/tools.ts" })
      );
      const claim = derived.claims[0];
      expect(claim.claim.gate).toBe("derived");
      // The evidence is what the claim rests on, and it travels with it.
      expect(claim.claim.provenance.subject).toMatchObject({
        derived: true,
        rule: "ts-js/module-node",
      });
      expect(claim.claim.provenance.evidence).toEqual(["src/io/tools.ts:1"]);
      expect(claim.claim.caveats.join(" ")).toContain("derived by rule");
      // Who recorded the decision is a separate claim from what it is about.
      expect(claim.claim.provenance.recorded).toEqual({ derived: false, authoredBy: "agent" });

      const authored = body(await handleWhyDoesThisExist(tempDir, { nodeId: "service:api" }));
      expect(authored.claims[0].claim.gate).toBe("authored");
      expect(authored.claims[0].claim.provenance.subject).toEqual({
        derived: false,
        authoredBy: "agent",
      });
      expect(authored.claims[0].claim.provenance.evidence).toEqual([]);
      expect(authored.summary.gates).toEqual({ authored: 1, derived: 0, unresolved: 0 });
    });

    it("reports the gate on the decision as it is recorded", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A derived node",
        nodes: [
          {
            id: "module:src/io/tools.ts",
            kind: "module",
            name: "tools.ts",
            summary: "",
            rule: "ts-js/module-node",
            evidence: ["src/io/tools.ts:1"],
          },
        ],
      });
      const result = await handleRecordDecision(tempDir, {
        ...POSTGRES,
        subjects: [{ kind: "node", ref: "module:src/io/tools.ts" }],
      });
      const payload = body(result);
      expect(payload.claims[0].gate).toBe("derived");
      expect(payload.notes.join(" ")).toContain("inferred element of the system");
    });

    it("requires `rule` and `evidence` together, or neither", () => {
      const withEvidenceOnly = UpdateArchitectureInputSchema.safeParse({
        summary: "trust me",
        nodes: [{ id: "x", kind: "module", name: "x", evidence: ["src/x.ts:1"] }],
      });
      expect(withEvidenceOnly.success).toBe(false);
    });

    it("says so when a subject no longer resolves", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A module",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "module:x" }] }],
      });
      // Remove the node from the file behind the tool's back, so the decision's
      // subject has nothing left to resolve to.
      const raw = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
      raw.nodes = [];
      require("node:fs").writeFileSync(architecturePath(tempDir), JSON.stringify(raw, null, 2));

      const result = await handleWhyDoesThisExist(tempDir, { nodeId: "module:x" });
      expect(result.isError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. `whyDoesThisExist` — the bar
  // ---------------------------------------------------------------------------

  describe("whyDoesThisExist", () => {
    it("returns the decision, its rationale, its rejected alternatives, and provenance for every claim", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A decision with two subjects of different provenance",
        nodes: [
          {
            id: "module:src/a.ts",
            kind: "module",
            name: "a.ts",
            summary: "",
            rule: "ts-js/module-node",
            evidence: ["src/a.ts:1", "src/a.ts:9"],
          },
          { id: "module:src/b.ts", kind: "module", name: "b.ts", summary: "" },
        ],
        edges: [{ id: "calls:a->b", from: "module:src/a.ts", to: "module:src/b.ts", kind: "calls" }],
        decisions: [
          {
            ...POSTGRES,
            subjects: [
              { kind: "node", ref: "module:src/a.ts" },
              { kind: "node", ref: "module:src/b.ts" },
            ],
          },
        ],
      });

      const result = body(await handleWhyDoesThisExist(tempDir, { nodeId: "module:src/a.ts" }));
      expect(result.found).toBe(true);
      expect(result.node).toMatchObject({ id: "module:src/a.ts", kind: "module", live: true });
      expect(result.claims).toHaveLength(1);
      const [claim] = result.claims;

      expect(claim.decision.rationale).toBe(POSTGRES.rationale);
      expect(claim.rejectedAlternatives).toEqual(POSTGRES.alternatives);
      expect(claim.observation).toBe(false);

      // Every claim, every field. A bare rationale would have passed the first
      // three assertions and failed this one.
      expect(claim.claim.subject).toEqual({ kind: "node", ref: "module:src/a.ts" });
      expect(claim.claim.resolution).toBe("resolved");
      expect(claim.claim.gate).toBe("derived");
      expect(claim.claim.provenance.subject).toMatchObject({ derived: true });
      expect(claim.claim.provenance.evidence).toEqual(["src/a.ts:1", "src/a.ts:9"]);
      expect(claim.claim.provenance.recorded).toMatchObject({ authoredBy: "agent" });
      expect(claim.claim.caveats.length).toBeGreaterThan(0);
    });

    it("survives the removal of the node it explains", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A module",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "module:x" }] }],
      });
      await handleUpdateArchitecture(tempDir, {
        summary: "Remove it",
        removeServiceIds: ["module:x"],
      });

      const result = body(await handleWhyDoesThisExist(tempDir, { nodeId: "module:x" }));
      expect(result.found).toBe(true);
      expect(result.node.live).toBe(false);
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0].claim.gate).toBe("unresolved");
      expect(result.summary.gates.unresolved).toBe(1);
      expect(result.notes.join(" ")).toContain("never a hard delete");
    });

    it("errors on an id that is not a node, and says what it looked for", async () => {
      const result = await handleWhyDoesThisExist(tempDir, { nodeId: "no-such-node" });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("no-such-node");
    });

    it("says nothing is recorded rather than pretending the absence means something", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A module with no decision",
        nodes: [
          { id: "module:x", kind: "module", name: "x", summary: "", path: "src/x" },
        ],
      });
      const result = body(await handleWhyDoesThisExist(tempDir, { nodeId: "module:x" }));
      expect(result.claims).toHaveLength(0);
      expect(result.notes.join(" ")).toContain("Absence of a recorded reason");
    });

    it("says why an authored node with no path cannot inherit anything", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "A pathless node with no decision",
        nodes: [{ id: "service:api", kind: "service", name: "api", summary: "" }],
      });
      const result = body(await handleWhyDoesThisExist(tempDir, { nodeId: "service:api" }));
      expect(result.claims).toHaveLength(0);
      expect(result.notes.join(" ")).toContain('needs a "path"');
    });

    it("finds a decision attached to an edge this node is an endpoint of", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "An edge and the decision that created it",
        nodes: [
          { id: "module:a", kind: "module", name: "a", summary: "" },
          { id: "module:b", kind: "module", name: "b", summary: "" },
        ],
        edges: [{ id: "calls:a->b", from: "module:a", to: "module:b", kind: "calls" }],
        decisions: [{ ...POSTGRES, subjects: [{ kind: "edge", ref: "calls:a->b" }] }],
      });
      const result = body(await handleWhyDoesThisExist(tempDir, { nodeId: "module:a" }));
      expect(result.claims[0].claim.via).toBe("incident");
      expect(result.claims[0].claim.attachedTo).toEqual({ kind: "edge", id: "calls:a->b" });
    });
  });

  // ---------------------------------------------------------------------------
  // 5b. A record with no rejected alternative is an observation
  // ---------------------------------------------------------------------------

  describe("rejected alternatives", () => {
    it("refuses a decision with none", async () => {
      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [],
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("observation, not a decision");
    });

    it("refuses a decision whose only alternative records no reason", async () => {
      // `min(1)` counts entries; it does not require the reason. This is the
      // hole the schema rule alone leaves open.
      const result = await handleRecordDecision(tempDir, {
        topic: "T",
        decision: "D",
        rationale: "R",
        alternatives: [{ name: "MongoDB", whyNot: "   " }],
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("blank string is not one");
    });

    it("refuses the same thing sent through update_architecture", async () => {
      const result = await handleUpdateArchitecture(tempDir, {
        summary: "A decision with nothing behind it",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
        decisions: [
          { topic: "T", decision: "D", rationale: "R", alternatives: [] },
        ],
      });
      expect(result.isError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. `removeServiceIds` goes through ADR-0001's transaction
  // ---------------------------------------------------------------------------

  describe("node removal", () => {
    it("removes a graph-native node, which the projection filter could not", async () => {
      // The v1 filter only worked because `foldV1ViewOntoGraph` tombstoned what
      // the filter hid — and it only does that for nodes carrying `legacyType`.
      // A node authored natively in v2 was untouchable from that path.
      await handleUpdateArchitecture(tempDir, {
        summary: "Add a v2-native module",
        nodes: [
          { id: "module:x", kind: "module", name: "x", summary: "" },
          { id: "module:y", kind: "module", name: "y", summary: "" },
        ],
        edges: [
          { id: "imports:x->y", from: "module:x", to: "module:y", kind: "imports" },
        ],
      });

      const result = await handleUpdateArchitecture(tempDir, {
        summary: "Remove it",
        removeServiceIds: ["module:x"],
      });
      expect(result.isError).toBeFalsy();
      expect(body(result).removed).toEqual([{ id: "module:x", droppedEdges: 1 }]);

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.nodes.find((n) => n.id === "module:x")?.deletedAt).toBeTruthy();
      expect(reread.data.edges.some((e) => e.id === "imports:x->y")).toBe(false);
      // The cascade is recorded, with the count.
      const entry = reread.data.history.find((h) => h.action === "remove_node");
      expect(entry?.summary).toContain('"module:x"');
      expect(entry?.summary).toContain("1 edge dropped");
    });

    it("refuses an id that names no node, and tolerates one already removed", async () => {
      const typo = await handleUpdateArchitecture(tempDir, {
        summary: "Remove a typo",
        removeServiceIds: ["module:does-not-exist"],
      });
      expect(typo.isError).toBe(true);
      expect(errorText(typo)).toContain("module:does-not-exist");

      await handleUpdateArchitecture(tempDir, {
        summary: "Add",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
      });
      const first = await handleUpdateArchitecture(tempDir, {
        summary: "Remove",
        removeServiceIds: ["module:x"],
      });
      expect(first.isError).toBeFalsy();
      const second = await handleUpdateArchitecture(tempDir, {
        summary: "Remove again",
        removeServiceIds: ["module:x"],
      });
      expect(second.isError).toBeFalsy();
      expect(body(second).removed).toEqual([]);
    });

    it("leaves the decision explaining a removed node completely alone", async () => {
      await handleUpdateArchitecture(tempDir, {
        summary: "Add a module with a decision",
        nodes: [{ id: "module:x", kind: "module", name: "x", summary: "" }],
        decisions: [{ ...POSTGRES, subjects: [{ kind: "node", ref: "module:x" }] }],
      });
      await handleUpdateArchitecture(tempDir, {
        summary: "Remove it",
        removeServiceIds: ["module:x"],
      });

      const reread = readArchitecture(tempDir);
      if (!reread.success) throw new Error(reread.error);
      expect(reread.data.decisions).toHaveLength(1);
      expect(reread.data.decisions[0].subjects).toEqual([{ kind: "node", ref: "module:x" }]);
    });
  });

  // ---------------------------------------------------------------------------
  // The projection itself
  // ---------------------------------------------------------------------------

  describe("projectDecidedBy", () => {
    const graph = (): ArchitectureDocumentV2 => ({
      ...createEmpty("graph"),
      nodes: [node("module:a", "a"), node("module:b", "b")],
      decisions: [
        {
          id: "dec-001",
          topic: "t",
          decision: "d",
          rationale: "r",
          alternatives: [{ name: "alt", whyNot: "why" }],
          timestamp: "2026-01-01T00:00:00.000Z",
          subjects: [{ kind: "node", ref: "module:a" }],
        },
      ],
    });

    it("emits one edge per resolvable subject and nothing for the rest", () => {
      const document = graph();
      document.decisions[0].subjects.push({ kind: "node", ref: "gone" });
      const projected = projectDecidedBy(document);
      expect(projected).toHaveLength(1);
      expect(projected[0].to).toBe("dec-001");
      // ADR-0002 puts `decided_by` in the authored column, so the join is not
      // presented as derived.
      expect(projected[0].provenance.derived).toBe(false);
    });

    it("emits nothing for a tombstoned subject while leaving the decision alone", () => {
      const document = graph();
      document.nodes[0].deletedAt = "2026-01-01T00:00:00.000Z";
      expect(projectDecidedBy(document)).toHaveLength(0);
      expect(document.decisions[0].subjects).toHaveLength(1);
    });

    it("is deterministic — two runs over an unchanged document agree", () => {
      expect(projectDecidedBy(graph())).toEqual(projectDecidedBy(graph()));
    });
  });
});

// --- helpers ------------------------------------------------------------------

function createEmpty(name: string): ArchitectureDocumentV2 {
  return {
    schemaVersion: 2,
    project: {
      name,
      description: "",
      created: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
    stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
    nodes: [],
    edges: [],
    decisions: [],
    dataFlows: [],
    history: [],
  };
}

function node(id: string, name: string, path?: string) {
  return {
    id,
    kind: "module" as const,
    name,
    summary: "",
    ...(path === undefined ? {} : { path }),
    provenance: derivedFrom("ts-js/module-node", [`${path ?? name}.ts:1`]),
  };
}