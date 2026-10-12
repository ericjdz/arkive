import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * The redaction fixture, shared by the test and the demo.
 *
 * One definition, two consumers. The redaction guarantee is only worth as much
 * as the fixture it is tested against, and a fixture that lives inside a single
 * test file drifts from anything that quotes it — a report that says "the
 * fixture has secrets" needs the fixture to actually have them.
 */

/** Every string literal in the fixture, minus module specifiers. */
export function sourceLiterals(dir: string): string[] {
  const found = new Set<string>();
  for (const rel of ["src/accounts.ts", "src/token.ts"]) {
    const source = readFileSync(join(dir, ...rel.split("/")), "utf-8");
    // Comments are stripped so the oracle is about code, not about the test's
    // own narration.
    const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
      if (value.length > 0) found.add(value);
    }
  }
  // `import { z } from "zod"` is a literal in the source, and
  // `external:npm:zod` is a legitimate separately-derived fact about the
  // repository — package identity, not a leaked value.
  return [...found].filter((value) => value !== "zod");
}

export function secretFixture(dir: string): void {
  const write = (relPath: string, content: string): void => {
    const full = join(dir, ...relPath.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  };

  write(
    "src/accounts.ts",
    [
      "import { z } from 'zod';",
      "",
      "export const AccountSchema = z.object({",
      "  username: z.string().min(3),",
      "  // A default value is the single most likely place a real secret lands.",
      "  password: z.string().default('hunter2-correct-horse-battery'),",
      "  apiToken: z.string().regex(/^sk_example_[a-z0-9]+$/).default('sk_example_51H8xQ2eZvKYlo2C0abcdefgh'),",
      "  awsAccessKeyId: z.string().default('AKIAIOSFODNN7EXAMPLE'),",
      "  ssn: z.string().default('555-12-3456'),",
      "  passphrase: z.string().describe('example: { passphrase: \\'correct horse battery staple\\' }'),",
      "  rotation: z.object({",
      "    previous: z.string().default('s3cr3t-r0tation-v4lue'),",
      "    next: z.string().default('super-secret-value'),",
      "  }),",
      "  role: z.enum(['admin', 'operator']),",
      "  legacyToken: z.literal('00000000000000000000000000000000'),",
      "  pinned: z.string().default('pinned-secret'),",
      "});",
      "",
      "// Ordinary application data in the same file. An extractor that reached",
      "// for the object near the schema would capture every one of these.",
      "export const SEED_ACCOUNTS = [",
      "  { username: 'admin', password: 'hunter2-correct-horse-battery' },",
      "  { username: 'ops', passphrase: 'correct horse battery staple' },",
      "];",
    ].join("\n")
  );

  write(
    "src/token.ts",
    [
      "export interface Token {",
      "  value: string;",
      '  algorithm: "HS256" | "HS512";',
      "  keyId: string;",
      "  expirySeconds: number;",
      "}",
      "",
      "export const HARDCODED = {",
      "  token: 'eyJhbGciOiJIUzI1NiJ9.super-secret-value.signature',",
      "};",
    ].join("\n")
  );
}

/** The secrets the test names explicitly, as a second, independent check. */
export const SECRETS = [
  "hunter2-correct-horse-battery",
  "sk_example_51H8xQ2eZvKYlo2C0abcdefgh",
  "AKIAIOSFODNN7EXAMPLE",
  "555-12-3456",
  "correct horse battery staple",
  "s3cr3t-r0tation-v4lue",
  "super-secret-value",
  "00000000000000000000000000000000",
] as const;