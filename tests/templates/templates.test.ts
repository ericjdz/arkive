import { describe, it, expect } from "vitest";
import { renderTemplate } from "../../src/templates/render.js";

/**
 * The rendered templates are what every installed agent is trained on.
 *
 * Issue 0019: they were still teaching the v1 document — `services`,
 * `connections`, `relatedServices`, `confidence`, and a `version: "1.0.0"`
 * scaffold — after `schemaVersion: 2` had replaced all of it. These are the
 * assertions that hold that reversal in place. A regression here does not
 * throw at runtime; it ships an agent that writes fields the parser refuses,
 * which is the failure every already-installed agent hit mid-session.
 */
const RENDERED = {
  "CLAUDE.md.hbs": renderTemplate("CLAUDE.md.hbs", {
    projectName: "my-app",
    architectureFile: "arkive/architecture.json",
  }),
  "AGENTS.md.hbs": renderTemplate("AGENTS.md.hbs", {
    projectName: "my-app",
    architectureFile: "arkive/architecture.json",
  }),
  "cursor-rule.mdc.hbs": renderTemplate("cursor-rule.mdc.hbs", {
    projectName: "my-app",
    architectureFile: "arkive/architecture.json",
  }),
  "arkive-block.md.hbs": renderTemplate("arkive-block.md.hbs", {
    projectName: "my-app",
    architectureFile: "arkive/architecture.json",
  }),
};

const ALL = Object.entries(RENDERED);

/**
 * The two full instruction files carry the schema. The block and the Cursor
 * rule are injected into a file the user already owns, so they carry the rule
 * and the traps — enough that an agent reading only those does not write a
 * field the parser refuses. Asserting the full six-kind enum on a 25-line
 * injected block would push the schema into prose it has no room for.
 */
const FULL_INSTRUCTION_FILES = ["CLAUDE.md.hbs", "AGENTS.md.hbs"] as const;
const INJECTED_SURFACES = ["arkive-block.md.hbs", "cursor-rule.mdc.hbs"] as const;

describe("Template Rendering", () => {
  it("renders CLAUDE.md template with project name", () => {
    expect(RENDERED["CLAUDE.md.hbs"]).toContain("my-app");
    expect(RENDERED["CLAUDE.md.hbs"]).toContain("arkive/architecture.json");
    expect(RENDERED["CLAUDE.md.hbs"]).toContain("Before any major change");
  });

  it("renders AGENTS.md template with project name", () => {
    expect(RENDERED["AGENTS.md.hbs"]).toContain("my-app");
    expect(RENDERED["AGENTS.md.hbs"]).toContain("arkive/architecture.json");
  });

  it("renders cursor rule template", () => {
    expect(RENDERED["cursor-rule.mdc.hbs"]).toContain("arkive/architecture.json");
    expect(RENDERED["cursor-rule.mdc.hbs"]).toContain("alwaysApply: true");
  });
});

