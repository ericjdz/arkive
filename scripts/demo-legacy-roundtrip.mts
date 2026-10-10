/**
 * The 62066bc acceptance demo.
 *
 * Reads the real `arkive/legacy-architecture.json` — the document commit
 * 62066bc orphaned, 7 services / 4 decisions / 3 dataFlows — through the v1 ->
 * v2 read path, writes it, reads it again, and prints what survived.
 *
 * Run: `npx tsx scripts/demo-legacy-roundtrip.mts`
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readArchitecture,
  writeArchitecture,
  architecturePath,
  arkiveDirPath,
} from "../src/io/architecture-file.js";

const LEGACY = join(process.cwd(), "arkive", "legacy-architecture.json");

const dir = mkdtempSync(join(tmpdir(), "arkive-demo-"));
mkdirSync(arkiveDirPath(dir), { recursive: true });
copyFileSync(LEGACY, architecturePath(dir));

const v1 = JSON.parse(readFileSync(LEGACY, "utf-8"));

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

console.log("\nSOURCE  arkive/legacy-architecture.json  (schemaVersion absent => v1)");
line("services", v1.services.length);
line("connections", v1.connections.length);
line("decisions", v1.decisions.length);
line("dataFlows", v1.dataFlows.length);
line("history", v1.history.length);

console.log("\nSTEP 1  readArchitecture()  — no file is written");
const first = readArchitecture(dir);
if (!first.success) {
  console.error(first.error);
  process.exit(1);
}
line("result", "success");
line("in-memory schemaVersion", first.data.schemaVersion);
line("reported version", first.data.version);
line("nodes", first.data.nodes.length);
line("edges", first.data.edges.length);
line("services (projection)", first.data.services.length);
line("connections (projection)", first.data.connections.length);
line("decisions", first.data.decisions.length);
line("dataFlows", first.data.dataFlows.length);
line("history", first.data.history.length);
line("on disk still v1?", !("schemaVersion" in JSON.parse(readFileSync(architecturePath(dir), "utf-8"))));

console.log("\nSTEP 2  writeArchitecture()  — the migration persists here, and only here");
const wrote = writeArchitecture(dir, first.data);
if (!wrote.success) {
  console.error(wrote.error);
  process.exit(1);
}
const onDisk = JSON.parse(readFileSync(architecturePath(dir), "utf-8"));
line("result", "success");
line("on-disk schemaVersion", onDisk.schemaVersion);
line("on-disk `version` key", "version" in onDisk ? "present" : "absent (replaced)");

console.log("\nSTEP 3  readArchitecture() again");
const second = readArchitecture(dir);
if (!second.success) {
  console.error(second.error);
  process.exit(1);
}
line("result", "success");
line("reported version", second.data.version);
line("services", `${v1.services.length} -> ${second.data.services.length}`);
line("decisions", `${v1.decisions.length} -> ${second.data.decisions.length}`);
line("dataFlows", `${v1.dataFlows.length} -> ${second.data.dataFlows.length}`);
line("history", `${v1.history.length} -> ${second.data.history.length}`);
line("connections", `${v1.connections.length} -> ${second.data.connections.length}`);

const before = v1.decisions.flatMap((d: { alternatives: unknown[] }) => d.alternatives);
const after = second.data.decisions.flatMap((d) => d.alternatives);
line("rejected alternatives", `${before.length} -> ${after.length}`);
line("alternatives verbatim", JSON.stringify(before) === JSON.stringify(after));

console.log("\nDECISIONS SURVIVING, with every `whyNot`:");
for (const decision of second.data.decisions) {
  console.log(`  ${decision.id}  ${decision.topic}`);
  for (const alternative of decision.alternatives) {
    console.log(`      rejected: ${alternative.name}`);
    console.log(`      because:  ${alternative.whyNot}`);
  }
}

console.log("\nSERVICES SURVIVING:");
for (const service of second.data.services) {
  const node = second.data.nodes.find((n) => n.id === service.id);
  console.log(
    `  ${service.id.padEnd(12)} kind=${(node?.kind ?? "?").padEnd(10)} ` +
      `tech=${(node?.tech ?? "-").padEnd(30)} deps=[${service.dependencies.join(", ")}]`
  );
}

console.log("\nDATAFLOWS SURVIVING:");
for (const flow of second.data.dataFlows) {
  console.log(`  ${flow.name} (${flow.steps.length} steps)`);
}

rmSync(dir, { recursive: true, force: true });
console.log("");