import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules } from "../../../src/analysis/derive.js";
import { describeCoupling, structureNodeId } from "../../../src/analysis/structures/derive.js";
import { sourceLiterals, secretFixture } from "./redaction-fixture.js";

/**
 * The three demonstrations the issue report claims, run for real.
 *
 * Not a test. `vitest` would re-assert what the test files already assert; this
 * exists so the numbers in the report are observed on this machine rather than
 * asserted on paper.
 */

const dir = mkdtempSync(join(tmpdir(), "arkive-demo-"));
const write = (rel: string, body: string): void => {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf-8");
};
writeFileSync(join(dir, "package.json"), "{}", "utf-8");

// --- 1. a shared shape, three writers, two readers --------------------------
write("src/invoice.ts", "export interface Invoice {\n  id: string;\n  totalCents: number;\n}\n");
write("src/checkout.ts", "import type { Invoice } from './invoice.js';\nexport const draft: Invoice = { id: 'x', totalCents: 0 };\n");
write("src/billing.ts", "import type { Invoice } from './invoice.js';\nexport function make(id: string): Invoice {\n  return { id, totalCents: 100 };\n}\n");
write("src/import.ts", "import type { Invoice } from './invoice.js';\nimport { z } from 'zod';\nconst S = z.object({ id: z.string() });\nexport function load(raw: unknown): Invoice {\n  return { id: S.parse(raw).id, totalCents: 0 };\n}\n");
write("src/email.ts", "import type { Invoice } from './invoice.js';\nexport function send(invoice: Invoice): string { return invoice.id; }\n");
write("src/report.ts", "import type { Invoice } from './invoice.js';\nexport function count(all: Invoice[]): number { return all.length; }\n");

const coupling = deriveModules(dir);
const shapeId = structureNodeId("src/invoice.ts", "Invoice");

console.log("=== 1. coupling surface: one shape, five modules ===");
console.log(JSON.stringify(describeCoupling(coupling, shapeId), null, 2));
for (const edge of coupling.edges.filter((e) => e.to === shapeId && e.kind !== "derives_from")) {
  const evidence = edge.provenance.derived ? edge.provenance.evidence : [];
  console.log(
    `  ${edge.kind.padEnd(6)} ${edge.from.padEnd(26)} ${String(edge.note).padEnd(48)} ${JSON.stringify(evidence)}`
  );
}

// --- 2. a mapping written down ----------------------------------------------
write("src/accounts.ts", [
  "import { z } from 'zod';",
  "export const AccountSchema = z.object({",
  "  id: z.string(),",
  "  email: z.string(),",
  "  password: z.string().default('hunter2-correct-horse'),",
  "  internalNotes: z.string(),",
  "});",
  "export const PublicAccount = AccountSchema.omit({",
  "  password: true,",
  "  internalNotes: true,",
  "});",
].join("\n"));

const mapped = deriveModules(dir);
console.log("\n=== 2. transformation, with the mapping attached ===");
for (const edge of mapped.edges.filter((e) => e.kind === "derives_from" && e.from.startsWith("datastructure:"))) {
  console.log(`  ${edge.id}`);
  console.log(`    ${edge.note}`);
  console.log(`    evidence ${JSON.stringify(edge.provenance.derived ? edge.provenance.evidence : [])}`);
  console.log(`    mapping  ${JSON.stringify((edge as unknown as Record<string, unknown>).mapping)}`);
}

// --- 3. redaction ------------------------------------------------------------
const secretDir = mkdtempSync(join(tmpdir(), "arkive-secrets-"));
writeFileSync(join(secretDir, "package.json"), "{}", "utf-8");
secretFixture(secretDir);

const redacted = deriveModules(secretDir);
const serialised = JSON.stringify({ nodes: redacted.nodes, edges: redacted.edges });
const literals = sourceLiterals(secretDir);
const leaked = literals.filter((literal) => serialised.includes(literal));

console.log("\n=== 3. redaction ===");
console.log(`string literals in the fixture: ${literals.length}`);
console.log(`surviving in the derived graph: ${leaked.length} ${JSON.stringify(leaked)}`);
const account = redacted.nodes.find((n) => n.id.endsWith("::AccountSchema"));
const fields = (account as unknown as { fields: Array<Record<string, unknown>> }).fields;
console.log("AccountSchema, as recorded:");
for (const field of fields) {
  console.log(
    `  ${String(field.name).padEnd(14)} : ${String(field.type).padEnd(7)} ` +
      `${field.optional ? "optional" : "required"}` +
      `${field.literals ? `  (${field.literals} literal(s) redacted)` : ""}`
  );
}

rmSync(dir, { recursive: true, force: true });
rmSync(secretDir, { recursive: true, force: true });