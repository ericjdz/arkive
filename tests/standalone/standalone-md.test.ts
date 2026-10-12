import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf-8");

/**
 * The root `AGENTS.md` and `CLAUDE.md` are the try-before-install surface: a
 * user drops one into their repo with no install, and their agent is trained by
 * whatever is on disk. Until issue 0019 they carried the v1 scaffold
 * (`"version": "1.0.0"`, `services[]`, `connections[]`, `relatedServices`), so
 * a no-install user got an agent that hard-errors on its first write.
 *
 * These assertions are the regression net for that.
 */

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
    expect(content).toMatch(/session start|on every session|first thing/i);
  });

  it("describes how to bootstrap architecture.json without the CLI", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/nodes|edges|decisions/i);
    expect(content).toMatch(/create|scaffold|bootstrap/i);
  });

  it("mentions the upgrade path to the full package", () => {
    const content = read("CLAUDE.md");
    expect(content).toMatch(/npx @ericjdz\/arkive|full (package|experience)|upgrade/i);
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
    expect(content).toMatch(/nodes|edges|decisions/i);
  });

  it("mentions the upgrade path", () => {
    const content = read("AGENTS.md");
    expect(content).toMatch(/npx @ericjdz\/arkive|full (package|experience)|upgrade/i);
  });
});

describe("Root instruction files teach the v2 document", () => {
  const files = ["AGENTS.md", "CLAUDE.md"];

  it.each(files)("%s scaffolds schemaVersion 2, not version 1.0.0", (file) => {
    const content = read(file);
    expect(content).toContain('"schemaVersion": 2');
    expect(content).not.toMatch(/["']version["']\s*:\s*["']1\.0\.0["']/);
  });

  it.each(files)("%s teaches nodes/edges, not services/connections", (file) => {
    const content = read(file);
    expect(content).toContain("nodes");
    expect(content).toContain("edges");
  });

  it.each(files)("%s teaches subjects, not relatedServices", (file) => {
    const content = read(file);
    expect(content).toContain("subjects");
    expect(content).not.toMatch(/["']relatedServices["']\s*:/);
  });

  it.each(files)("%s teaches provenance and says confidence is gone", (file) => {
    const content = read(file);
    expect(content).toContain("derived");
    expect(content).toContain("authoredBy");
    expect(content).toContain("evidence");
    // The word may appear only to explain the deletion and why.
    expect(content).not.toMatch(/["']confidence["']\s*:\s*[\d.]/);
  });

  it.each(files)("%s states structure is derived and you author intent", (file) => {
    const content = read(file);
    expect(content).toMatch(/structure is derived/i);
    expect(content).toMatch(/author intent/i);
    expect(content).toContain("reconcile");
  });

  it.each(files)("%s never tells the agent to trust the document", (file) => {
    const content = read(file).toLowerCase();
    expect(content).not.toContain("trust the document");
    expect(content).not.toMatch(/do not re-derive the architecture from code if/i);
  });
});

/**
 * The whole shipped skill surface, walked rather than listed, so a new skill
 * directory is covered the day it is added instead of the day someone
 * remembers to assert on it.
 */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectMarkdown(path));
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("Every shipped skill teaches the v2 document", () => {
  const skills = collectMarkdown(resolve(process.cwd(), "skills"));

  it("finds the skill surface (guards against a bad glob)", () => {
    expect(skills.length).toBeGreaterThan(5);
  });

  it.each(skills.map((p) => [p, readFileSync(p, "utf-8")]))(
    "%s has no field-to-write for confidence",
    (_path, content) => {
      expect(content).not.toMatch(/["']confidence["']\s*:\s*[\d.]/);
      expect(content).not.toMatch(/set\s+["']?confidence["']?\s+to/i);
    }
  );

  it.each(skills.map((p) => [p, readFileSync(p, "utf-8")]))(
    "%s has no relatedServices JSON example",
    (_path, content) => {
      expect(content).not.toMatch(/["']relatedServices["']\s*:/);
    }
  );

  it.each(skills.map((p) => [p, readFileSync(p, "utf-8")]))(
    "%s has no v1 service type taxonomy",
    (_path, content) => {
      expect(content).not.toMatch(
        /frontend\s*\|\s*backend\s*\|\s*database\s*\|\s*cache/
      );
    }
  );

  it.each(skills.map((p) => [p, readFileSync(p, "utf-8")]))(
    "%s never says trust the document",
    (_path, content) => {
      expect(content.toLowerCase()).not.toContain("trust the document");
      expect(content).not.toMatch(
        /do not re-derive the architecture from code if/i
      );
    }
  );

  it.each(skills.map((p) => [p, readFileSync(p, "utf-8")]))(
    "%s has no v1 version string as a field to write",
    (_path, content) => {
      expect(content).not.toMatch(/["']version["']\s*:\s*["']1\.0\.0["']/);
    }
  );
});