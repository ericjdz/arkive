import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateArchitecture } from "../schema/validate.js";
import type { Architecture } from "../schema/types.js";

export const ARCHITECTURE_FILENAME = "architecture.json";
export const ARKIVE_DIR = "arkive";

export type ReadResult =
  | { success: true; data: Architecture }
  | { success: false; error: string };

export type WriteResult =
  | { success: true; data: Architecture }
  | { success: false; error: string };

export function arkiveDirPath(dir: string): string {
  return join(dir, ARKIVE_DIR);
}

export function architecturePath(dir: string): string {
  return join(dir, ARKIVE_DIR, ARCHITECTURE_FILENAME);
}

export function readArchitecture(dir: string): ReadResult {
  const path = architecturePath(dir);

  if (!existsSync(path)) {
    return {
      success: false,
      error: `architecture.json not found in ${join(dir, ARKIVE_DIR)}. Run \`arkive init\` first.`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read ${path}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse ${path} as JSON: ${(err as Error).message}`,
    };
  }

  const validation = validateArchitecture(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `architecture.json failed schema validation: ${validation.error}`,
    };
  }

  return { success: true, data: validation.data };
}

export function writeArchitecture(
  dir: string,
  architecture: Architecture
): WriteResult {
  const next: Architecture = {
    ...architecture,
    project: {
      ...architecture.project,
      lastUpdated: new Date().toISOString(),
    },
  };

  const validation = validateArchitecture(next);
  if (!validation.success) {
    return {
      success: false,
      error: `Refusing to write invalid architecture: ${validation.error}`,
    };
  }

  const path = architecturePath(dir);
  mkdirSync(arkiveDirPath(dir), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to write ${path}: ${(err as Error).message}`,
    };
  }

  try {
    saveSnapshot(dir, validation.data);
  } catch {
    // Snapshot failure should not break the main write
  }

  return { success: true, data: validation.data };
}

const HISTORY_DIR = "history";

export function saveSnapshot(dir: string, architecture: Architecture): string {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);
  mkdirSync(historyDir, { recursive: true });

  const timestamp = (architecture.project.lastUpdated || new Date().toISOString()).replace(/:/g, "-");
  const filename = `${timestamp}.json`;
  const snapshotPath = join(historyDir, filename);

  writeFileSync(snapshotPath, JSON.stringify(architecture, null, 2) + "\n", "utf-8");
  return snapshotPath;
}

export function listSnapshots(dir: string): string[] {
  const historyDir = join(dir, ARKIVE_DIR, HISTORY_DIR);

  if (!existsSync(historyDir)) return [];

  return readdirSync(historyDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function readSnapshot(dir: string, timestamp: string): ReadResult {
  const snapshotPath = join(dir, ARKIVE_DIR, HISTORY_DIR, `${timestamp}.json`);

  if (!existsSync(snapshotPath)) {
    return {
      success: false,
      error: `Snapshot not found: ${timestamp}`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read snapshot: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse snapshot as JSON: ${(err as Error).message}`,
    };
  }

  const validation = validateArchitecture(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `Snapshot failed schema validation: ${validation.error}`,
    };
  }

  return { success: true, data: validation.data };
}
