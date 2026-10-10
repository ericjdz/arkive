import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";

const SCRIPT = resolve(process.cwd(), "scripts/install.sh");
const CONTENT = readFileSync(SCRIPT, "utf-8");

/**
 * The published package name.
 *
 * A `curl | bash` installer runs `npx -y <name>`, which resolves whatever
 * `<name>` points at on the public registry. `scripts/install.sh` used to run
 * `npx -y arkive init` — an unscoped name that is not this package. That is
 * dependency confusion on a code path where the user has already piped an
 * unverified script into a shell, and it is the exact hazard that arkive's
 * surface exists to create for *architectures*; creating it for the installer
 * would be indefensible.
 */
const PACKAGE_NAME = "@ericjdz/arkive";

describe("scripts/install.sh", () => {
  it("exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("starts with a bash shebang", () => {
    expect(CONTENT.split("\n")[0]).toMatch(/^#!\/usr\/bin\/env bash$/);
  });

  it("uses set -euo pipefail for safety", () => {
    expect(CONTENT).toContain("set -euo pipefail");
  });

  it("checks for node and npm before proceeding", () => {
    expect(CONTENT).toMatch(/command -v node/);
    expect(CONTENT).toMatch(/command -v (npm|npx)/);
  });

  it("declares the fully scoped package name", () => {
    expect(CONTENT).toMatch(new RegExp(`ARKIVE_PACKAGE="${PACKAGE_NAME}"`));
  });

  it("invokes the scoped package, never a bare name", () => {
    expect(CONTENT).toMatch(/npx -y "\$ARKIVE_PACKAGE" init/);
  });

  it("regression — never resolves an unscoped `arkive` package from npm", () => {
    // `npx -y arkive ...` or `npx -y @ericjdz/arkive@latest arkive ...`-style
    // typos are both dependency confusion. The scoped name is the only thing
    // that binds resolution to this project.
    expect(CONTENT).not.toMatch(/npx\s+(-y\s+)?arkive\b/);
    expect(CONTENT).not.toMatch(/npm\s+install\s+(-\S+\s+)*arkive\b/);
  });

  it("says why the scoped name matters, so it is not 'cleaned up' later", () => {
    expect(CONTENT).toMatch(/scoped name/i);
    expect(CONTENT).toMatch(/registry|takeover|typo/i);
  });

  it("supports a --dir argument forwarding to arkive init", () => {
    expect(CONTENT).toMatch(/--dir/);
  });

  it("supports --dry-run and forwards it to init", () => {
    expect(CONTENT).toMatch(/--dry-run/);
    expect(CONTENT).toMatch(/DRY_RUN=1/);
    expect(CONTENT).toMatch(/CMD\+=\(--dry-run\)/);
  });

  it("refuses to run when a document exists at the pre-migration path", () => {
    // Running init over an orphaned `architecture.json` is how commit 62066bc
    // destroyed four recorded decisions. The installer must not be a way in.
    expect(CONTENT).toMatch(/architecture\.json/);
    expect(CONTENT).toMatch(/Nothing has been written/);
  });

  it("passes shellcheck-style basic syntax (bash -n)", () => {
    if (platform() === "win32") return; // bash may not be available on Windows CI
    expect(() => execSync(`bash -n "${SCRIPT}"`)).not.toThrow();
  });

  it("dry-run prints help when --help is passed", () => {
    if (platform() === "win32") return;
    const tmp = mkdtempSync(join(tmpdir(), "arkive-install-"));
    try {
      const out = execSync(`bash "${SCRIPT}" --help`, {
        encoding: "utf-8",
        env: { ...process.env, ARCHLEARN_INSTALL_DRY_RUN: "1" },
      });
      expect(out.toLowerCase()).toContain("arkive");
      expect(out).toMatch(/--dir|usage/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--help documents the scoped package it will run", () => {
    if (platform() === "win32") return;
    const out = execSync(`bash "${SCRIPT}" --help`, { encoding: "utf-8" });
    expect(out).toContain(PACKAGE_NAME);
  });
});
