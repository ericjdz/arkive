import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARKIVE_DIR,
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { applyZodDefaults, collectUnknownKeys, contentHash, stableStringify } from "../../src/io/preserve.js";

/**
 * Regression E — unknown-key round trip.
 *
 * `ArchitectureSchema` is built from plain `z.object()`, which strips unknown
 * keys in Zod v4. `readArchitecture` used to return `validation.data` and
 * `writeArchitecture` used to serialise it, so the pipeline was read -> strip ->
 * write. Every key arkive did not recognise was destroyed by the next write.
 *
 * This is the class ADR-0006 §3 closes, and the reason it is the highest
 * leverage change in the ADR: the document is the user's, Zod supplies
 * warnings about it, and nothing gets to delete a field because a schema has
 * not caught up yet.
 */

/** A document with `x-custom` keys at document, service, connection, decision,
 * alternative, dataFlow, and history level. Every level must survive. */
function fixtureWithUnknownKeys(): Record<string, unknown> {
  return {
    version: "1.0.0",
    "x-document-level": { addedBy: "a human", why: "not in the schema" },
    project: {
      name: "unknown-keys",
      description: "Round trip fixture",
      created: "2026-05-05T00:00:00.000Z",
      lastUpdated: "2026-05-05T00:00:00.000Z",
      "x-project-level": "kept",
    },
    stack: {
      language: ["TypeScript"],
      runtime: [],
      framework: [],
      database: [],
      infrastructure: [],
      "x-stack-level": [1, 2, 3],
    },
    services: [
      {
        id: "api",
        name: "API",
        type: "backend",
        technology: "Node",
        description: "The API",
        dependencies: [],
        "x-service-level": { owner: "platform-team" },
      },
    ],
    connections: [
      {
        from: "api",
        to: "api",
        protocol: "loopback",
        description: "A connection to itself, to carry an unknown key",
        "x-connection-level": "kept",
      },
    ],
    decisions: [
      {
        id: "dec-001",
        topic: "Unknown keys",
        decision: "Preserve them",
        rationale: "They are the user's data",
        alternatives: [{ name: "Strip them", whyNot: "That is how the data was lost" }],
        timestamp: "2026-05-05T00:00:00.000Z",
        relatedServices: ["api"],
        "x-decision-level": "kept",
        alternatives_with_unknowns: [
          { name: "Strip them", whyNot: "loss", "x-alternative-level": "kept" },
        ],
      },
    ],
    dataFlows: [
      {
        name: "A flow",
        steps: [{ actor: "user", action: "does a thing", "x-step-level": "kept" }],
        "x-dataflow-level": "kept",
      },
    ],
    history: [
      {
        timestamp: "2026-05-05T00:00:00.000Z",
        action: "initial_scaffold",
        summary: "Created",
        "x-history-level": "kept",
      },
    ],
  };
}

