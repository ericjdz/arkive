import { CURRENT_SCHEMA_VERSION, ArchitectureDocumentV2Schema } from "./graph.js";
import type { ArchitectureDocumentV2 } from "./graph.js";
import { isLocatedEvidence } from "./provenance.js";
import type { Provenance } from "./provenance.js";

/**
 * Shape validation is Zod's job. This module is the part Zod cannot do:
 * the invariants `docs/issues/0003-graph-schema-v2.md` §6 names, plus the
 * soft signals ADR-0002's `arkive check` is supposed to report.
 *
 * Errors are things that make the graph lie about structure. Warnings are
 * things that make it merely incomplete — ADR-0001:146-149 and ADR-0002:105-107
 * are explicit that a decision pointing at something gone is *reported, never
 * deleted*, so it cannot be an error.
 *
 * A failing validation returns the warnings gathered before the failure rather
 * than discarding them, so one fix does not hide the next three problems.
 */

export type GraphWarningCode =
  | "dangling-edge"
  | "decided-by-stored"
  | "unresolved-subject"
  | "evidence-without-location"
  | "tombstoned-node";

export type GraphWarning = {
  code: GraphWarningCode;
  message: string;
  path: string;
};

export type GraphValidationResult =
  | { success: true; data: ArchitectureDocumentV2; warnings: GraphWarning[] }
  | { success: false; error: string; warnings: GraphWarning[] };

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function evidenceWarnings(path: string, provenance: Provenance): GraphWarning[] {
  if (!provenance.derived) {
    return [];
  }
  return provenance.evidence
    .filter((entry) => !isLocatedEvidence(entry))
    .map((entry) => ({
      code: "evidence-without-location" as const,
      message:
        `evidence "${entry}" is not a file:line locator; provenance is only ` +
        `evidence if whoever reads it can open it`,
      path,
    }));
}

/**
 * Parses and semantically validates a v2 document.
 *
 * The schema gate runs first, so `schemaVersion` is already known to be exactly
 * `CURRENT_SCHEMA_VERSION` by the time any invariant below is reached — an
 * unknown major fails at `schemaVersion` in the issue message rather than being
 * best-effort parsed.
 */
