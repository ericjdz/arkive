import { z } from "zod";

/**
 * Provenance per `docs/adr/0002-derived-by-default-memory.md`.
 *
 * Every node and edge carries exactly one of two shapes, discriminated on
 * `derived`. The discriminator is mandatory in both branches so that
 * `provenance.derived` is always readable as a boolean and so that omitting
 * provenance is a parse error rather than a silently absent field.
 *
 * `confidence: number` is deliberately absent. It was declared on every v1
 * service and connection, read by two call sites, and written by no code path
 * (`docs/adr/0002-derived-by-default-memory.md:12-24`). A self-assessed scalar
 * that nothing sets is not evidence; `evidence: ["src/x.ts:42"]` is.
 */

/** Identifier of the derivation rule that produced an element. */
export const RuleIdSchema = z.string().min(1);

/**
 * A single `file:line` locator. The shape is not pattern-enforced here because
 * absolute Windows paths (`C:\src\x.ts:42`), POSIX paths, and bare
 * `package.json:1` all occur in practice. `validateGraphDocument` emits a
 * warning for evidence that carries no line number.
 */
export const EvidenceSchema = z.string().min(1);

/** Who wrote an authored element. Not a confidence score: a fact about origin. */
export const AuthorSchema = z.enum(["agent", "human"]);

/** ISO-8601 instant. Same validation v1 already used for `timestamp`. */
export const TimestampSchema = z.string().datetime();

export const DerivedProvenanceSchema = z.looseObject({
  derived: z.literal(true),
  rule: RuleIdSchema,
  evidence: z.array(EvidenceSchema).min(1),
});

export const AuthoredProvenanceSchema = z.looseObject({
  derived: z.literal(false),
  authoredBy: AuthorSchema,
  reviewedAt: TimestampSchema.optional(),
});

/**
 * Exactly one of derived/authored.
 *
 * A `discriminatedUnion` rather than a pair of optionals, so that
 * `{ rule: "x" }` with no `evidence` is rejected at parse time.
 *
 * The refinement exists because both branches are `looseObject` (ADR-0006 §3,
 * unknown keys must survive), which means a cross-branch key would otherwise
 * ride along as an inert extension and the document would claim an element was
 * both derived and authored. That ambiguity is precisely what this model
 * exists to remove, so it is a hard error rather than a tolerated key.
 */
export const ProvenanceSchema = z
  .discriminatedUnion("derived", [DerivedProvenanceSchema, AuthoredProvenanceSchema])
  .refine(
    (provenance) =>
      provenance.derived
        ? !("authoredBy" in provenance) && !("reviewedAt" in provenance)
        : !("rule" in provenance) && !("evidence" in provenance),
    {
      message:
        "provenance must be exactly one of derived ({ rule, evidence }) or " +
        "authored ({ authoredBy, reviewedAt? }); the other branch's keys are not allowed",
    }
  );

export type DerivedProvenance = z.infer<typeof DerivedProvenanceSchema>;
export type AuthoredProvenance = z.infer<typeof AuthoredProvenanceSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Author = z.infer<typeof AuthorSchema>;

const EVIDENCE_WITH_LINE = /^(.*):(\d+)$/;

/** `true` when the evidence string carries a `file:line` locator. */
export function isLocatedEvidence(evidence: string): boolean {
  const match = EVIDENCE_WITH_LINE.exec(evidence);
  return match !== null && match[1].length > 0;
}

/** Convenience constructor for authored provenance. */
export function authoredBy(
  who: Author,
  reviewedAt?: string
): AuthoredProvenance {
  return reviewedAt === undefined
    ? { derived: false, authoredBy: who }
    : { derived: false, authoredBy: who, reviewedAt };
}

/** Convenience constructor for derived provenance. */
export function derivedFrom(rule: RuleId, evidence: string[]): DerivedProvenance {
  return { derived: true, rule, evidence };
}
