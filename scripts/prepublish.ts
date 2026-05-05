#!/usr/bin/env tsx
/**
 * Pre-publish validation. Fails the build if anything required for distribution
 * is missing or malformed. Run by `npm run prepublishOnly`.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  PluginManifestSchema,
  MarketplaceManifestSchema,
} from "../src/manifests/validate.js";

const ROOT = resolve(process.cwd());
const errors: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function fileExists(rel: string): boolean {
  return existsSync(resolve(ROOT, rel));
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf-8"));
}

console.log("==> arkive prepublish validation");

// 1. Required files exist
const requiredFiles = [
  "package.json",
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "dist/cli/index.js",
];
for (const f of requiredFiles) {
  check(fileExists(f), `Missing required file: ${f}`);
}

// 2. Built CLI has shebang and is non-empty
if (fileExists("dist/cli/index.js")) {
  const cli = readFileSync(resolve(ROOT, "dist/cli/index.js"), "utf-8");
  check(cli.startsWith("#!"), "dist/cli/index.js must start with a shebang");
  check(
    statSync(resolve(ROOT, "dist/cli/index.js")).size > 100,
    "dist/cli/index.js is suspiciously small"
  );
}

// 3. package.json sanity
const pkg = readJson("package.json") as Record<string, unknown> & {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  files?: string[];
};
check(pkg.name === "arkive", "package.json name must be 'arkive'");
check(typeof pkg.version === "string", "package.json must declare a version");
check(
  pkg.bin?.arkive === "./dist/cli/index.js",
  "package.json bin.arkive must point to ./dist/cli/index.js"
);
check(Array.isArray(pkg.files), "package.json must declare a 'files' array");

// 4. Manifests parse against their schemas
try {
  const plugin = readJson(".claude-plugin/plugin.json");
  const result = PluginManifestSchema.safeParse(plugin);
  if (!result.success) {
    errors.push(
      `plugin.json invalid: ${result.error.issues.map((i) => i.message).join("; ")}`
    );
  } else {
    check(
      result.data.version === pkg.version,
      `plugin.json version (${result.data.version}) must match package.json version (${pkg.version})`
    );
    for (const skillPath of result.data.skills) {
      check(fileExists(skillPath), `plugin.json references missing skill: ${skillPath}`);
    }
  }
} catch (e) {
  errors.push(`Failed to parse plugin.json: ${(e as Error).message}`);
}

try {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const result = MarketplaceManifestSchema.safeParse(marketplace);
  if (!result.success) {
    errors.push(
      `marketplace.json invalid: ${result.error.issues.map((i) => i.message).join("; ")}`
    );
  }
} catch (e) {
  errors.push(`Failed to parse marketplace.json: ${(e as Error).message}`);
}

// 5. Skills directory has at least the core skills
const requiredSkills = [
  "skills/core/setup/SKILL.md",
  "skills/core/architecture-tracker/SKILL.md",
  "skills/maintenance/reconciliation/SKILL.md",
];
for (const s of requiredSkills) {
  check(fileExists(s), `Missing required skill file: ${s}`);
}

// Report
if (errors.length > 0) {
  console.error("\nPrepublish validation FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("==> Prepublish validation passed.");