export function validateGraphDocument(data: unknown): GraphValidationResult {
  const parsed = ArchitectureDocumentV2Schema.safeParse(data);

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues
        .map((issue) => {
          const where = issue.path.join(".");
          return where === "" ? issue.message : `${where}: ${issue.message}`;
        })
        .join("; "),
      warnings: [],
    };
  }

  const document = parsed.data;

  // --- warnings first, so a hard failure does not hide them ------------------
  //
  // An author fixing a document should see every problem in one pass. If the
  // invariants below returned early, a duplicate id would mask the four
  // dangling subjects behind it, and the natural response — fix, re-run, find
  // the next one — turns one round trip into five.

  const warnings: GraphWarning[] = [];

  document.nodes.forEach((node, index) => {
    if (node.deletedAt !== undefined) {
      warnings.push({
        code: "tombstoned-node",
        message: `nodes.${index}: node "${node.id}" is tombstoned at ${node.deletedAt}`,
        path: `nodes.${index}`,
      });
    }
    warnings.push(...evidenceWarnings(`nodes.${index}`, node.provenance));
  });

  document.edges.forEach((edge, index) => {
    warnings.push(...evidenceWarnings(`edges.${index}`, edge.provenance));
    if (edge.kind === "decided_by") {
      warnings.push({
        code: "decided-by-stored",
        message:
          `edges.${index}: decided_by edge "${edge.id}" is stored; it is a projection of ` +
          `decision.subjects and should be recomputed, not authored`,
        path: `edges.${index}`,
      });
    }
  });

  const edgeIds = new Set(document.edges.map((edge) => edge.id));
  document.decisions.forEach((decision, decisionIndex) => {
    for (const [subjectIndex, subject] of decision.subjects.entries()) {
      const resolves =
        subject.kind === "node"
          ? document.nodes.some((node) => node.id === subject.ref)
          : edgeIds.has(subject.ref);
      if (resolves) {
        continue;
      }
      const path = `decisions.${decisionIndex}.subjects.${subjectIndex}`;
      warnings.push({
        code: "unresolved-subject",
        message:
          `${path}: decision "${decision.id}" points at ${subject.kind} ` +
          `"${subject.ref}", which does not exist`,
        path,
      });
    }
  });

  // --- hard invariants -------------------------------------------------------

  const duplicateNodeIds = findDuplicates(document.nodes.map((node) => node.id));
  if (duplicateNodeIds.length > 0) {
    return {
      success: false,
      error: `duplicate node id(s): ${duplicateNodeIds.join(", ")}`,
      warnings,
    };
  }

  const duplicateEdgeIds = findDuplicates(document.edges.map((edge) => edge.id));
  if (duplicateEdgeIds.length > 0) {
    return {
      success: false,
      error: `duplicate edge id(s): ${duplicateEdgeIds.join(", ")}`,
      warnings,
    };
  }

  const duplicateDecisionIds = findDuplicates(
    document.decisions.map((decision) => decision.id)
  );
  if (duplicateDecisionIds.length > 0) {
    return {
      success: false,
      error: `duplicate decision id(s): ${duplicateDecisionIds.join(", ")}`,
      warnings,
    };
  }

  const liveNodeIds = new Set(
    document.nodes
      .filter((node) => node.deletedAt === undefined)
      .map((node) => node.id)
  );
  const allNodeIds = new Set(document.nodes.map((node) => node.id));
  const decisionIds = new Set(document.decisions.map((decision) => decision.id));

  for (const [index, edge] of document.edges.entries()) {
    const path = `edges.${index}`;

    if (edge.dangling === true) {
      warnings.push({
        code: "dangling-edge",
        message: `${path}: edge "${edge.id}" is flagged dangling and will not resolve`,
        path,
      });
      continue;
    }

    // `decided_by` is the one edge whose `to` is not a node: it points at a
    // decision, which is exactly why it is a projection of `decision.subjects`
    // rather than a stored structural edge.
    const endpoints: Array<readonly [string, "node" | "decision"]> =
      edge.kind === "decided_by"
        ? [
            [edge.from, "node"],
            [edge.to, "decision"],
          ]
        : [
            [edge.from, "node"],
            [edge.to, "node"],
          ];

    for (const [endpoint, target] of endpoints) {
      if (target === "decision") {
        if (!decisionIds.has(endpoint)) {
          return {
            success: false,
            error:
              `${path}: decided_by edge "${edge.id}" references unknown ` +
              `decision "${endpoint}"`,
            warnings,
          };
        }
        continue;
      }

      if (liveNodeIds.has(endpoint)) {
        continue;
      }
      if (allNodeIds.has(endpoint)) {
        return {
          success: false,
          error: `${path}: edge "${edge.id}" references tombstoned node "${endpoint}"`,
          warnings,
        };
      }
      return {
        success: false,
        error: `${path}: edge "${edge.id}" references unknown node "${endpoint}"`,
        warnings,
      };
    }
  }

  return { success: true, data: document, warnings };
}

/**
 * The v2 equivalent of `createEmptyArchitecture`. Deliberately separate from
 * the v1 constructor: `0004` owns the switch-over, and until it lands the two
 * must not be conflated.
 */
export function createEmptyArchitectureV2(
  name: string,
  description: string
): ArchitectureDocumentV2 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      name,
      description,
      created: now,
      lastUpdated: now,
    },
    stack: {
      language: [],
      runtime: [],
      framework: [],
      database: [],
      infrastructure: [],
    },
    nodes: [],
    edges: [],
    decisions: [],
    dataFlows: [],
    history: [
      {
        timestamp: now,
        action: "initial_scaffold",
        summary: `Architecture document created for ${name}`,
      },
    ],
  };
}
