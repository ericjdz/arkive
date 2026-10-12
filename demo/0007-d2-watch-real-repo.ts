/**
 * DEMO 2 — `arkive watch` on THIS repository.
 *
 * Copies the repo's source into a scratch project so the tracked
 * arkive/architecture.json is not touched (issue 0014 owns that file), runs the
 * real `arkive watch` command against it, then adds a file and watches the delta.
 *
 * Run: npx tsx demo/0007-d2-watch-real-repo.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createEmptyArchitectureV2 } from "../src/schema/validate-graph.js";
import {
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../src/io/architecture-file.js";

const REPO = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "arkive-d2-"));

// The real source tree: 66 TypeScript modules plus the test suite.
cpSync(join(REPO, "src"), join(dir, "src"), {
  recursive: true,
  filter: (src) => !src.includes(`${"node_modules"}`),
});
cpSync(join(REPO, "tests"), join(dir, "tests"), { recursive: true });
cpSync(join(REPO, "package.json"), join(dir, "package.json"));
cpSync(join(REPO, "tsconfig.json"), join(dir, "tsconfig.json"));
if (existsSync(join(REPO, "arkive.config.json"))) {
  cpSync(join(REPO, "arkive.config.json"), join(dir, "arkive.config.json"));
}

if (!writeArchitecture(dir, createEmptyArchitectureV2("arkive", "arkive")).success) {
  throw new Error("scaffold failed");
}

const before = readArchitecture(dir);
if (!before.success) throw new Error(before.error);
console.log(`Source tree copied from ${REPO}`);
console.log(`Document before watch: ${before.data.nodes.length} node(s), ${before.data.edges.length} edge(s)`);
console.log("");

const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO, "src", "cli", "index.ts");

const child = spawn(process.execPath, [TSX, CLI, "watch", "--dir", dir, "--interval", "400"], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (c: Buffer) => (output += c.toString("utf-8")));
child.stderr.on("data", (c: Buffer) => (output += c.toString("utf-8")));

function waitFor(marker: RegExp, what: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (marker.test(output)) return resolve();
      if (Date.now() - started > timeoutMs) {
        child.kill();
        return reject(new Error(`timed out waiting for ${what}:\n${output}`));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

console.log("--- arkive watch, first cycle ---");
await waitFor(/^\d+ nodes? added/m, "the first persisted cycle");

const afterFirst = readArchitecture(dir);
if (!afterFirst.success) throw new Error(afterFirst.error);
const derived = afterFirst.data.nodes.filter((n) => n.provenance.derived);
console.log(`Document after the first cycle: ${afterFirst.data.nodes.length} node(s), ${afterFirst.data.edges.length} edge(s)`);
console.log(`  of which derived: ${derived.length} (${derived.filter((n) => n.kind === "module").length} module, ${derived.filter((n) => n.kind === "external").length} external)`);
console.log(`  file on disk: ${architecturePath(dir)}`);
console.log("");
console.log("--- add a file to the real source tree, watch the delta ---");
writeFileSync(
  join(dir, "src", "analysis", "issue-0007-demo.ts"),
  `import { scanProject } from "./scanner.js";\nexport const demo = scanProject(".");\n`,
  "utf-8"
);

await waitFor(/issue-0007-demo/, "the node for the new file");
child.kill("SIGINT");
await new Promise((r) => setTimeout(r, 500));

console.log("--- arkive watch output ---");
console.log(output.trim());

const final = readArchitecture(dir);
if (!final.success) throw new Error(final.error);
console.log("");
console.log("--- document on disk after watch ---");
console.log(`  nodes: ${final.data.nodes.length}  edges: ${final.data.edges.length}`);
console.log(
  `  new node present: ${final.data.nodes.some((n) => n.id === "module:src/analysis/issue-0007-demo.ts")}`
);
const sample = final.data.nodes.find((n) => n.id === "module:src/analysis/derive.ts");
console.log(`  sample derived node with its evidence:`);
console.log(`   ${JSON.stringify(sample)}`);

rmSync(dir, { recursive: true, force: true });