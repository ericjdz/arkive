import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveModules, mergeDerived } from "../../../src/analysis/derive.js";
import {
  findLiteralTokens,
  redactTypeText,
  collapseTypeText,
} from "../../../src/analysis/structures/redact.js";
import { createEmptyArchitectureV2 } from "../../../src/schema/validate-graph.js";
import type { DerivationResult } from "../../../src/analysis/derive.js";
import { SECRETS, secretFixture, sourceLiterals } from "./redaction-fixture.js";

/**
 * Redaction: `arkive/architecture.json` may never carry a literal value.
 *
 * ## Why this test is written the way it is
 *
 * `docs/issues/0006-data-structure-extraction.md` section 4: "Extracted shapes
 * must not capture secrets or PII field values. Structure and types only, never
 * literals. This document is committed to a repository and may be read by
 * anyone with access."
 *
 * The obvious way to test that is a denylist: assert the output does not contain
 * a known secret string. That tests the denylist, not the guarantee, and a
 * denylist that misses a secret fails silently.
 *
 * So there are two assertions here and they check different things:
 *
 * 1. **Named secrets absent.** Every secret the fixture plants is absent from
 *    the derived graph. Direct, and it fails loudly the day a leak appears.
 * 2. **Every source literal absent.** Every string literal the fixture contains
 *    is absent, except a module specifier. This is the one that generalises: a
 *    leak through a construct nobody enumerated fails here even though no test
 *    author thought of it.
 *
 * The second needs a test of its own to stay honest — a fixture that lost its
 * literals makes it vacuous, and a vacuous security test is worse than none
 * because it is evidence.
 *
 * ## The fixture is adversarial on purpose
 *
 * The secrets sit everywhere a Zod schema author actually puts them: a
 * `.default()`, a `.describe()` (whose argument is prose, and prose is where
 * example payloads go), an enum, a `z.literal`, and a plain object literal of
 * seed data in the same file. That last one matters most: it is ordinary
 * application data, and an extractor that reached for "the object near the
 * schema" would capture every value in it.
 */

function write(dir: string, relPath: string, content: string): void {
  writeFileSync(join(dir, ...relPath.split("/")), content, "utf-8");
}

/** Literals from the fixture that survive anywhere in the derived output. */
function leakedLiterals(dir: string, result: DerivationResult): string[] {
  const serialised = JSON.stringify({ nodes: result.nodes, edges: result.edges });
  return sourceLiterals(dir).filter((literal) => serialised.includes(literal));
}

