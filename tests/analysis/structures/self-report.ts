import { scanProject } from "../../../src/analysis/scanner.js";
import { deriveFromScan } from "../../../src/analysis/derive.js";
import { describeCoupling } from "../../../src/analysis/structures/derive.js";

/**
 * Run the derivation over this repository and print what it found, what it could
 * not, and the coverage number. Not a test — a measurement, so the numbers in the
 * issue report are observed rather than estimated.
 */
const scan = scanProject(process.cwd());
const result = deriveFromScan(scan);

const shapes = result.nodes.filter((node) => node.kind === "datastructure");
const reads = result.edges.filter((edge) => edge.kind === "reads");
const writes = result.edges.filter((edge) => edge.kind === "writes");
const transforms = result.edges.filter(
  (edge) => edge.kind === "derives_from" && edge.from.startsWith("datastructure:")
);

const coupled = shapes
  .map((node) => ({ node, coupling: describeCoupling(result, node.id) }))
  .filter((entry) => entry.coupling.modules > 0)
  .sort((a, b) => b.coupling.modules - a.coupling.modules);

console.log("== coverage ==");
console.log(`scan (imports):     ${(result.importCoverage * 100).toFixed(1)}%  (${scan.filesScanned} parsed, ${scan.filesUnreadable} unreadable, ${scan.filesTruncated} truncated)`);
console.log(`structures:         ${(result.structureCoverage * 100).toFixed(1)}%  (${result.structures.filesRead} read, ${result.structures.filesIncomplete} incomplete)`);
console.log(`headline:           ${(result.coverage * 100).toFixed(1)}%`);
console.log(`no structure extractor: ${JSON.stringify(result.structures.unsupported)}`);

console.log("\n== what it found ==");
console.log(`module nodes:   ${result.nodes.filter((n) => n.kind === "module").length}`);
console.log(`external nodes: ${result.nodes.filter((n) => n.kind === "external").length}`);
console.log(`shapes:         ${shapes.length}`);
console.log(`reads edges:    ${reads.length}`);
console.log(`writes edges:   ${writes.length}`);
console.log(`transform edges: ${transforms.length}`);
console.log(`by format:      ${JSON.stringify(result.structures.byFormat)}`);

console.log("\n== the top coupling points ==");
for (const entry of coupled.slice(0, 8)) {
  console.log(
    `  ${String(entry.coupling.modules).padStart(3)} modules  ` +
      `${entry.coupling.writes.length}w/${entry.coupling.reads.length}r  ${entry.node.id}`
  );
}

console.log("\n== what it could not ==");
console.log(`unresolved references: ${result.structures.unresolved.length}`);
console.log(`notes:`);
for (const note of result.notes) console.log(`  - ${note}`);