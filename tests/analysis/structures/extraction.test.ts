import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules } from "../../../src/analysis/derive.js";
import { structureNodeId } from "../../../src/analysis/structures/derive.js";
import type { DerivationResult } from "../../../src/analysis/derive.js";
import type { GraphNode } from "../../../src/schema/graph.js";
import type { StructureField } from "../../../src/analysis/structures/types.js";

/**
 * `datastructure` nodes from TypeScript declarations and Zod schemas.
 *
 * Issue 0006 §1: *"TypeScript interfaces/types and Zod schemas produce
 * `datastructure` nodes with fields and types."* This file is that claim, tested.
 *
 * The assertions check the **line each field cites**, not just that a field
 * exists. A `datastructure` node whose fields point at the wrong lines is
 * indistinguishable from a correct one by shape — the same argument
 * `tests/analysis/derive.test.ts` makes for import evidence — and a learner who
 * opens `evidence` to check a field is the whole reason provenance exists.
 */

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function shape(result: DerivationResult, path: string, name: string): GraphNode {
  const id = structureNodeId(path, name);
  const found = result.nodes.find((node) => node.id === id);
  if (found === undefined) {
    throw new Error(
      `no ${id} in [${result.nodes.filter((n) => n.kind === "datastructure").map((n) => n.id).join(", ")}]`
    );
  }
  return found;
}

function fieldsOf(node: GraphNode): StructureField[] {
  return (node as unknown as { fields: StructureField[] }).fields;
}

function citedLine(dir: string, locator: string): string {
  const at = locator.lastIndexOf(":");
  const path = locator.slice(0, at);
  const line = Number(locator.slice(at + 1));
  return readFileSync(join(dir, ...path.split("/")), "utf-8").split("\n")[line - 1] ?? "";
}

describe("TypeScript declarations become datastructure nodes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-ts-shape-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records every field of an interface with its type and optionality", () => {
    write(
      tempDir,
      "src/service.ts",
      [
        "export interface ServiceRecord {",
        "  id: string;",
        "  port: number;",
        "  owner?: OwnerRecord;",
        "}",
      ].join("\n")
    );

    const node = shape(deriveModules(tempDir), "src/service.ts", "ServiceRecord");

    expect(node.kind).toBe("datastructure");
    expect(node.name).toBe("ServiceRecord");
    expect(node.path).toBe("src/service.ts");
    expect(fieldsOf(node)).toEqual([
      { name: "id", type: "string", optional: false, line: 2 },
      { name: "port", type: "number", optional: false, line: 3 },
      { name: "owner", type: "OwnerRecord", optional: true, line: 4 },
    ]);
  });

  it("carries the declaration site as derived provenance with evidence", () => {
    write(tempDir, "src/service.ts", `export interface ServiceRecord {\n  id: string;\n}\n`);

    const node = shape(deriveModules(tempDir), "src/service.ts", "ServiceRecord");

    // ADR-0002:97-101 — derived elements carry `derived`, `rule` and `evidence`.
    expect(node.provenance).toEqual({
      derived: true,
      rule: "ts-types/datastructure-node",
      evidence: ["src/service.ts:1"],
    });
    expect(citedLine(tempDir, "src/service.ts:1")).toMatch(/export interface ServiceRecord/);
  });

  it("reads a semicolon-free, newline-separated interface without merging fields", () => {
    // The first version of this extractor split only on `;`, so this produced
    // one field called `x` of type `number y: number`. A shape that has fewer
    // fields than the source is indistinguishable from a shape that has fewer.
    write(tempDir, "src/point.ts", "export interface Point {\n  x: number\n  y: number\n}\n");

    const node = shape(deriveModules(tempDir), "src/point.ts", "Point");

    expect(fieldsOf(node).map((field) => [field.name, field.type])).toEqual([
      ["x", "number"],
      ["y", "number"],
    ]);
  });

  it("records a nested object type as one field rather than flattening it", () => {
    write(
      tempDir,
      "src/config.ts",
      "export interface AppConfig {\n  db: {\n    host: string;\n    port: number;\n  };\n  name: string;\n}\n"
    );

    const node = shape(deriveModules(tempDir), "src/config.ts", "AppConfig");

    expect(fieldsOf(node).map((field) => field.name)).toEqual(["db", "name"]);
    expect(fieldsOf(node)[0].type).toContain("host: string");
  });

  it("reads an object-literal type alias as a shape", () => {
    write(
      tempDir,
      "src/edge.ts",
      "export type Connection = {\n  from: string;\n  to: string;\n  retries?: number;\n};\n"
    );

    const node = shape(deriveModules(tempDir), "src/edge.ts", "Connection");

    expect((node as unknown as { structureForm: string }).structureForm).toBe("type-alias");
    expect(fieldsOf(node).map((field) => field.name)).toEqual(["from", "to", "retries"]);
  });

  it("does not emit a node for a type alias that is not a record", () => {
    // `type Id = string` is a name for a primitive. A `datastructure` node for
    // it would answer "what does a UserId contain" with "nothing", which is not
    // a question worth a node and an edge set.
    write(tempDir, "src/ids.ts", "export type Id = string;\nexport const x: Id = 'a';\n");

    const result = deriveModules(tempDir);

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
  });

  it("skips methods, accessors and index signatures rather than calling them fields", () => {
    write(
      tempDir,
      "src/thing.ts",
      [
        "export class Thing {",
        "  name: string;",
        "  [key: string]: unknown;",
        "  render(): void {}",
        "  get size(): number { return 0; }",
        "  private secret: string;",
        "}",
      ].join("\n")
    );

    const node = shape(deriveModules(tempDir), "src/thing.ts", "Thing");

    expect(fieldsOf(node).map((field) => field.name)).toEqual(["name", "secret"]);
  });

  it("strips `readonly` but keeps the field", () => {
    write(tempDir, "src/frozen.ts", "export interface Frozen {\n  readonly id: string;\n}\n");

    expect(fieldsOf(shape(deriveModules(tempDir), "src/frozen.ts", "Frozen"))).toEqual([
      { name: "id", type: "string", optional: false, line: 2 },
    ]);
  });

  it("names the shapes a field's type refers to, without inventing an edge", () => {
    write(
      tempDir,
      "src/owner.ts",
      "export interface OwnerRecord {\n  email: string;\n}\n"
    );
    write(
      tempDir,
      "src/service.ts",
      "export interface ServiceRecord {\n  owner: OwnerRecord;\n  pending: Promise<OwnerRecord>;\n}\n"
    );

    const node = shape(deriveModules(tempDir), "src/service.ts", "ServiceRecord");

    // `Promise` is a global type, not a shape; `OwnerRecord` is.
    expect((node as unknown as { shapeReferences: string[] }).shapeReferences).toEqual([
      "OwnerRecord",
    ]);
  });

  it("marks a file it could not fully read as incomplete and says so", () => {
    // An unterminated string means the rest of the file was never searched. The
    // answer is `complete: false` and a coverage drop, not "no shapes here".
    write(tempDir, "src/broken.ts", `export interface A {\n  name: string;\n  bio: 'unterminated\n`);

    const result = deriveModules(tempDir);

    expect(result.structures.filesIncomplete).toBe(1);
    expect(result.structureCoverage).toBeLessThan(1);
    expect(result.notes.join(" ")).toMatch(/could not fully read/i);
  });

  it("records an unbalanced declaration body as incomplete rather than emitting a partial shape", () => {
    write(tempDir, "src/truncated.ts", "export interface Cut {\n  id: string;\n");

    const result = deriveModules(tempDir);

    expect(result.structures.filesIncomplete).toBe(1);
    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
  });
});

