import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules } from "../../../src/analysis/derive.js";
import { describeCoupling, structureNodeId } from "../../../src/analysis/structures/derive.js";
import type { DerivationResult } from "../../../src/analysis/derive.js";
import type { GraphEdge } from "../../../src/schema/graph.js";

/**
 * The coupling surface, and the transformations between shapes.
 *
 * Issue 0006 §2: *"A data structure touched by twelve modules is a coupling
 * point, and it should be visible without reading twelve modules."*
 * §3: *"Where a shape is mapped into another, emit an edge with the mapping
 * attached. Silent reshaping between layers is where real bugs live and it is
 * invisible in a module graph."*
 *
 * ## What the fixture is
 *
 * One shape, `Invoice`, written by three modules and read by two. Each writer
 * constructs it a different way — an annotated literal, a factory function
 * returning a literal, a Zod parse — because "written by" has to mean something
 * a reader can check rather than "mentioned by". Each reader uses it in a
 * different position — a parameter, a return type, a property — because those are
 * the positions that make a shape a dependency.
 *
 * The assertion is on the **coupling**, not on the presence of edges: the exact
 * set of writing modules and the exact set of reading modules, so a
 * misclassified direction or an extra module fails here rather than being read as
 * "roughly right".
 */

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** The shape every module in the coupling fixture touches. */
const INVOICE = [
  "export interface Invoice {",
  "  id: string;",
  "  totalCents: number;",
  "  currency: string;",
  "}",
].join("\n");

function couplingFixture(dir: string): void {
  write(dir, "src/invoice.ts", INVOICE);

  // --- three writers, each constructing the shape a different way -----------
  write(
    dir,
    "src/checkout.ts",
    [
      'import type { Invoice } from "./invoice.js";',
      "",
      "// Writer 1: an annotated object literal.",
      "export const draft: Invoice = { id: 'x', totalCents: 0, currency: 'GBP' };",
    ].join("\n")
  );

  write(
    dir,
    "src/billing.ts",
    [
      'import type { Invoice } from "./invoice.js";',
      "",
      "// Writer 2: a factory whose declared return type is the shape and whose",
      "// body returns an object literal.",
      "export function makeInvoice(id: string, totalCents: number): Invoice {",
      "  return { id, totalCents, currency: 'GBP' };",
      "}",
    ].join("\n")
  );

  write(
    dir,
    "src/import.ts",
    [
      'import type { Invoice } from "./invoice.js";',
      'import { z } from "zod";',
      "",
      "// Writer 3: a Zod parse into the shape.",
      "const InvoiceSchema = z.object({ id: z.string(), totalCents: z.number() });",
      "export function readInvoice(raw: unknown): Invoice {",
      "  const parsed = InvoiceSchema.parse(raw);",
      "  return { id: parsed.id, totalCents: parsed.totalCents, currency: 'GBP' };",
      "}",
    ].join("\n")
  );

  // --- two readers, in different positions ----------------------------------
  write(
    dir,
    "src/email.ts",
    [
      'import type { Invoice } from "./invoice.js";',
      "",
      "// Reader 1: a parameter type.",
      "export function send(invoice: Invoice): string {",
      "  return invoice.id;",
      "}",
    ].join("\n")
  );

  write(
    dir,
    "src/report.ts",
    [
      'import type { Invoice } from "./invoice.js";',
      "",
      "// Reader 2: a return type and a property type.",
      "export function summarise(invoices: Invoice[]): string {",
      "  return invoices.length.toString();",
      "}",
    ].join("\n")
  );
}

function edgesFor(result: DerivationResult, shapeId: string): GraphEdge[] {
  return result.edges.filter((edge) => edge.to === shapeId);
}

