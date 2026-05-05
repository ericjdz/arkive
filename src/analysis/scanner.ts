import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

export interface ScanResult {
  hasPackageJson: boolean;
  dependencies: string[];
  imports: string[];
}

const IMPORT_REGEX =
  /(?:import\s+(?:[^"']*?\s+from\s+)?|require\s*\(\s*)["']([^"']+)["']/g;

export function scanProject(dir: string): ScanResult {
  const dependencies = readDependencies(dir);
  const imports = scanImports(join(dir, "src"));
  return {
    hasPackageJson: existsSync(join(dir, "package.json")),
    dependencies: Array.from(new Set(dependencies)).sort(),
    imports: Array.from(new Set(imports)).sort(),
  };
}

function readDependencies(dir: string): string[] {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return [];
  }
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
}

function scanImports(srcDir: string): string[] {
  if (!existsSync(srcDir)) return [];
  const files = collectSourceFiles(srcDir);
  const found: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    IMPORT_REGEX.lastIndex = 0;
    while ((match = IMPORT_REGEX.exec(content)) !== null) {
      const spec = match[1];
      const pkg = normalizePackage(spec);
      if (pkg) found.push(pkg);
    }
  }
  return found;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
        out.push(full);
      }
    }
  }
  return out;
}

function normalizePackage(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return null;
  if (!spec.startsWith("@") && !spec.includes("/") && NODE_BUILTINS.has(spec)) {
    return null;
  }
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split("/")[0];
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "child_process", "url", "util", "stream",
  "events", "crypto", "http", "https", "net", "tls", "zlib",
  "buffer", "process", "querystring", "readline", "tty", "vm",
]);
