import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf-8")
);

describe("package.json metadata", () => {
  it("has a name", () => {
    expect(pkg.name).toBe("@ericjdz/arkive");
  });

  it("has a semver version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("has a description mentioning architecture and AI", () => {
    expect(pkg.description).toBeTruthy();
    expect(pkg.description.toLowerCase()).toContain("architecture");
    expect(pkg.description.toLowerCase()).toMatch(/ai|agent/);
  });

  it("declares MIT license", () => {
    expect(pkg.license).toBe("MIT");
  });

  it("has author and repository fields", () => {
    expect(pkg.author).toBeTruthy();
    expect(pkg.repository).toBeTruthy();
    expect(pkg.repository.type).toBe("git");
    expect(pkg.repository.url).toMatch(/^(git\+)?https?:\/\//);
  });

  it("has homepage and bugs URLs", () => {
    expect(pkg.homepage).toMatch(/^https?:\/\//);
    expect(pkg.bugs.url).toMatch(/^https?:\/\//);
  });

  it("declares relevant keywords", () => {
    expect(pkg.keywords).toEqual(
      expect.arrayContaining([
        "architecture",
        "ai",
        "mcp",
        "claude-code",
        "cursor",
        "documentation",
      ])
    );
  });

  it("exposes arkive bin pointing to compiled CLI", () => {
    expect(pkg.bin).toEqual({ arkive: "./dist/cli/index.js" });
  });

  it("declares ESM module type", () => {
    expect(pkg.type).toBe("module");
  });

  it("declares engines.node >=18", () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toMatch(/>=\s*18/);
  });

  it("includes dist, skills, src/templates, .claude-plugin in published files", () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "dist",
        "skills",
        "src/templates",
        ".claude-plugin",
        "CLAUDE.md",
        "AGENTS.md",
        "LICENSE",
        "README.md",
      ])
    );
  });

  it("exposes public exports map", () => {
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["./schema"]).toBeDefined();
  });

  it("has build, test, lint, prepublishOnly scripts", () => {
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.test).toBeTruthy();
    expect(pkg.scripts.lint).toBeTruthy();
    expect(pkg.scripts.prepublishOnly).toBeTruthy();
  });
});
