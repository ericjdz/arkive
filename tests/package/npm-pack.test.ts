import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tarball: string | null = null;
let tempDir: string;

beforeAll(() => {
  // Build first so dist/ is fresh
  execSync("npx tsup", { stdio: "inherit" });

  // npm pack into a tmp dir
  tempDir = mkdtempSync(join(tmpdir(), "arkive-pack-"));
  const out = execSync(`npm pack --pack-destination "${tempDir}"`, {
    encoding: "utf-8",
  });
  const last = out.trim().split("\n").pop()!;
  tarball = join(tempDir, last);
}, 120_000);

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("npm pack + install + bin invocation", () => {
  it("produces a tarball", () => {
    expect(tarball).toBeTruthy();
    expect(existsSync(tarball!)).toBe(true);
  });

  it("tarball includes required distribution files", () => {
    const list = execSync(`npm pack --dry-run --json`, { encoding: "utf-8" });
    const parsed = JSON.parse(list);
    const files: string[] = parsed[0].files.map((f: { path: string }) => f.path);

    const required = [
      "package.json",
      "README.md",
      "LICENSE",
      "CLAUDE.md",
      "AGENTS.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "dist/cli/index.js",
      "skills/core/architecture-tracker/SKILL.md",
    ];
    for (const r of required) {
      expect(files, `tarball should include ${r}`).toContain(r);
    }
  });

  it("installs and exposes the arkive bin", () => {
    const installDir = mkdtempSync(join(tmpdir(), "arkive-install-"));
    try {
      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "arkive-install-test", version: "0.0.0" }),
        "utf-8"
      );

      execSync(`npm install --no-save "${tarball}"`, {
        cwd: installDir,
        stdio: "inherit",
      });

      const binPath = join(installDir, "node_modules", ".bin", "arkive");
      const binPathWin = binPath + ".cmd";
      expect(existsSync(binPath) || existsSync(binPathWin)).toBe(true);

      // Invoke --help
      const helpOut = execSync(`node node_modules/@ericjdz/arkive/dist/cli/index.js --help`, {
        cwd: installDir,
        encoding: "utf-8",
      });
      expect(helpOut).toContain("arkive");
      expect(helpOut).toContain("init");
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("installed package can scaffold a project via init", () => {
    const installDir = mkdtempSync(join(tmpdir(), "arkive-init-from-pack-"));
    const projectDir = mkdtempSync(join(tmpdir(), "arkive-project-"));
    try {
      writeFileSync(
        join(installDir, "package.json"),
        JSON.stringify({ name: "host", version: "0.0.0" }),
        "utf-8"
      );
      execSync(`npm install --no-save "${tarball}"`, {
        cwd: installDir,
        stdio: "inherit",
      });

      execSync(
        `node node_modules/@ericjdz/arkive/dist/cli/index.js init --name pack-test --dir "${projectDir}"`,
        { cwd: installDir, stdio: "inherit" }
      );

      expect(existsSync(join(projectDir, "architecture.json"))).toBe(true);
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
      expect(
        existsSync(join(projectDir, ".cursor", "rules", "architecture-tracker.mdc"))
      ).toBe(true);

      const arch = JSON.parse(
        readFileSync(join(projectDir, "architecture.json"), "utf-8")
      );
      expect(arch.project.name).toBe("pack-test");
    } finally {
      rmSync(installDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120_000);
});
