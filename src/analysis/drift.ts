import type { Architecture } from "../schema/types.js";
import type { ScanResult } from "./scanner.js";

export type DriftSeverity = "info" | "warning" | "critical";

export type DriftKind =
  | "undeclared-import"
  | "stale-stack"
  | "untracked-service"
  | "low-confidence";

export interface DriftWarning {
  kind: DriftKind;
  severity: DriftSeverity;
  subject: string;
  message: string;
  suggestion: string;
}

export interface DriftReport {
  warnings: DriftWarning[];
  summary: {
    total: number;
    bySeverity: Record<DriftSeverity, number>;
    byKind: Record<DriftKind, number>;
  };
}

const TOOLING_DENYLIST = new Set([
  "typescript",
  "tsup",
  "tsx",
  "vitest",
  "@types/node",
  "@vitest/ui",
  "eslint",
  "prettier",
  "handlebars",
  "commander",
  "zod",
  "@modelcontextprotocol/sdk",
]);

export function detectDrift(
  architecture: Architecture,
  scan: ScanResult
): DriftReport {
  const warnings: DriftWarning[] = [];

  if (!scan.hasPackageJson) {
    return finalize(warnings);
  }

  const deps = new Set(scan.dependencies);

  // 1. Imports that are not declared in package.json
  for (const imp of scan.imports) {
    if (!deps.has(imp)) {
      warnings.push({
        kind: "undeclared-import",
        severity: "warning",
        subject: imp,
        message: `Source imports "${imp}" but it is not in package.json dependencies.`,
        suggestion: `Run \`npm install ${imp}\` or remove the import.`,
      });
    }
  }

  // 2. Stack entries not represented in dependencies
  const stackEntries = [
    ...architecture.stack.framework,
    ...architecture.stack.database,
    ...architecture.stack.runtime,
  ];
  for (const entry of stackEntries) {
    if (!matchesAnyDep(entry, deps)) {
      warnings.push({
        kind: "stale-stack",
        severity: "warning",
        subject: entry,
        message: `arkive/architecture.json lists "${entry}" in stack, but no matching dependency found in package.json.`,
        suggestion: `Either install the dependency or remove "${entry}" from architecture.stack.`,
      });
    }
  }

  // 3. Significant imports that don't map to any tracked service.technology
  const serviceTechs = new Set(
    architecture.services.map((s) => s.technology.toLowerCase())
  );
  for (const imp of scan.imports) {
    if (TOOLING_DENYLIST.has(imp)) continue;
    if (!deps.has(imp)) continue;
    if (mapsToService(imp, serviceTechs)) continue;
    warnings.push({
      kind: "untracked-service",
      severity: "info",
      subject: imp,
      message: `Imported package "${imp}" does not correspond to any service.technology in arkive/architecture.json.`,
      suggestion: `If "${imp}" introduces a new service or significant capability, add or update a service entry.`,
    });
  }

  // Flag services with low confidence for human review
  for (const svc of architecture.services) {
    const conf = (svc as any).confidence;
    if (typeof conf === "number" && conf < 0.6) {
      warnings.push({
        kind: "low-confidence",
        severity: "warning",
        subject: svc.id,
        message: `Service "${svc.name}" has low confidence (${conf}). Source: ${(svc as any).source ?? "unknown"}.`,
        suggestion: `Verify this service exists and is correctly described. Set confidence to 1.0 and source to "human-verified" after review.`,
      });
    }
  }

  return finalize(warnings);
}

function matchesAnyDep(stackEntry: string, deps: Set<string>): boolean {
  const normalized = stackEntry.toLowerCase().replace(/[.\s]/g, "");
  for (const dep of deps) {
    const depNorm = dep.toLowerCase().replace(/[.\-/@]/g, "");
    if (depNorm.includes(normalized) || normalized.includes(depNorm)) {
      return true;
    }
  }
  return false;
}

function mapsToService(imp: string, serviceTechs: Set<string>): boolean {
  const norm = imp.toLowerCase().replace(/[.\-/@]/g, "");
  for (const tech of serviceTechs) {
    const techNorm = tech.replace(/[.\s\-]/g, "");
    if (techNorm.includes(norm) || norm.includes(techNorm)) {
      return true;
    }
  }
  return false;
}

function finalize(warnings: DriftWarning[]): DriftReport {
  const bySeverity: Record<DriftSeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
  };
  const byKind: Record<DriftKind, number> = {
    "undeclared-import": 0,
    "stale-stack": 0,
    "untracked-service": 0,
    "low-confidence": 0,
  };
  for (const w of warnings) {
    bySeverity[w.severity]++;
    byKind[w.kind]++;
  }
  return {
    warnings,
    summary: {
      total: warnings.length,
      bySeverity,
      byKind,
    },
  };
}
