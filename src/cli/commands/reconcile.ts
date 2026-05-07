import { existsSync } from "node:fs";
import { architecturePath, readArchitecture } from "../../io/architecture-file.js";
import { scanProject } from "../../analysis/scanner.js";
import { detectDrift } from "../../analysis/drift.js";

export interface ReconcileOptions {
  dir: string;
}

export async function reconcileCommand(options: ReconcileOptions): Promise<void> {
  const archPath = architecturePath(options.dir);
  if (!existsSync(archPath)) {
    process.stderr.write(
      `arkive/architecture.json not found at ${archPath}. Run \`arkive init\` first.\n`
    );
    process.exit(1);
  }

  const result = readArchitecture(options.dir);
  if (!result.success) {
    process.stderr.write(`Failed to read arkive/architecture.json: ${result.error}\n`);
    process.exit(1);
  }

  const scan = scanProject(options.dir);
  const report = detectDrift(result.data, scan);

  if (report.warnings.length === 0) {
    process.stdout.write("No drift detected. arkive/architecture.json is in sync.\n");
    return;
  }

  process.stdout.write(`Found ${report.warnings.length} drift warning(s):\n\n`);
  for (const warning of report.warnings) {
    const icon = warning.severity === "critical" ? "🔴" : warning.severity === "warning" ? "🟡" : "🔵";
    process.stdout.write(`${icon} [${warning.severity}] ${warning.message}\n`);
    if (warning.suggestion) {
      process.stdout.write(`  → ${warning.suggestion}\n`);
    }
    process.stdout.write("\n");
  }
}
