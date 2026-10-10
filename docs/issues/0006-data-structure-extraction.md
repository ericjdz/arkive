# 0006 — Data structure extraction

status: open
stream: derive
blocked_by: 0004

## Context

The maintainer's own framing of the vision: *"structurally builds the project
into a graph based system, linking dependencies of files, structure of data,
etc."* Module graph is half of that. **Structure of data** is the other half,
and it does not exist yet.

Nothing in the current schema represents what shape the data is. `dataFlows[]`
describes user-facing sequences as `steps[{actor, action}]` — narrative prose,
not structure. A learner cannot answer "what does a Service record actually
contain" or "which fields cross this boundary," which is exactly the question
that makes an architecture real.

## Scope

1. **`datastructure` nodes.** Extract from Zod schemas, TypeScript
   interfaces/types, OpenAPI specs, SQL DDL, and JSON Schema. Start with TS
   types and Zod — arkive's own stack — and make the extractor an interface so
   others are additive.
2. **Shape edges.** Link a `datastructure` to the `module` that defines it
   (`derives_from` inverted) and to the modules that read or write it
   (`reads` / `writes`). A data structure touched by twelve modules is a
   coupling point, and it should be visible without reading twelve modules.
3. **Track transformation.** Where a shape is mapped into another shape, emit an
   edge with the mapping attached. Silent reshaping between layers is where
   real bugs live and it is invisible in a module graph.
4. **Redaction by default.** Extracted shapes must not capture secrets or PII
   field values. Structure and types only — never literals. This document is
   committed to a repository and may be read by anyone with access.

## Out of scope

Schema *instances* or runtime traffic. This is static shape, not data.

## Acceptance criteria

- [ ] TypeScript interfaces and Zod schemas produce `datastructure` nodes with
      fields and types.
- [ ] A field-level or shape-level coupling is discoverable: "which modules
      write this shape" answers correctly against a fixture.
- [ ] No literal values appear in extracted output. Test asserts this.
- [ ] New language/schema format = one new extractor file.
- [ ] `npm run lint` and `npm test` pass.

## Risk

Extraction quality varies enormously by codebase, and a poor extractor is worse
than none because it produces confident wrong structure. Ship it as
*best-effort with explicit coverage reporting* — same honesty rule as 0005.