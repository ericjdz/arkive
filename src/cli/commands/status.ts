import { readArchitecture } from "../../io/architecture-file.js";
import { scanProject } from "../../analysis/scanner.js";
import { detectDrift, type DriftReport } from "../../analysis/drift.js";
import { CURRENT_SCHEMA_VERSION } from "../../schema/graph.js";
import type { Architecture } from "../../schema/types.js";

export interface StatusOptions {
  dir: string;
}

export interface StatusReport {
  project: Architecture["project"];
  lastUpdated: string;
  /** The v2 discriminator, reported so a user can see the migration happened. */
  schemaVersion: number;
  /** `true` while the document was still v1 on disk and the next write upgrades it. */
  pendingMigration: boolean;
  counts: {
    /** The v2 graph's own counts — what is actually stored. */
    nodes: number;
    edges: number;
    /** The deprecated v1 view, for continuity with pre-v2 tooling. */
    services: number;
    connections: number;
    decisions: number;
    dataFlows: number;
    history: number;
  };
  stack: Architecture["stack"];
  drift: DriftReport;
}

export type StatusResult =
  | { ok: true; report: StatusReport }
  | { ok: false; error: string };

export async function runStatus(options: StatusOptions): Promise<StatusResult> {
  const read = readArchitecture(options.dir);
  if (!read.success) return { ok: false, error: read.error };

  const arch = read.data;
  const scan = scanProject(options.dir);
  const drift = detectDrift(arch, scan);

  return {
    ok: true,
    report: {
      project: arch.project,
      lastUpdated: arch.project.lastUpdated,
      schemaVersion: arch.schemaVersion,
      // `version: "1.0.0"` means the file on disk has no `schemaVersion`. It is
      // in memory as v2; only a write persists that, deliberately (issue 0004 §3).
      pendingMigration: arch.version === "1.0.0",
      counts: {
        nodes: arch.nodes.length,
        edges: arch.edges.length,
        services: arch.services.length,
        connections: arch.connections.length,
        decisions: arch.decisions.length,
        dataFlows: arch.dataFlows.length,
        history: arch.history.length,
      },
      stack: arch.stack,
      drift,
    },
  };
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Project:      ${report.project.name}`);
  lines.push(`Description:  ${report.project.description || "(none)"}`);
  lines.push(`Last updated: ${report.lastUpdated}`);
  lines.push(`Schema:       v${report.schemaVersion} (current: v${CURRENT_SCHEMA_VERSION})`);
  if (report.pendingMigration) {
    lines.push(
      `              this document is still v1 on disk; the next write persists v${CURRENT_SCHEMA_VERSION}`
    );
  }
  lines.push("");
  lines.push("Counts:");
  lines.push(`  Nodes:       ${report.counts.nodes}`);
  lines.push(`  Edges:       ${report.counts.edges}`);
  lines.push(`  Services:    ${report.counts.services} (deprecated projection)`);
  lines.push(`  Connections: ${report.counts.connections} (deprecated projection)`);
  lines.push(`  Decisions:   ${report.counts.decisions}`);
  lines.push(`  Data flows:  ${report.counts.dataFlows}`);
  lines.push(`  History:     ${report.counts.history}`);
  lines.push("");
  lines.push("Stack:");
  lines.push(`  Language:       ${report.stack.language.join(", ") || "(none)"}`);
  lines.push(`  Runtime:        ${report.stack.runtime.join(", ") || "(none)"}`);
  lines.push(`  Framework:      ${report.stack.framework.join(", ") || "(none)"}`);
  lines.push(`  Database:       ${report.stack.database.join(", ") || "(none)"}`);
  lines.push(`  Infrastructure: ${report.stack.infrastructure.join(", ") || "(none)"}`);
  lines.push("");
  lines.push(`Drift warnings: ${report.drift.summary.total}`);
  if (report.drift.summary.total > 0) {
    lines.push(
      `  by severity: critical=${report.drift.summary.bySeverity.critical}, warning=${report.drift.summary.bySeverity.warning}, info=${report.drift.summary.bySeverity.info}`
    );
    for (const w of report.drift.warnings) {
      lines.push(`  [${w.severity}] (${w.kind}) ${w.subject}: ${w.message}`);
    }
  }
  // Silence here is the exact failure mode this section exists to prevent: a
  // zero total over a partial scan reads as "clean" unless it is labelled.
  lines.push(
    `Verdict:       ${report.drift.conclusive ? "conclusive — the scan covered the project" : "INCONCLUSIVE — the scan did not cover the project, so this is not a clean bill of health"}`
  );
  return lines.join("\n");
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const result = await runStatus(options);
  if (!result.ok) {
    process.stderr.write(result.error + "\n");
    process.exit(1);
  }
  process.stdout.write(formatStatus(result.report) + "\n");
  if (!result.report.drift.conclusive) {
    process.exitCode = 1;
  }
}