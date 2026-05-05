import { describe, it, expect } from "vitest";
import { renderTemplate } from "../../src/templates/render.js";

describe("Template Rendering", () => {
  const context = {
    projectName: "my-app",
    architectureFile: "architecture.json",
  };

  it("renders CLAUDE.md template with project name", () => {
    const result = renderTemplate("CLAUDE.md.hbs", context);
    expect(result).toContain("my-app");
    expect(result).toContain("architecture.json");
    expect(result).toContain("Before any major change");
  });

  it("renders AGENTS.md template with project name", () => {
    const result = renderTemplate("AGENTS.md.hbs", context);
    expect(result).toContain("my-app");
    expect(result).toContain("architecture.json");
  });

  it("renders cursor rule template", () => {
    const result = renderTemplate("cursor-rule.mdc.hbs", context);
    expect(result).toContain("architecture.json");
    expect(result).toContain("alwaysApply: true");
  });
});