describe("Zod schemas become datastructure nodes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-zod-shape-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records a z.object's members with their types and optionality", () => {
    write(
      tempDir,
      "src/user.ts",
      [
        "import { z } from 'zod';",
        "",
        "export const UserSchema = z.object({",
        "  id: z.string(),",
        "  age: z.number(),",
        "  nickname: z.string().optional(),",
        "});",
      ].join("\n")
    );

    const node = shape(deriveModules(tempDir), "src/user.ts", "UserSchema");

    expect((node as unknown as { structureForm: string }).structureForm).toBe("zod-object");
    expect(fieldsOf(node)).toEqual([
      { name: "id", type: "string", optional: false, line: 4 },
      { name: "age", type: "number", optional: false, line: 5 },
      { name: "nickname", type: "string", optional: true, line: 6 },
    ]);
  });

  it("maps wrappers onto the type they wrap", () => {
    write(
      tempDir,
      "src/thing.ts",
      [
        "import { z } from 'zod';",
        "export const ThingSchema = z.object({",
        "  tags: z.array(z.string()),",
        "  counts: z.record(z.number()),",
        "  when: z.date(),",
        "  maybe: z.string().nullable(),",
        "  either: z.union([z.string(), z.number()]),",
        "  nested: z.object({ inner: z.boolean() }),",
        "});",
      ].join("\n")
    );

    const node = shape(deriveModules(tempDir), "src/thing.ts", "ThingSchema");

    expect(fieldsOf(node).map((field) => [field.name, field.type])).toEqual([
      ["tags", "string[]"],
      ["counts", "record"],
      ["when", "date"],
      ["maybe", "string|null"],
      ["either", "union"],
      ["nested", "object"],
    ]);
  });

  it("treats a chained `.default()` as optional and nothing else", () => {
    write(
      tempDir,
      "src/config.ts",
      [
        "import { z } from 'zod';",
        "export const ConfigSchema = z.object({",
        "  retries: z.number().default(3),",
        "  caught: z.string().catch('fallback'),",
        "});",
      ].join("\n")
    );

    const node = shape(deriveModules(tempDir), "src/config.ts", "ConfigSchema");

    expect(fieldsOf(node).map((field) => [field.name, field.type, field.optional])).toEqual([
      ["retries", "number", true],
      ["caught", "string", true],
    ]);
  });

  it("reads both an interface and a Zod schema declared in the same file", () => {
    // The whole reason the structure registry runs every claimant rather than
    // throwing on a duplicate extension claim, the way the import registry does.
    write(
      tempDir,
      "src/both.ts",
      [
        "import { z } from 'zod';",
        "export interface Shape { id: string }",
        "export const ShapeSchema = z.object({ id: z.string(), extra: z.number() });",
      ].join("\n")
    );

    const result = deriveModules(tempDir);
    const ids = result.nodes.filter((node) => node.kind === "datastructure").map((n) => n.id);

    expect(ids).toContain(structureNodeId("src/both.ts", "Shape"));
    expect(ids).toContain(structureNodeId("src/both.ts", "ShapeSchema"));
  });

  it("reports no shapes for a file with no declarations, as a claim rather than a gap", () => {
    write(tempDir, "src/empty.ts", "export const helper = () => 1;\n");

    const result = deriveModules(tempDir);

    expect(result.nodes.filter((node) => node.kind === "datastructure")).toEqual([]);
    expect(result.structureCoverage).toBe(1);
    expect(result.structures.filesIncomplete).toBe(0);
  });
});