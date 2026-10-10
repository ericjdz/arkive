import { describe, it, expect } from "vitest";
import {
  ProvenanceSchema,
  DerivedProvenanceSchema,
  AuthoredProvenanceSchema,
  authoredBy,
  derivedFrom,
  isLocatedEvidence,
} from "../../src/schema/provenance.js";

/**
 * ADR-0002: "Provenance that is structurally impossible to omit replaces
 * `confidence`". These tests are what make that claim checkable rather than
 * aspirational.
 */

describe("provenance — exactly one of derived or authored", () => {
  it("accepts derived provenance", () => {
    const result = ProvenanceSchema.safeParse(
      derivedFrom("import-graph", ["src/index.ts:4", "src/index.ts:9"])
    );
    expect(result.success).toBe(true);
  });

  it("accepts authored provenance with and without a review date", () => {
    expect(ProvenanceSchema.safeParse(authoredBy("agent")).success).toBe(true);
    expect(
      ProvenanceSchema.safeParse(authoredBy("human", "2026-05-09T00:00:00.000Z")).success
    ).toBe(true);
  });

  it("rejects provenance that omits the discriminator entirely", () => {
    expect(ProvenanceSchema.safeParse({ rule: "import-graph", evidence: ["a.ts:1"] }).success).toBe(
      false
    );
    expect(ProvenanceSchema.safeParse({ authoredBy: "human" }).success).toBe(false);
  });

  it("rejects derived provenance with no rule or no evidence", () => {
    expect(ProvenanceSchema.safeParse({ derived: true, evidence: ["a.ts:1"] }).success).toBe(false);
    expect(ProvenanceSchema.safeParse({ derived: true, rule: "r", evidence: [] }).success).toBe(
      false
    );
    expect(
      ProvenanceSchema.safeParse({ derived: true, rule: "", evidence: ["a.ts:1"] }).success
    ).toBe(false);
  });

  it("rejects an element claiming to be both derived and authored", () => {
    // Both branches are `looseObject` so unknown keys survive, which would
    // otherwise let a cross-branch key ride along as an inert extension and
    // leave the document claiming an element is both. The refinement in
    // provenance.ts closes that.
    expect(
      ProvenanceSchema.safeParse({
        derived: true,
        rule: "import-graph",
        evidence: ["a.ts:1"],
        authoredBy: "human",
      }).success
    ).toBe(false);
    expect(
      ProvenanceSchema.safeParse({
        derived: false,
        authoredBy: "human",
        rule: "import-graph",
        evidence: ["a.ts:1"],
      }).success
    ).toBe(false);
  });

  it("rejects an unknown author", () => {
    expect(ProvenanceSchema.safeParse({ derived: false, authoredBy: "vibes" }).success).toBe(false);
  });

  it("rejects a non-ISO reviewedAt", () => {
    expect(
      ProvenanceSchema.safeParse({ derived: false, authoredBy: "human", reviewedAt: "yesterday" })
        .success
    ).toBe(false);
  });

  it("rejects reviewedAt on the derived branch", () => {
    // A review date on a derived element would claim a human signed off on
    // something no human produced.
    const result = ProvenanceSchema.safeParse({
      derived: true,
      rule: "r",
      evidence: ["a.ts:1"],
      reviewedAt: "2026-05-09T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("exactly one of");
    }
  });

  it("keeps a genuinely unknown key on each branch as an extension", () => {
    // The refinement names the *other branch's* keys; anything else is the
    // user's data and survives (ADR-0006 §3).
    const derived = ProvenanceSchema.parse({
      derived: true,
      rule: "r",
      evidence: ["a.ts:1"],
      "x-tool-version": 2,
    });
    const authored = ProvenanceSchema.parse({
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-05-09T00:00:00.000Z",
      "x-tool-version": 2,
    });
    expect(derived["x-tool-version"]).toBe(2);
    expect(authored["x-tool-version"]).toBe(2);
    expect(DerivedProvenanceSchema.safeParse(derived).success).toBe(true);
    expect(AuthoredProvenanceSchema.safeParse(authored).success).toBe(true);
  });

  it("branches are individually usable", () => {
    expect(DerivedProvenanceSchema.safeParse(derivedFrom("r", ["a.ts:1"])).success).toBe(true);
    expect(AuthoredProvenanceSchema.safeParse(authoredBy("agent")).success).toBe(true);
    expect(DerivedProvenanceSchema.safeParse(authoredBy("agent")).success).toBe(false);
    expect(AuthoredProvenanceSchema.safeParse(derivedFrom("r", ["a.ts:1"])).success).toBe(false);
  });
});

describe("provenance — evidence is a locator, not a feeling", () => {
  it("recognises file:line", () => {
    expect(isLocatedEvidence("src/schema/graph.ts:12")).toBe(true);
    expect(isLocatedEvidence("C:\\repo\\src\\index.ts:3")).toBe(true);
    expect(isLocatedEvidence("package.json:1")).toBe(true);
  });

  it("does not accept a bare word, a URL with no port, or a trailing colon", () => {
    expect(isLocatedEvidence("probably fine")).toBe(false);
    expect(isLocatedEvidence("https://example.com/docs")).toBe(false);
    expect(isLocatedEvidence("src/index.ts:")).toBe(false);
    expect(isLocatedEvidence(":42")).toBe(false);
  });
});
