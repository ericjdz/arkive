/**
 * DEMO 3 — a human-verified node whose technology vanishes from package.json
 *           raises `critical` and names the node.
 *
 * Run: npx tsx demo/0007-d3-4-authored-drift-and-orphan.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { architecturePath, readArchitecture, writeArchitecture } from "../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../src/schema/validate-graph.js";
import { reconcileOnce, describeOutcome } from "../src/analysis/watch.js";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "arkive-d3-"));
const w = (rel: string, c: string) => {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, c, "utf-8");
};

/** Run the real CLI, because the claim is made by the command's output. */
function cli(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
       join(process.cwd(), "src", "cli", "index.ts"), ...args],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

w("package.json", JSON.stringify({ dependencies: { express: "^4.0.0", pg: "^8.0.0" } }));
w("src/api.ts", `import express from "express";\nexport const api = express();\n`);
w("src/db.ts", `import { Client } from "pg";\nexport const client = new Client();\n`);
w("src/cache.ts", `import { createClient } from "redis";\nexport const cache = createClient();\n`);

const arch = createEmptyArchitectureV2("d3", "Authored drift demo");
arch.nodes.push({
  id: "datastore:primary",
  kind: "datastore",
  name: "Primary datastore",
  summary: "Postgres 15, chosen because the idempotency keys have to be transactional.",
  tech: "pg",
  provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-02-01T00:00:00.000Z" },
});
arch.nodes.push({
  id: "datastore:cache",
  kind: "datastore",
  name: "Session cache",
  summary: "Redis. A human reviewed this on the day it was added.",
  tech: "redis",
  provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-02-01T00:00:00.000Z" },
});
if (!writeArchitecture(dir, arch).success) throw new Error("scaffold failed");

console.log("================================================================");
console.log("DEMO 3 — the technology disappears from package.json");
console.log("================================================================");
console.log("");
console.log("package.json before:");
console.log("  " + readFileSync(join(dir, "package.json"), "utf-8").trim());
console.log("");

// The human removed redis from the manifest and the import with it.
w("package.json", JSON.stringify({ dependencies: { express: "^4.0.0", pg: "^8.0.0" } }));
unlinkSync(join(dir, "src", "cache.ts"));
console.log("redis removed from package.json and its last import deleted.");
console.log("");

const drift = cli(["reconcile", "--dir", dir, "--no-graph"]);
console.log("--- `arkive reconcile --dir <project>` ---");
console.log(drift.output.split("\n").slice(0, 14).join("\n"));
console.log(`  ...`);
console.log(`  exit code: ${drift.status}`);

const f = reconcileOnce(dir, { apply: false });
if (f.status !== "reconciled") throw new Error("status");
const critical = f.findings.find((x) => x.kind === "authored-unsupported");
console.log("");
console.log("  finding.severity   : " + critical?.severity);
console.log("  finding.subject    : " + critical?.subject + "   <- names the node");
console.log("  finding.humanVerified: " + critical?.humanVerified);

console.log("");
console.log("================================================================");
console.log("DEMO 4 — a human-verified node derivation no longer produces");
console.log("================================================================");
console.log("");
console.log("A human authored `module:src/cache.ts` with a summary, then the file");
console.log("was deleted. Derivation cannot corroborate it any more.");
console.log("");

// Author a module node for the file, then delete the file.
w("src/cache.ts", `export const cache = 1;\n`);
const read = readArchitecture(dir);
if (!read.success) throw new Error(read.error);
read.data.nodes.push({
  id: "module:src/cache.ts",
  kind: "module",
  name: "cache.ts",
  summary: "Session cache wiring. Owned by the platform team, do not move.",
  path: "src/cache.ts",
  provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-03-01T00:00:00.000Z" },
});
const payload: Record<string, unknown> = { ...(read.data as unknown as Record<string, unknown>), schemaVersion: 2 };
delete payload.services; delete payload.connections; delete payload.version; delete payload.warnings;
if (!writeArchitecture(dir, payload as never).success) throw new Error("write failed");

reconcileOnce(dir, { apply: true }); // settle the derived half
unlinkSync(join(dir, "src", "cache.ts"));

const orphanRun = reconcileOnce(dir, { apply: true });
if (orphanRun.status !== "reconciled") throw new Error("status");
console.log("--- `arkive watch` cycle output ---");
console.log(describeOutcome(orphanRun, true));
console.log("");

const after = readArchitecture(dir);
if (!after.success) throw new Error(after.error);
const node = after.data.nodes.find((n) => n.id === "module:src/cache.ts");
console.log("--- the node as it stands on disk ---");
console.log(`  still present: ${node !== undefined}`);
console.log(`  tombstoned (deletedAt): ${node?.deletedAt ?? "undefined  <- NOT deleted"}`);
console.log(`  summary: "${node?.summary}"`);
console.log(`  provenance: ${JSON.stringify(node?.provenance)}`);
console.log("");
console.log(`  file still readable at ${architecturePath(dir)}: yes`);

rmSync(dir, { recursive: true, force: true });