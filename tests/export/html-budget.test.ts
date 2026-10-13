import { describe, it, expect } from "vitest";
import { generateHtmlGraph } from "../../src/export/html.js";
import { LAYOUT_FIXTURE } from "./html-layout.test.js";

/**
 * Budget regression test (ADR-0004 targets table; issue 0010 acceptance:
 * "Budget enforced in CI — a regression fails the build").
 *
 * The artifact for this FIXED fixture — never the live repo graph, whose
 * size grows with the codebase — must stay ≤150 KB uncompressed with zero
 * external references. If the generator gains a dependency, a font, or a
 * CDN script, this fails before CI ships it.
 */
const BUDGET_BYTES = 150 * 1024;

const BUDGET_FIXTURE = {
  ...LAYOUT_FIXTURE,
  project: { name: "budget-fixture", description: "Fixed graph for the size budget." },
  decisions: [
    {
      id: "dec-001",
      topic: "Database choice",
      decision: "Postgres over Mongo.",
      rationale: "Relational model fits.",
      alternatives: [{ name: "Mongo", whyNot: "Document model adds complexity." }],
      timestamp: "2026-05-05T01:00:00.000Z",
      subjects: [{ kind: "node" as const, ref: "db" }],
    },
    {
      id: "dec-002",
      topic: "API style",
      decision: "REST over GraphQL.",
      rationale: "Fewer moving parts.",
      alternatives: [{ name: "GraphQL", whyNot: "Schema overhead for two screens." }],
      timestamp: "2026-05-06T01:00:00.000Z",
      subjects: [{ kind: "node" as const, ref: "api" }],
    },
  ],
};

describe("HTML artifact budget", () => {
  it("stays within 150 KB uncompressed for the fixed fixture graph", () => {
    const html = generateHtmlGraph(BUDGET_FIXTURE);
    expect(Buffer.byteLength(html, "utf-8")).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("makes zero external requests: no src/href to anything but fragments", () => {
    const html = generateHtmlGraph(BUDGET_FIXTURE);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/\bhref\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
    // The only url() in the file is the arrow-marker fragment reference.
    expect(html).not.toMatch(/url\(\s*["']?https?:/);
    expect(html).not.toMatch(/<link\b/i);
  });

  it("is deterministic: same fixture in, same bytes out", () => {
    expect(generateHtmlGraph(BUDGET_FIXTURE)).toBe(generateHtmlGraph(BUDGET_FIXTURE));
  });

  it("parses as HTML containing the node count and every node id", () => {
    const html = generateHtmlGraph(BUDGET_FIXTURE);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<!-- nodes:4 edges:4 decisions:2 -->");
    for (const node of BUDGET_FIXTURE.nodes) {
      expect(html).toContain(node.id);
    }
    // Deep-link contract: the artifact answers ?node=<id>.
    expect(html).toContain("URLSearchParams");
    expect(html).toContain("?node=");
  });

  it("renders decisions with gate, evidence, and caveats per the frozen contract", () => {
    const html = generateHtmlGraph(BUDGET_FIXTURE);
    // dec-001 attaches to db, an authored node: authored gate, no evidence.
    expect(html).toContain("Database choice");
    expect(html).toContain("Postgres over Mongo.");
    expect(html).toContain("Mongo");
    // dec-002 attaches to api, a derived node: derived gate with file:line.
    expect(html).toContain("src/api.ts:1");
    expect(html).toContain("derived");
  });

  it("escapes markup in names and summaries so the document cannot break out", () => {
    const hostile = generateHtmlGraph({
      project: { name: "x</title><script>alert(1)</script>", description: "" },
      nodes: [
        {
          id: "n1",
          kind: "module",
          name: 'a"b<c>',
          summary: "</script><script>alert(2)</script>",
          provenance: { derived: false, authoredBy: "agent" },
        },
      ],
      edges: [],
      decisions: [],
    });
    expect(hostile).not.toContain("</script><script>");
    expect(hostile).toContain("a&quot;b&lt;c&gt;");
  });
});
