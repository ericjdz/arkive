import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read the authoritative version from package.json at runtime.
 *
 * Hardcoding a copy of the version string is how `arkive --version` came to
 * report 0.1.6, the MCP server 0.1.0, and the plugin manifests 0.2.1 — five
 * disagreeing values with no compiler or test to catch the drift. package.json
 * is the single source of truth, so it is read rather than duplicated.
 *
 * tsup bundles this module, so `import.meta.url` points at the bundle
 * (dist/cli/index.js, dist/server/index.js), not at src/. The candidate list
 * therefore covers both the source tree (used by tests) and the published
 * layout. The `name` check stops a nested package.json — e.g. the separate
 * src/viewer/ package — from being picked up by mistake.
 */
function readVersionFromPackageJson(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // Source tree: src/version.ts -> repo root
    resolve(here, "..", "package.json"),
    // Bundled output: dist/cli/index.js or dist/server/index.js -> package root
    resolve(here, "..", "..", "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === "@ericjdz/arkive" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Not this one; try the next candidate.
    }
  }

  return null;
}

/** The published package version, sourced from package.json. */
export const PACKAGE_VERSION: string = readVersionFromPackageJson() ?? "unknown";