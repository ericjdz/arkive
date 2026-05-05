import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PluginManifestSchema,
  MarketplaceManifestSchema,
} from "../../src/manifests/validate.js";

const readJson = (rel: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf-8"));

describe("Claude Code plugin manifests", () => {
  it("plugin.json is valid JSON", () => {
    expect(() => readJson(".claude-plugin/plugin.json")).not.toThrow();
  });

  it("plugin.json conforms to schema", () => {
    const data = readJson(".claude-plugin/plugin.json");
    const result = PluginManifestSchema.safeParse(data);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it("plugin.json declares required fields", () => {
    const data = readJson(".claude-plugin/plugin.json");
    expect(data.name).toBe("arkive");
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(data.description).toBeTruthy();
    expect(data.author).toBeTruthy();
  });

  it("plugin.json references existing skill paths", () => {
    const data = readJson(".claude-plugin/plugin.json");
    expect(Array.isArray(data.skills)).toBe(true);
    for (const skillPath of data.skills) {
      const fullPath = resolve(process.cwd(), skillPath);
      expect(() => readFileSync(fullPath, "utf-8")).not.toThrow();
    }
  });

  it("plugin.json declares the MCP server entry", () => {
    const data = readJson(".claude-plugin/plugin.json");
    expect(data.mcpServers).toBeDefined();
    expect(data.mcpServers.arkive).toBeDefined();
    expect(data.mcpServers.arkive.command).toBeTruthy();
  });

  it("marketplace.json is valid JSON", () => {
    expect(() => readJson(".claude-plugin/marketplace.json")).not.toThrow();
  });

  it("marketplace.json conforms to schema", () => {
    const data = readJson(".claude-plugin/marketplace.json");
    const result = MarketplaceManifestSchema.safeParse(data);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it("marketplace.json lists arkive as a plugin entry", () => {
    const data = readJson(".claude-plugin/marketplace.json");
    expect(Array.isArray(data.plugins)).toBe(true);
    const entry = data.plugins.find((p: { name: string }) => p.name === "arkive");
    expect(entry).toBeDefined();
    expect(entry.source).toBeTruthy();
  });
});