describe("the derived graph never carries a literal value", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-redact-"));
    write(tempDir, "package.json", "{}");
    secretFixture(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("the fixture really does contain every secret the test claims it does", () => {
    const source = readFileSync(join(tempDir, "src", "accounts.ts"), "utf-8");
    for (const secret of SECRETS) {
      expect(source, `fixture no longer contains ${secret}`).toContain(secret);
    }
  });

  it("emits no fixture secret anywhere in the derived nodes or edges", () => {
    const result = deriveModules(tempDir);
    const serialised = JSON.stringify({ nodes: result.nodes, edges: result.edges });

    for (const secret of SECRETS) {
      expect(serialised, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it("leaves no string literal from the source anywhere in the graph", () => {
    expect(leakedLiterals(tempDir, deriveModules(tempDir))).toEqual([]);
  });

  it("actually reads the fixture, so the oracle is not vacuous", () => {
    const literals = sourceLiterals(tempDir);

    expect(literals.length).toBeGreaterThan(8);
    expect(literals).toContain("hunter2-correct-horse-battery");
    expect(literals).toContain("admin");
  });

  it("still records the fields and types: redaction costs structure nothing", () => {
    const result = deriveModules(tempDir);
    const account = result.nodes.find((node) => node.id.endsWith("::AccountSchema"));
    expect(account).toBeDefined();

    const fields = (account as unknown as { fields: Array<Record<string, unknown>> }).fields;
    const byName = new Map(fields.map((field) => [field.name, field]));

    // The field called `password` exists, and its type is `string`. The issue's
    // own example, verbatim.
    expect(byName.get("password")?.type).toBe("string");
    // A `.default()` makes the field optional on input. That survives.
    expect(byName.get("password")?.optional).toBe(true);
    // A nested object is a field of type `object`, not flattened away.
    expect(byName.get("rotation")?.type).toBe("object");
    // An enum's members are values; its width is structure.
    expect(byName.get("role")?.type).toBe("string");
    expect(byName.get("role")?.literals).toBe(2);
    // A `z.literal(...)` is a value wearing a type costume.
    expect(byName.get("legacyToken")?.type).toBe("string");
    expect(byName.get("legacyToken")?.literals).toBe(1);
    // A `.describe()` argument is prose and is dropped whole.
    expect(byName.get("passphrase")?.type).toBe("string");
  });

  it("collapses a literal union to its primitive and records the constraint width", () => {
    const result = deriveModules(tempDir);
    const token = result.nodes.find((node) => node.id.endsWith("::Token"));
    const fields = (token as unknown as { fields: Array<Record<string, unknown>> }).fields;

    const algorithm = fields.find((field) => field.name === "algorithm");
    expect(algorithm?.type).toBe("string");
    expect(algorithm?.literals).toBe(2);
    expect(JSON.stringify(fields)).not.toContain("HS256");
    expect(JSON.stringify(fields)).not.toContain("HS512");
  });

  it("survives a round trip through the persisted document", () => {
    // The derived graph is not the artifact. `arkive/architecture.json` is, and
    // it is what gets committed. A redaction guarantee that holds in memory and
    // not on disk is a guarantee about the wrong object.
    const result = deriveModules(tempDir);
    const document = createEmptyArchitectureV2("redaction", "Redaction fixture");
    const merged = mergeDerived(document, result);

    const persisted = JSON.stringify({ nodes: merged.nodes, edges: merged.edges });
    for (const secret of SECRETS) {
      expect(persisted, `leaked into the document: ${secret}`).not.toContain(secret);
    }
  });
});

describe("redaction is a transformer, not a filter", () => {
  it("replaces every literal in a type with its kind", () => {
    expect(redactTypeText('"hunter2"')).toBe("string");
    expect(redactTypeText("'hunter2'")).toBe("string");
    expect(redactTypeText("`hunter2`")).toBe("string");
    expect(redactTypeText("42")).toBe("number");
    expect(redactTypeText("true")).toBe("boolean");
  });

  it("keeps a union of literals, and drops the literals", () => {
    expect(redactTypeText('"a" | "b" | "c"')).toBe("string");
  });

  it("keeps structure that is not a value", () => {
    expect(redactTypeText("Array<string>")).toBe("Array<string>");
    expect(redactTypeText("Record<string, number>")).toBe("Record<string,number>");
    expect(redactTypeText("OwnerRecord[]")).toBe("OwnerRecord[]");
    // Digits inside an identifier are not literals.
    expect(redactTypeText("Sha256Digest")).toBe("Sha256Digest");
    expect(redactTypeText("utf8")).toBe("utf8");
  });

  it("normalises whitespace so two runs produce byte-identical output", () => {
    // `arkive reconcile --apply` commits this text. A type string that reformats
    // itself between runs produces a diff on every run for no reason.
    expect(collapseTypeText("  string  |   string ")).toBe("string");
    expect(collapseTypeText(" string | string | string")).toBe("string");
    expect(collapseTypeText("string")).toBe(collapseTypeText("  string  "));
  });

  it("caps a pathological type without changing what it is", () => {
    const long = `Map<string, ${"Array<".repeat(40)}string${">".repeat(40)}>`;
    expect(collapseTypeText(long).length).toBeLessThanOrEqual(160);
  });

  it("findLiteralTokens reports every string, which is what makes it an oracle", () => {
    const found = findLiteralTokens({ a: "one", b: ["two", { c: "three" }] });
    expect(found).toEqual(['$.a = "one"', '$.b[0] = "two"', '$.b[1].c = "three"']);
  });
});