describe("a shape touched by five modules shows its coupling surface", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-coupling-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
    couplingFixture(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("answers 'which modules write this shape' correctly", () => {
    const result = deriveModules(tempDir);
    const coupling = describeCoupling(result, structureNodeId("src/invoice.ts", "Invoice"));

    expect(coupling.writes).toEqual([
      "module:src/billing.ts",
      "module:src/checkout.ts",
      "module:src/import.ts",
    ]);
  });

  it("answers 'which modules read this shape' correctly", () => {
    const result = deriveModules(tempDir);
    const coupling = describeCoupling(result, structureNodeId("src/invoice.ts", "Invoice"));

    // `billing` and `import` construct `Invoice` and are therefore **not** in
    // the read set, even though both declare a return type of it. That is the
    // whole point of the direction: the question "which modules can I break by
    // changing this shape" has to be answerable, and it is not answerable if
    // every writer is also reported as a reader.
    expect(coupling.reads).toEqual(["module:src/email.ts", "module:src/report.ts"]);
    expect(coupling.modules).toBe(5);
    expect(coupling.reads).not.toContain("module:src/billing.ts");
  });

  it("distinguishes writing from reading rather than counting mentions", () => {
    // The whole point of the direction. A reader that collapses both into
    // "touches" would report the same five modules for either question, and the
    // question "which modules can I break by changing this shape" would have no
    // answer.
    const result = deriveModules(tempDir);
    const shapeId = structureNodeId("src/invoice.ts", "Invoice");

    const writes = edgesFor(result, shapeId).filter((edge) => edge.kind === "writes");
    const reads = edgesFor(result, shapeId).filter((edge) => edge.kind === "reads");

    expect(new Set(writes.map((edge) => edge.from))).not.toEqual(
      new Set(reads.map((edge) => edge.from))
    );
    expect(writes.some((edge) => edge.from === "module:src/email.ts")).toBe(false);
    expect(reads.some((edge) => edge.from === "module:src/checkout.ts")).toBe(false);
  });

  it("records every construction site as evidence on one edge, not one edge each", () => {
    // ADR-0002:101-103 — evidence is an array because one edge has many sites.
    // Three writers to one shape is three `writes` edges carrying one site each —
    // one per (module, shape) pair — and every site is openable.
    const result = deriveModules(tempDir);
    const shapeId = structureNodeId("src/invoice.ts", "Invoice");
    const writeEdges = edgesFor(result, shapeId).filter((edge) => edge.kind === "writes");

    expect(writeEdges).toHaveLength(3);
    for (const edge of writeEdges) {
      expect(edge.provenance.derived && edge.provenance.rule).toBe("ts-types/shape-edge");
      expect(edge.provenance.derived && edge.provenance.evidence).toHaveLength(1);
      // Each cites a line a reader can open, and that line really does construct.
      const [site] = edge.provenance.derived ? edge.provenance.evidence : [];
      expect(site).toMatch(/^src\/(billing|checkout|import)\.ts:\d+$/);
    }

    // Two construction sites in one module merge onto one edge, because the
    // edge is keyed by (module, shape) and the sites are an array on it.
    const merged = writeEdges.find((edge) => edge.from === "module:src/import.ts");
    // Line 8, not line 6: `evidence` points at the `return {` where the value
    // is built, not at the signature that declares its type.
    expect(merged?.provenance.derived && merged.provenance.evidence).toEqual(["src/import.ts:8"]);

    const billing = writeEdges.find((edge) => edge.from === "module:src/billing.ts");
    expect(billing?.provenance.derived && billing.provenance.evidence).toEqual([
      "src/billing.ts:6",
    ]);
  });

  it("names the construction each direction was established by", () => {
    const result = deriveModules(tempDir);
    const shapeId = structureNodeId("src/invoice.ts", "Invoice");
    const notes = edgesFor(result, shapeId).map((edge) => edge.note ?? "");

    expect(notes).toContain("constructs Invoice via annotated-literal");
    expect(notes).toContain("constructs Invoice via return-literal");
    expect(notes.some((note) => note.startsWith("consumes Invoice via type-reference"))).toBe(true);
  });

  it("links the shape to the module that declares it", () => {
    const result = deriveModules(tempDir);
    const edge = result.edges.find(
      (candidate) =>
        candidate.id ===
        "derives_from:module:src/invoice.ts->datastructure:src/invoice.ts::Invoice"
    );

    expect(edge).toBeDefined();
    expect(edge?.kind).toBe("derives_from");
    expect(edge?.provenance.derived && edge.provenance.evidence).toEqual(["src/invoice.ts:1"]);
  });

  it("does not resolve an ambiguous name rather than picking one", () => {
    // Two shapes named `Invoice` in two files is two shapes. Linking a third
    // file's reference to either would be a guess, and a guessed edge is
    // indistinguishable from a derived one.
    write(
      tempDir,
      "src/legacy.ts",
      "export interface Invoice {\n  legacyId: string;\n}\n"
    );
    write(
      tempDir,
      "src/consumer.ts",
      [
        'import type { Invoice } from "./invoice.js";',
        "export const render = (i: Invoice): string => i.id;",
      ].join("\n")
    );

    const result = deriveModules(tempDir);

    // Both shapes exist as separate nodes…
    const ids = result.nodes.filter((n) => n.kind === "datastructure").map((n) => n.id);
    expect(ids).toContain(structureNodeId("src/invoice.ts", "Invoice"));
    expect(ids).toContain(structureNodeId("src/legacy.ts", "Invoice"));

    // …and the consumer's reference, which imports one of them but does not
    // name which by import alone, is reported rather than guessed.
    expect(result.structures.unresolved.some((entry) => entry.name === "Invoice")).toBe(true);
    expect(result.notes.join(" ")).toMatch(/could not be attributed/i);
  });
});

