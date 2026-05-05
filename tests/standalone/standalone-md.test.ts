import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf-8");

describe("Standalone CLAUDE.md (try-before-install)", () => {
  it("exists at repo root", () => {
    expect(existsSync(resolve(process.cwd(), "CLAUDE.md"))).toBe(true);
  });

  it("instructs the agent to read architecture.json before changes", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/before.*(major|any).*change/i);
    expect(content).toContain("architecture.json");
  });

  it("instructs the agent to update architecture.json after changes", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/after.*(major|any).*change/i);
  });

  it("instructs the agent to read architecture.json on session start", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/(session start|on every session|first thing)/i);
  });

  it("describes how to bootstrap architecture.json without the CLI", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/services|connections|decisions/i);
    expect(content).toMatch(/create|scaffold|bootstrap/i);
  });

  it("mentions the upgrade path to the full package", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/npx archlearn|full (package|experience)|upgrade/i);
  });
});

describe("Standalone AGENTS.md (try-before-install)", () => {
  it("exists at repo root", () => {
    expect(existsSync(resolve(process.cwd(), "AGENTS.md"))).toBe(true);
  });

  it("instructs the agent to maintain architecture.json", () => {
    const content = read("AGENTS.md");
    expect(content).toContain("architecture.json");
    expect(content).toMatch(/before.*change/i);
    expect(content).toMatch(/after.*change/i);
  });

  it("describes the schema enough to bootstrap without the CLI", () => {
    const content = read("AGENTS.md");
    expect(content).toMatch(/services|connections|decisions/i);
  });

  it("mentions the upgrade path", () => {
    const content = read("AGENTS.md");
    expect(content).toMatch(/npx archlearn|full (package|experience)|upgrade/i);
  });
});
