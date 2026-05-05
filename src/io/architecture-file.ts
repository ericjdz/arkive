import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateArchitecture } from "../schema/validate.js";
import type { Architecture } from "../schema/types.js";

export const ARCHITECTURE_FILENAME = "architecture.json";

export type ReadResult =
  | { success: true; data: Architecture }
  | { success: false; error: string };

export type WriteResult =
  | { success: true; data: Architecture }
  | { success: false; error: string };

export function architecturePath(dir: string): string {
  return join(dir, ARCHITECTURE_FILENAME);
}

export function readArchitecture(dir: string): ReadResult {
  const path = architecturePath(dir);

  if (!existsSync(path)) {
    return {
      success: false,
       error: `architecture.json not found in ${dir}. Run \`arkive init\` first.`,
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
  try {
    writeFileSync(path, JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to write ${path}: ${(err as Error).message}`,
    };
  }

  return { success: true, data: validation.data };
}
