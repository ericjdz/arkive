import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MARKER_START = "<!-- arkive:start -->";
export const MARKER_END = "<!-- arkive:end -->";

export function injectArkiveBlock(filePath: string, block: string): void {
  mkdirSync(dirname(filePath), { recursive: true });

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block + "\n", "utf-8");
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + MARKER_END.length);
    writeFileSync(filePath, before + block + after, "utf-8");
  } else {
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(filePath, content + separator + block + "\n", "utf-8");
  }
}