describe("a mapping written down is recorded, with the mapping attached", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-transform-"));
    writeFileSync(join(tempDir, "package.json"), "{}", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function schemaFixture(dir: string): void {
    write(
      dir,
      "src/accounts.ts",
      [
        "import { z } from 'zod';",
        "",
        "export const AccountSchema = z.object({",
        "  id: z.string(),",
        "  email: z.string(),",
        "  password: z.string(),",
        "  internalNotes: z.string(),",
        "});",
        "",
        "// The shape that actually crosses the trust boundary.",
        "export const PublicAccount = AccountSchema.omit({",
        "  password: true,",
        "  internalNotes: true,",
        "});",
      ].join("\n")
    );
  }

  it("emits a derives_from edge with the mapped fields and the dropped ones", () => {
    schemaFixture(tempDir);
    const result = deriveModules(tempDir);

    const edge = result.edges.find((candidate) =>
      candidate.id.startsWith(
        "derives_from:datastructure:src/accounts.ts::PublicAccount->"
      )
    );

    expect(edge).toBeDefined();
    expect(edge?.kind).toBe("derives_from");
    const mapping = (edge as unknown as {
      mapping: { fields: Array<{ from: string; to: string }>; dropped: string[]; unmapped: string[] };
    }).mapping;

    expect(mapping.fields.map((pair) => pair.from)).toEqual(["email", "id"]);
    expect(mapping.dropped).toEqual(["internalNotes", "password"]);
    expect(edge?.provenance.derived && edge.provenance.evidence).toEqual(["src/accounts.ts:11"]);
  });

  it("derives the projected shape itself, so the boundary is a node", () => {
    // Not just an edge. `PublicAccount` is a shape with fields, and a reader
    // asking "what crosses this boundary" needs to be able to open it.
    schemaFixture(tempDir);
    const result = deriveModules(tempDir);

    const node = result.nodes.find((n) => n.id === structureNodeId("src/accounts.ts", "PublicAccount"));
    const fields = (node as unknown as { fields: Array<{ name: string }> }).fields;

    expect(fields.map((field) => field.name)).toEqual(["id", "email"]);
  });

  it("reports a .pick() as the mapping it states", () => {
    write(
      tempDir,
      "src/pick.ts",
      [
        "import { z } from 'zod';",
        "export const FullSchema = z.object({",
        "  id: z.string(),",
        "  secret: z.string(),",
        "});",
        "export const SlimSchema = FullSchema.pick({ id: true });",
      ].join("\n")
    );

    const result = deriveModules(tempDir);
    const edge = result.edges.find((candidate) =>
      candidate.id.startsWith("derives_from:datastructure:src/pick.ts::SlimSchema->")
    );
    const mapping = (edge as unknown as { mapping: { fields: unknown[]; dropped: string[] } }).mapping;

    expect(mapping.fields).toEqual([{ from: "id", to: "id" }]);
    expect(mapping.dropped).toEqual(["secret"]);
  });

  it("emits nothing for a transformation it cannot observe", () => {
    // A `.transform(fn)` says "the output differs"; it does not say how. Emitting
    // an edge with an empty mapping would be a claim about a mapping nobody
    // wrote down, which is the confidently-wrong-structure failure the issue's
    // own risk section warns about.
    write(
      tempDir,
      "src/opaque.ts",
      [
        "import { z } from 'zod';",
        "export const InputSchema = z.object({ id: z.string(), secret: z.string() });",
        "export const OutputSchema = InputSchema.transform((raw) => ({ id: raw.id }));",
      ].join("\n")
    );

    const result = deriveModules(tempDir);

    expect(
      result.edges.some((edge) => edge.id.includes("OutputSchema") && edge.kind === "derives_from")
    ).toBe(false);
  });
});