describe("regression E — unknown keys survive a full read -> write cycle", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-preserve-"));
    mkdirSync(join(tempDir, ARKIVE_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves unknown keys at every level of the document", () => {
    const fixture = fixtureWithUnknownKeys();
    writeFileSync(architecturePath(tempDir), JSON.stringify(fixture, null, 2), "utf-8");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    // The document read back carries the user's keys, not a Zod reconstruction.
    const asRecord = read.data as unknown as Record<string, unknown>;
    expect(asRecord["x-document-level"]).toEqual({
      addedBy: "a human",
      why: "not in the schema",
    });
    expect((read.data.project as unknown as Record<string, unknown>)["x-project-level"]).toBe("kept");
    expect((read.data.stack as unknown as Record<string, unknown>)["x-stack-level"]).toEqual([1, 2, 3]);
    expect((read.data.services[0] as unknown as Record<string, unknown>)["x-service-level"]).toEqual({
      owner: "platform-team",
    });
    expect(
      (read.data.connections[0] as unknown as Record<string, unknown>)["x-connection-level"]
    ).toBe("kept");
    expect(
      (read.data.decisions[0] as unknown as Record<string, unknown>)["x-decision-level"]
    ).toBe("kept");
    expect(
      (read.data.dataFlows[0] as unknown as Record<string, unknown>)["x-dataflow-level"]
    ).toBe("kept");
    expect(
      (read.data.history[0] as unknown as Record<string, unknown>)["x-history-level"]
    ).toBe("kept");
  });

  it("preserves them through write -> read -> write, byte-for-byte", () => {
    const original = fixtureWithUnknownKeys();
    writeFileSync(architecturePath(tempDir), JSON.stringify(original, null, 2), "utf-8");

    // `lastUpdated` is the one field a write is expected to change, so it is
    // normalised out of every comparison.
    const stripVolatile = (doc: unknown): string => {
      const clone = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      (clone.project as Record<string, unknown>).lastUpdated = "<volatile>";
      return stableStringify(clone);
    };

    // The first write is where the *shape* changes: a v1 document becomes a v2
    // graph. That is the point of the migration, and it is asserted directly by
    // `migration.test.ts`. What must not change is a single byte of the user's
    // own data — so the invariant this test guards is measured from the first
    // write onward, once the shape has settled.
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const afterFirstWrite = stripVolatile(
      JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"))
    );

    const second = readArchitecture(tempDir);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(writeArchitecture(tempDir, second.data).success).toBe(true);

    const afterSecondWrite = stripVolatile(
      JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"))
    );

    expect(afterSecondWrite).toBe(afterFirstWrite);
  });

  it("every unknown key in a v1 fixture survives the v1 -> v2 migration", () => {
    // The migration is a *semantic* transform: it reads named fields and builds
    // a fresh object. Anything it does not name falls on the floor — which is
    // the class ADR-0006 §3 exists to close, reintroduced by the upgrade itself.
    // `carryV1UnknownKeys` is what puts each key back on the element it came from.
    const original = fixtureWithUnknownKeys();
    writeFileSync(architecturePath(tempDir), JSON.stringify(original, null, 2), "utf-8");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8")) as Record<
      string,
      unknown
    >;

    // Document level.
    expect(after["x-document-level"]).toEqual({
      addedBy: "a human",
      why: "not in the schema",
    });
    expect((after.project as Record<string, unknown>)["x-project-level"]).toBe("kept");
    expect((after.stack as Record<string, unknown>)["x-stack-level"]).toEqual([1, 2, 3]);

    // Node level — `services[0]` became `nodes[0]`.
    const node = (after.nodes as Array<Record<string, unknown>>)[0];
    expect(node["x-service-level"]).toEqual({ owner: "platform-team" });

    // Edge level — the one connection became one edge.
    const edge = (after.edges as Array<Record<string, unknown>>).find(
      (e) => e.label === "loopback"
    );
    expect(edge?.["x-connection-level"]).toBe("kept");

    // Decision, alternative, dataFlow, step, history.
    const decision = (after.decisions as Array<Record<string, unknown>>)[0];
    expect(decision["x-decision-level"]).toBe("kept");
    expect(decision["alternatives_with_unknowns"]).toEqual([
      { name: "Strip them", whyNot: "loss", "x-alternative-level": "kept" },
    ]);
    const flow = (after.dataFlows as Array<Record<string, unknown>>)[0];
    expect(flow["x-dataflow-level"]).toBe("kept");
    expect((flow.steps as Array<Record<string, unknown>>)[0]["x-step-level"]).toBe("kept");
    expect((after.history as Array<Record<string, unknown>>)[0]["x-history-level"]).toBe("kept");

    // And the same keys are still readable through the deprecated projection,
    // so a v1 consumer editing the file directly cannot lose them either.
    const reread = readArchitecture(tempDir);
    expect(reread.success).toBe(true);
    if (!reread.success) return;
    expect(
      (reread.data.services[0] as unknown as Record<string, unknown>)["x-service-level"]
    ).toEqual({ owner: "platform-team" });
  });

  it("preserves a hand-added key across an update that touches a known field", () => {
    // This is the `update_architecture` shape: read, mutate a service, write.
    const original = fixtureWithUnknownKeys();
    writeFileSync(architecturePath(tempDir), JSON.stringify(original, null, 2), "utf-8");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    read.data.services.push({
      id: "worker",
      name: "Worker",
      type: "queue",
      technology: "Node",
      description: "Added by an update",
      dependencies: ["api"],
    });
    read.data.history.push({
      timestamp: "2026-05-06T00:00:00.000Z",
      action: "update_architecture",
      summary: "Added a worker",
    });

    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    expect(after.services).toHaveLength(2);
    expect(after["x-document-level"]).toEqual({ addedBy: "a human", why: "not in the schema" });
    expect(after.services[0]["x-service-level"]).toEqual({ owner: "platform-team" });
    expect(after.decisions[0]["x-decision-level"]).toBe("kept");
  });

  it("survives ten cycles without drifting a single byte of the unknown keys", () => {
    const original = fixtureWithUnknownKeys();
    writeFileSync(architecturePath(tempDir), JSON.stringify(original, null, 2), "utf-8");

    const stripVolatile = (doc: Record<string, unknown>): string => {
      const clone = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      (clone.project as Record<string, unknown>).lastUpdated = "<volatile>";
      return stableStringify(clone);
    };

    let expected = stripVolatile(original);
    for (let i = 0; i < 10; i += 1) {
      const read = readArchitecture(tempDir);
      expect(read.success).toBe(true);
      if (!read.success) return;
      expect(writeArchitecture(tempDir, read.data).success).toBe(true);
      const onDisk = stripVolatile(
        JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"))
      );
      // Every cycle after the first must be byte-identical to the one before.
      // The first is exempt: that is where v1 becomes v2.
      if (i > 0) expect(onDisk).toBe(expected);
      expected = onDisk;
    }

    const final = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    expect(stripVolatile(final)).toBe(expected);
    expect(final["x-document-level"]).toBeTruthy();
  });

  it("keeps schema defaults working — a document missing optional sections still loads", () => {
    // Preservation must not come at the cost of a usable document: the old
    // `validation.data` path materialised defaults, and callers depend on
    // `stack`, `services` and `history` being present.
    writeFileSync(
      architecturePath(tempDir),
      JSON.stringify({
        version: "1.0.0",
        project: {
          name: "sparse",
          description: "No stack, no arrays at all",
          created: "2026-05-05T00:00:00.000Z",
          lastUpdated: "2026-05-05T00:00:00.000Z",
        },
      }),
      "utf-8"
    );

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    // Sparse v1 documents still produce a usable v2 graph: `migrateDocument`
    // calls `migrateV1ToV2`, which reads `v1.services.map(...)`, so the v1
    // schema's defaults have to be merged in before the migration runs. Without
    // that, this used to throw `Cannot read properties of undefined`.
    expect(read.data.schemaVersion).toBe(2);
    expect(read.data.nodes).toEqual([]);
    expect(read.data.services).toEqual([]);
    expect(read.data.connections).toEqual([]);
    expect(read.data.decisions).toEqual([]);
    expect(read.data.dataFlows).toEqual([]);
    expect(read.data.history).toEqual([]);
    expect(read.data.stack.language).toEqual([]);
  });

  it("still refuses to write a document that is genuinely invalid", () => {
    // Preservation is not a licence to write anything.
    const arch = createEmptyArchitecture("invalid", "Invalid");
    arch.connections.push({
      from: "ghost",
      to: "phantom",
      protocol: "HTTP",
      description: "References services that do not exist",
    });

    const result = writeArchitecture(tempDir, arch);

    expect(result.success).toBe(false);
    expect(existsSync(architecturePath(tempDir))).toBe(false);
  });

  it("does not write a file it could not validate in the first place", () => {
    writeFileSync(
      architecturePath(tempDir),
      JSON.stringify({ version: "1.0.0" }),
      "utf-8"
    );
    const read = readArchitecture(tempDir);
    expect(read.success).toBe(false);
  });
});

