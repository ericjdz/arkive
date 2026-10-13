#!/usr/bin/env node
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function run(cmd) {
  console.log(`==> ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

console.log("==> Cleaning previous build");
rmSync(resolve(ROOT, "dist"), { recursive: true, force: true });

console.log("==> Building CLI + server + library (tsup)");
run("npx tsup");

console.log("==> Build complete");
