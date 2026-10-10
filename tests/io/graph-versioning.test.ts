import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readArchitecture,
  writeArchitecture,
  architecturePath,
  arkiveDirPath,
} from "../../src/io/architecture-file.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/schema/graph.js";

/**
 * Version-aware IO — `docs/issues/0004-graph-persistence.md`.
 *
 * `readArchitecture` used to call `validateArchitecture` directly, so a v1
 * document parsed and a v2 document failed. arkive could produce a v2 document
 * (once `0003` landed) and could not read one back. Everything below is that
 * defect, plus the two rules around it that matter more than the defect:
 *
 *   1. **A read never writes.** ADR-0006 rejected auto-migrate-on-read and
 *      issue 0004 §3 requires it: "a read that rewrites the file loses data to a
 *      tool someone ran while curious."
 *   2. **Migration persists on write, never on read.** A v1 file stays v1 on
 *      disk until something actually writes.
 */

const FIXTURES = join(process.cwd(), "tests", "fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

/** Recursive hash of a whole tree — the "a read wrote nothing" assertion. */
function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        entries.push(`${full}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

describe("version-aware read", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-version-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function put(value: unknown): void {
    writeFileSync(architecturePath(tempDir), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  it("reads a v2 document — the defect this issue exists to fix", () => {
    const v2 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: {
        name: "already-v2",
        description: "written by a build that could not read itself back",
        created: "2026-05-05T00:00:00.000Z",
        lastUpdated: "2026-05-05T00:00:00.000Z",
      },
      stack: {
        language: ["TypeScript"],
        runtime: [],
        framework: [],
        database: [],
        infrastructure: [],
      },
      nodes: [
        {
          id: "api",
          kind: "service",
          name: "API",
          summary: "REST",
          provenance: { derived: false, authoredBy: "agent" },
        },
      ],
      edges: [],
      decisions: [],
      dataFlows: [],
      history: [],
    };
    put(v2);

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(read.data.nodes.map((n) => n.id)).toEqual(["api"]);
    // And the v1 view is still there for consumers that have not migrated.
    expect(read.data.services.map((s) => s.id)).toEqual(["api"]);
  });

  it("reads a v1 document and returns a v2 graph in memory", () => {
    put(fixture("v1-populated.json"));

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    expect(read.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(read.data.version).toBe("1.0.0");
    expect(read.data.nodes).toHaveLength(4);
    expect(read.data.services).toHaveLength(4);
    expect(read.data.decisions).toHaveLength(1);
  });

  it("refuses a document from the future rather than best-effort parsing it", () => {
    put({ schemaVersion: 99, project: { name: "from the future" } });

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.error).toContain("99");
  });

  it("refuses a document it cannot classify, rather than guessing", () => {
    put({ hello: "world" });

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.error).toMatch(/not a recognisable architecture document/i);
  });

  it("reports an unclassifiable document instead of throwing on it", () => {
    // `migrateDocument` calls `migrateV1ToV2`, which reads `v1.services.map`.
    // A document with no `services` used to throw `Cannot read properties of
    // undefined` straight out of the read path.
    put({ version: "1.0.0", project: { name: "sparse" } });

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(false);
  });

  it("a sparse v1 document still loads — the v1 defaults fill the migration's gaps", () => {
    put({
      version: "1.0.0",
      project: {
        name: "sparse",
        description: "no arrays at all",
        created: "2026-05-05T00:00:00.000Z",
        lastUpdated: "2026-05-05T00:00:00.000Z",
      },
    });

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data.nodes).toEqual([]);
    expect(read.data.services).toEqual([]);
    expect(read.data.history).toEqual([]);
  });
});

describe("reading is side-effect free", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-readonly-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads a v1 document and writes nothing at all", () => {
    const v1 = fixture("v1-populated.json");
    const path = architecturePath(tempDir);
    writeFileSync(path, `${JSON.stringify(v1, null, 2)}\n`, "utf-8");

    const before = hashTree(tempDir);
    const beforeBytes = readFileSync(path, "utf-8");

    for (let i = 0; i < 5; i += 1) {
      expect(readArchitecture(tempDir).success).toBe(true);
    }

    expect(hashTree(tempDir)).toBe(before);
    expect(readFileSync(path, "utf-8")).toBe(beforeBytes);
    // Still v1 on disk. The migration persists on the next real write.
    expect(JSON.parse(beforeBytes)).not.toHaveProperty("schemaVersion");
    // And no snapshot was taken: a curious read is not a state transition.
    expect(existsSync(join(tempDir, "arkive", "history"))).toBe(false);
  });

  it("a read of a v2 document writes nothing either", () => {
    const v2 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: {
        name: "v2",
        description: "",
        created: "2026-05-05T00:00:00.000Z",
        lastUpdated: "2026-05-05T00:00:00.000Z",
      },
      stack: { language: [], runtime: [], framework: [], database: [], infrastructure: [] },
      nodes: [],
      edges: [],
      decisions: [],
      dataFlows: [],
      history: [],
    };
    writeFileSync(architecturePath(tempDir), `${JSON.stringify(v2, null, 2)}\n`, "utf-8");

    const before = hashTree(tempDir);
    expect(readArchitecture(tempDir).success).toBe(true);
    expect(hashTree(tempDir)).toBe(before);
  });
});

