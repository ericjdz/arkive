import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { platform } from "node:os";

const SCRIPT = resolve(process.cwd(), "scripts/install.sh");

describe("scripts/install.sh", () => {
  it("exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("starts with a bash shebang", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content.split("\n")[0]).toMatch(/^#!\/usr\/bin\/env bash$/);
  });

  it("uses set -euo pipefail for safety", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toContain("set -euo pipefail");
  });

  it("checks for node and npm before proceeding", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toMatch(/command -v node/);
    expect(content).toMatch(/command -v (npm|npx)/);
  });

  it("invokes npx arkive init", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toMatch(/npx\s+(-y\s+)?arkive\s+init/);
  });

  it("supports a --dir argument forwarding to arkive init", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toMatch(/--dir/);
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
});