describe("Templates teach v2, not v1", () => {
  it.each(ALL)("%s names the v2 discriminator", (_name, rendered) => {
    expect(rendered).toContain("schemaVersion");
    // The v1 discriminator is gone. A document carrying it is a v1 file.
    expect(rendered).not.toMatch(/["']version["']\s*:\s*["']1\.0\.0["']/);
  });

  it.each(ALL)("%s teaches nodes and edges", (_name, rendered) => {
    expect(rendered).toContain("nodes");
    expect(rendered).toContain("edges");
  });

  it.each(FULL_INSTRUCTION_FILES)("%s teaches the six node kinds", (name) => {
    const rendered = RENDERED[name];
    for (const kind of [
      "module",
      "service",
      "datastore",
      "external",
      "datastructure",
      "endpoint",
    ]) {
      expect(rendered).toContain(kind);
    }
  });

  it.each(FULL_INSTRUCTION_FILES)("%s teaches the five storable edge kinds", (name) => {
    const rendered = RENDERED[name];
    for (const kind of ["imports", "calls", "reads", "writes", "derives_from"]) {
      expect(rendered).toContain(kind);
    }
    // `decided_by` is named only to say it is computed, never stored.
    expect(rendered).toContain("decided_by");
  });

  it.each(ALL)("%s teaches subjects, not relatedServices", (_name, rendered) => {
    expect(rendered).toContain("subjects");
  });

  it.each(ALL)("%s teaches provenance in both shapes", (_name, rendered) => {
    expect(rendered).toContain("derived");
    expect(rendered).toContain("authoredBy");
    expect(rendered).toContain("evidence");
  });
});

describe("Templates forbid writing the deprecated view", () => {
  it.each(ALL)("%s names services[] only as something not to write", (_name, rendered) => {
    if (!rendered.includes("services")) return;
    expect(rendered).toMatch(
      /derived view|computed|overwritten|derived from|must not write|not yours|regenerated|nodes\[\]/
    );
  });

  it.each(ALL)("%s has no field-to-write for confidence", (_name, rendered) => {
    // `confidence` may appear only in a sentence explaining that it does not
    // exist. A `"confidence": 0.8` in a JSON example would be teaching v1.
    expect(rendered).not.toMatch(/["']confidence["']\s*:\s*[\d.]/);
    expect(rendered).not.toMatch(/set\s+["']?confidence["']?\s+to/i);
  });

  it.each(ALL)("%s has no relatedServices JSON example", (_name, rendered) => {
    expect(rendered).not.toMatch(/["']relatedServices["']\s*:/);
  });

  it.each(ALL)("%s has no v1 service type taxonomy", (_name, rendered) => {
    expect(rendered).not.toMatch(/frontend\s*\|\s*backend\s*\|\s*database/);
  });
});

describe("The trust-the-document reversal is in the shipped templates", () => {
  it.each(ALL)("%s states structure is derived", (_name, rendered) => {
    expect(rendered.toLowerCase()).toMatch(
      /structure is derived|derive[d]? structure|derivation/
    );
  });

  it.each(ALL)("%s names the command that does the deriving", (_name, rendered) => {
    expect(rendered).toContain("reconcile");
  });

  it.each(ALL)("%s never says trust the document", (_name, rendered) => {
    expect(rendered.toLowerCase()).not.toContain("trust the document");
  });

  it.each(ALL)("%s forbids re-deriving-away-from-code", (_name, rendered) => {
    // The old text read "Do NOT re-derive the architecture from code if this
    // file exists". An inverted form is just as wrong.
    expect(rendered).not.toMatch(
      /do not re-derive the architecture from code if/i
    );
  });
});

/**
 * Guard the guards. An assertion that cannot fail is worse than no assertion:
 * it would let `services[]` and `confidence` back into every template and
 * report green. Each stale sample below must be caught by at least one of the
 * patterns the real assertions use.
 */
describe("The staleness assertions have teeth", () => {
  const STALE_SAMPLES: Array<[string, RegExp]> = [
    ['"confidence": 0.8', /["']confidence["']\s*:\s*[\d.]/],
    ['set "confidence" to 1.0', /set\s+["']?confidence["']?\s+to/i],
    ['"relatedServices": ["a"]', /["']relatedServices["']\s*:/],
    ['"version": "1.0.0"', /["']version["']\s*:\s*["']1\.0\.0["']/],
    [
      "type: frontend | backend | database | cache | queue",
      /frontend\s*\|\s*backend\s*\|\s*database\s*\|\s*cache/,
    ],
    ["trust the document", /trust the document/i],
    [
      "Do NOT re-derive the architecture from code if this file exists",
      /do not re-derive the architecture from code if/i,
    ],
  ];

  it.each(STALE_SAMPLES)("catches %s", (sample, pattern) => {
    expect(sample).toMatch(pattern);
  });

  it("the injected surfaces still carry the rule, not the schema", () => {
    for (const name of INJECTED_SURFACES) {
      expect(RENDERED[name]).toContain("reconcile");
      expect(RENDERED[name]).toContain("schemaVersion");
    }
  });
});