/**
 * DEMO 1 — an authored node survives 100 reconcile cycles unchanged.
 * Run: npx tsx demo/0007-d1-durability.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../src/schema/validate-graph.js";
import { reconcileOnce, describeOutcome } from "../src/analysis/watch.js";

const dir = mkdtempSync(join(tmpdir(), "arkive-d1-"));
const w = (rel: string, c: string) => {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, c, "utf-8");
};

w("package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
w("src/a.ts", `import express from "express";\nexport const a = 1;\n`);
w("src/b.ts", `export const b = 2;\n`);

const arch = createEmptyArchitectureV2("d1", "Durability demo");
arch.nodes.push({
  id: "svc:payments",
  kind: "service",
  name: "Payments",
  summary: "Chosen over Stripe Checkout because we need idempotency keys we control.",
  tech: "express",
  owner: "payments-team",
  provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
});
if (!writeArchitecture(dir, arch).success) throw new Error("scaffold failed");

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const nodeHash = (): string => {
  const read = readArchitecture(dir);
  if (!read.success) throw new Error(read.error);
  return sha(JSON.stringify(read.data.nodes.find((n) => n.id === "svc:payments")));
};

console.log("Project: " + dir);
console.log("");
console.log("--- cycle 1: persist the derived half ---");
const first = reconcileOnce(dir, { apply: true });
if (first.status !== "reconciled") throw new Error("status");
console.log(describeOutcome(first, true));
console.log(`  written: ${first.written}`);

const fileBefore = readFileSync(architecturePath(dir), "utf-8");
const nodeBefore = nodeHash();
console.log("");
console.log("--- cycles 2..101: the derived half is already current ---");
console.log(`  authored node sha256 (before): ${nodeBefore}`);
console.log(`  document sha256   (before): ${sha(fileBefore)}`);

let writes = 0;
for (let i = 2; i <= 101; i += 1) {
  const r = reconcileOnce(dir, { apply: true });
  if (r.status !== "reconciled") throw new Error("status");
  if (r.written) writes += 1;
}
const fileAfter = readFileSync(architecturePath(dir), "utf-8");

console.log(`  cycles that wrote a change: ${writes} of 100`);
console.log(`  authored node sha256 (after):  ${nodeHash()}`);
console.log(`  document   sha256 (after):     ${sha(fileAfter)}`);
console.log("");
console.log(`  authored node unchanged: ${nodeHash() === nodeBefore}`);
console.log(`  document byte-identical: ${sha(fileAfter) === sha(fileBefore)}`);

const read = readArchitecture(dir);
if (!read.success) throw new Error(read.error);
console.log("");
console.log("  authored node as it stands on disk after 101 cycles:");
console.log("   " + JSON.stringify(read.data.nodes.find((n) => n.id === "svc:payments")));
console.log(`  derived nodes persisted alongside it: ${read.data.nodes.filter((n) => n.provenance.derived).length}`);

rmSync(dir, { recursive: true, force: true });