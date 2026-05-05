#!/usr/bin/env node
import { execSync } from "node:child_process";
import { rmSync, existsSync, mkdirSync, cpSync } from "node:fs";
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
rmSync(resolve(ROOT, "src/viewer/dist"), { recursive: true, force: true });

console.log("==> Building CLI + server + library (tsup)");
run("npx tsup");

if (existsSync(resolve(ROOT, "src/viewer/vite.config.ts"))) {
  console.log("==> Building viewer (Vite)");
  run("npx vite build --config src/viewer/vite.config.ts");
} else {
  console.log("==> Skipping viewer (vite.config.ts not present)");
}

const viewerDist = resolve(ROOT, "src/viewer/dist");
if (existsSync(viewerDist)) {
  console.log("==> Copying viewer dist into package dist");
  const target = resolve(ROOT, "dist/viewer");
  mkdirSync(target, { recursive: true });
  cpSync(viewerDist, target, { recursive: true });
}

console.log("==> Build complete");