describe("migration persists on write, and only on write", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-migrate-"));
    mkdirSync(arkiveDirPath(tempDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function put(name: string): Record<string, unknown> {
    const value = fixture(name);
    writeFileSync(architecturePath(tempDir), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    return value;
  }

  for (const name of ["v1-empty.json", "v1-populated.json", "v1-decisions-only.json"]) {
    describe(name, () => {
      it("the next write persists v2, and reading again is stable", () => {
        const before = put(name);

        const first = readArchitecture(tempDir);
        expect(first.success).toBe(true);
        if (!first.success) return;
        expect(writeArchitecture(tempDir, first.data).success).toBe(true);

        // On disk: v2.
        const onDisk = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
        expect(onDisk.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        // `version` is *replaced*, not carried alongside. Two version fields,
        // one decorative and one load-bearing, is the worst of both.
        expect(onDisk).not.toHaveProperty("version");

        // Nothing from the v1 document went missing.
        expect(onDisk.nodes).toHaveLength((before.services as unknown[]).length);
        expect(onDisk.decisions).toHaveLength((before.decisions as unknown[]).length);
        expect(onDisk.dataFlows).toHaveLength((before.dataFlows as unknown[]).length);
        expect(onDisk.history).toHaveLength((before.history as unknown[]).length);

        // Reading again is a fixed point.
        const second = readArchitecture(tempDir);
        expect(second.success).toBe(true);
        if (!second.success) return;
        expect(second.data.version).toBe("2.0.0");
        expect(second.data.nodes).toHaveLength((before.services as unknown[]).length);
      });

      it("the v1 fields survive as a derived projection", () => {
        const before = put(name);
        const read = readArchitecture(tempDir);
        expect(read.success).toBe(true);
        if (!read.success) return;
        expect(writeArchitecture(tempDir, read.data).success).toBe(true);

        const reread = readArchitecture(tempDir);
        expect(reread.success).toBe(true);
        if (!reread.success) return;

        expect(reread.data.services).toHaveLength((before.services as unknown[]).length);
        expect(reread.data.services.map((s) => s.id)).toEqual(
          (before.services as Array<{ id: string }>).map((s) => s.id)
        );
        expect(reread.data.decisions.map((d) => d.id)).toEqual(
          (before.decisions as Array<{ id: string }>).map((d) => d.id)
        );
      });

      it("every rejected alternative survives — the artifact the product exists to keep", () => {
        const before = put(name);
        const read = readArchitecture(tempDir);
        expect(read.success).toBe(true);
        if (!read.success) return;
        expect(writeArchitecture(tempDir, read.data).success).toBe(true);

        const reread = readArchitecture(tempDir);
        expect(reread.success).toBe(true);
        if (!reread.success) return;

        expect(reread.data.decisions.flatMap((d) => d.alternatives)).toEqual(
          (before.decisions as Array<{ alternatives: unknown[] }>).flatMap((d) => d.alternatives)
        );
      });
    });
  }

  it("a dangling v1 connection is preserved and reported, never dropped", () => {
    // ADR-0001:141-145. Dropping it silently is the `62066bc` failure class.
    put("v1-populated.json");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;

    const dangling = read.data.edges.filter((e) => e.dangling === true);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].to).toBe("deleted-service");

    // Reported, loudly, on the read result.
    expect(read.data.warnings?.map((w) => w.code)).toContain("dangling-edge");

    // And it survives the write.
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);
    const after = readArchitecture(tempDir);
    expect(after.success && after.data.edges.filter((e) => e.dangling === true)).toHaveLength(1);
  });

  it("a preserved dangling reference does not make the document unwritable", () => {
    // The authoring check refuses a *new* unresolvable reference, but a
    // document the user wrote years ago and has not touched since must still be
    // writable, or migrating it would be a one-way door.
    put("v1-populated.json");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);
  });

  it("the v1 `type` taxonomy round-trips through the projection", () => {
    put("v1-populated.json");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    const services = after.services as Array<{ id: string; type: string }>;
    expect(services.find((s) => s.id === "web")?.type).toBe("frontend");
    expect(services.find((s) => s.id === "db")?.type).toBe("database");
    expect(services.find((s) => s.id === "cache")?.type).toBe("cache");
  });

  it("`confidence` survives, so drift does not go quiet on a migrated document", () => {
    // ADR-0002 deletes `confidence` as inert. Dropping it on migration would
    // silently *reduce* the warnings `drift.ts` emits. A detector that goes
    // quiet is worse than one that nags.
    put("v1-populated.json");

    const read = readArchitecture(tempDir);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(writeArchitecture(tempDir, read.data).success).toBe(true);

    const after = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    const nodes = after.nodes as Array<Record<string, unknown>>;
    const db = nodes.find((n) => n.id === "db");
    expect(db?.confidence).toBe(0.3);
    expect(db?.source).toBe("inferred");

    // And the connection-level pair, which lands on the migrated edge.
    const edges = after.edges as Array<Record<string, unknown>>;
    const sql = edges.find((e) => e.label === "TCP/SQL");
    expect(sql?.confidence).toBe(0.4);
    expect(sql?.source).toBe("inferred");
  });
});