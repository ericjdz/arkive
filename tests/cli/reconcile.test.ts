import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(process.cwd(), "dist/cli/index.js");

describe("reconcile command", () => {
  it("is registered in the CLI", () => {
    const help = execSync(`node "${CLI}" --help`, { encoding: "utf8" });
    expect(help).toContain("reconcile");
  });

  it("shows help with --dir option", () => {
    const help = execSync(`node "${CLI}" reconcile --help`, { encoding: "utf8" });
    expect(help).toContain("--dir");
    expect(help).toContain("Detect drift");
  });
});