describe("applyZodDefaults", () => {
  it("never lets the schema output overwrite a value the document already has", () => {
    const result = applyZodDefaults(
      { project: { name: "mine" } },
      { project: { name: "theirs", description: "added" } }
    );
    expect(result).toEqual({ project: { name: "mine", description: "added" } });
  });

  it("fills gaps recursively, including inside arrays of objects", () => {
    const result = applyZodDefaults(
      { services: [{ id: "a" }, { id: "b", dependencies: ["a"] }] },
      { services: [{ id: "x", dependencies: [], name: "default" }, { id: "y", dependencies: [], name: "default" }] }
    );
    expect(result).toEqual({
      services: [
        { id: "a", dependencies: [], name: "default" },
        { id: "b", dependencies: ["a"], name: "default" },
      ],
    });
  });

  it("passes unknown keys straight through", () => {
    const result = applyZodDefaults({ a: 1, mystery: "kept" }, { a: 2 });
    expect(result).toEqual({ a: 1, mystery: "kept" });
  });

  it("handles an empty object and a nullish document without throwing", () => {
    expect(applyZodDefaults({}, { a: 1 })).toEqual({ a: 1 });
    expect(applyZodDefaults(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(applyZodDefaults(null, { a: 1 })).toBeNull();
  });
});

describe("collectUnknownKeys", () => {
  it("finds unknown keys at every level, by path", () => {
    const document = fixtureWithUnknownKeys();
    const validation = {
      version: "1.0.0",
      project: { name: "", description: "", created: "", lastUpdated: "" },
      stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
      services: [
        {
          id: "api",
          name: "API",
          type: "backend",
          technology: "Node",
          description: "",
          dependencies: [],
        },
      ],
      connections: [],
      decisions: [],
      dataFlows: [],
      history: [],
    };

    const unknown = collectUnknownKeys(document, validation);

    expect(unknown).toContain("x-document-level");
    expect(unknown).toContain("project.x-project-level");
    expect(unknown).toContain("services[0].x-service-level");
  });
});

describe("contentHash", () => {
  it("is stable across key ordering — it hashes content, not layout", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("differs when the content differs", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
