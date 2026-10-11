import { readFileSync, readdirSync, existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { AliasTarget } from "./resolve.js";

/**
 * `arkive.config.json`.
 *
 * ## Why the walk is configurable at all
 *
 * The scanner used to hardcode `join(dir, "src")`. Fixing that by guessing is
 * not possible: `src`, `lib`, `app`, `packages/&lt;pkg&gt;/src` and
 * `services/&lt;svc&gt;` are all real layouts and none of them is inferable from a
 * repository that has not been opened. So the *default* is the whole tree
 * (which is what makes the `src`-layout fixture equivalent to the others), and
 * configuration narrows it when a user knows something the walk cannot.
 *
 * The important property is that **narrowing is reported, not silent**. A user
 * who writes `"include": ["src"]` gets a graph covering `src` only, and the
 * scan says so in `scanNotes` and in the CLI's coverage line. A configuration
 * that quietly reduced coverage to a directory the user happened to remember
 * would reintroduce exactly the bug this file's predecessor shipped.
 *
 * ## Why aliases live here and not in the extractor
 *
 * `tsconfig.json` already declares path aliases, and `baseUrl`. Reading them
 * means a project using `@/components/Button` gets real edges with no
 * arkive-specific configuration. `arkive.config.json` can add aliases the
 * tsconfig does not declare — webpack resolvers, for instance, whose aliases
 * live in a bundler config this product deliberately does not parse.
 */

export interface ArkiveConfig {
  /** Extra directories never walked. Merged with the built-in skip set. */
  skip?: string[];
  /** Only walk these path prefixes, relative to the repo root. */
  include?: string[];
  /** Never walk these path prefixes. Applied after `include`. */
  exclude?: string[];
  /**
   * Cap on files visited. Exceeding it sets `truncated` rather than running
   * slowly, because a scan that does not terminate is not a scan.
   */
  maxFiles?: number;
  /** Cap on bytes read. Same reasoning. */
  maxBytes?: number;
  /** Cap on a single file's size; larger files are reported as unreadable. */
  maxFileBytes?: number;
  /** Import roots tried when resolving a language-style module path. */
  searchRoots?: string[];
  /** Extra path aliases, merged after those read from `tsconfig.json`. */
  aliases?: Record<string, string[]>;
  /**
   * Extensions with no extractor. A file with one of these is counted against
   * coverage, which is the point: it turns "arkive cannot read Ruby" into a
   * number the user can see rather than a silence they must interpret.
   */
  unsupportedExtensions?: string[];
}

export const CONFIG_FILENAME = "arkive.config.json";

/** Hard ceilings. A config may lower these; it may not raise them past them. */
export const MAX_FILES_CEILING = 200_000;
export const MAX_BYTES_CEILING = 1024 * 1024 * 1024;

export interface LoadedConfig {
  config: ArkiveConfig;
  /** Where `arkive.config.json` came from, or `null` when there was none. */
  source: string | null;
  /**
   * Merged aliases: those read from `tsconfig.json` first, then those declared
   * in `arkive.config.json`. The order matters — the first alias that resolves
   * to a real file wins, so a user's explicit declaration can only be reached
   * after the project's own.
   */
  aliases: AliasTarget[];
  /** `module` lines from every `go.mod` under the root, longest first. */
  goModules: string[];
  /** Notes about anything that could not be read, and what was lost. */
  notes: string[];
}

/**
 * Read `arkive.config.json`, plus the two files it does not own but needs.
 *
 * Every failure mode here is non-fatal and reported in `notes`. A malformed
 * config that made the scan return `[]` would be indistinguishable from a
 * project with no code, which is the one outcome this product cannot afford to
 * produce silently.
 */
export function loadConfig(dir: string): LoadedConfig {
  const notes: string[] = [];
  const config = readConfigFile(dir, notes);

  const aliases: AliasTarget[] = [...readTsconfigAliases(dir, notes)];
  if (config.aliases !== undefined) {
    for (const [prefix, targets] of Object.entries(config.aliases)) {
      if (!Array.isArray(targets) || targets.length === 0) {
        notes.push(`config.aliases["${prefix}"] is not a non-empty array; ignored`);
        continue;
      }
      const usable = targets.filter((target): target is string => typeof target === "string");
      if (usable.length === 0) continue;
      aliases.push({ prefix, targets: usable });
    }
  }

  return { config, source: configSource, aliases, goModules: readGoModules(dir), notes };
}

/** Set by `readConfigFile`; module-scoped rather than threaded through. */
let configSource: string | null = null;

function readConfigFile(dir: string, notes: string[]): ArkiveConfig {
  configSource = null;
  const path = join(dir, CONFIG_FILENAME);
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    // A broken config must not become an empty scan.
    notes.push(`${CONFIG_FILENAME} could not be parsed (${(err as Error).message}); ignored`);
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    notes.push(`${CONFIG_FILENAME} is not a JSON object; ignored`);
    return {};
  }

  configSource = path;
  const record = parsed as Record<string, unknown>;
  const config: ArkiveConfig = {};

  for (const key of [
    "skip",
    "include",
    "exclude",
    "searchRoots",
    "unsupportedExtensions",
  ] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      notes.push(`${CONFIG_FILENAME}: "${key}" must be an array of strings; ignored`);
      continue;
    }
    (config as Record<string, unknown>)[key] = value;
  }

  if (typeof record.aliases === "object" && record.aliases !== null && !Array.isArray(record.aliases)) {
    config.aliases = record.aliases as Record<string, string[]>;
  } else if (record.aliases !== undefined) {
    notes.push(`${CONFIG_FILENAME}: "aliases" must be an object; ignored`);
  }

  for (const key of ["maxFiles", "maxBytes", "maxFileBytes"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      notes.push(`${CONFIG_FILENAME}: "${key}" must be a positive number; ignored`);
      continue;
    }
    const ceiling = key === "maxFiles" ? MAX_FILES_CEILING : MAX_BYTES_CEILING;
    if (value > ceiling) {
      notes.push(
        `${CONFIG_FILENAME}: "${key}" of ${value} exceeds the ${ceiling} ceiling; ` +
          `clamped. Raising this past the ceiling makes the scan unable to finish on ` +
          `a pathological tree, and the cap is the thing that guarantees it does.`
      );
      (config as Record<string, unknown>)[key] = ceiling;
      continue;
    }
    (config as Record<string, unknown>)[key] = value;
  }

  return config;
}

/**
 * Read `compilerOptions.paths` and `baseUrl`.
 *
 * `tsconfig.json` carries comments and trailing commas in the wild, so it is
 * not parsed as strict JSON. Stripping comments and trailing commas is enough
 * for the shapes that appear, and a file that still fails to parse produces a
 * note rather than an empty alias set.
 */
export function readTsconfigAliases(dir: string, notes: string[]): AliasTarget[] {
  const path = join(dir, "tsconfig.json");
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    notes.push(`tsconfig.json could not be read (${(err as Error).message}); no aliases loaded`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (err) {
    notes.push(
      `tsconfig.json could not be parsed (${(err as Error).message}); path aliases ` +
        `were not applied, so imports through them will be reported as unresolvable ` +
        `rather than silently dropped`
    );
    return [];
  }

  const compilerOptions = (parsed as { compilerOptions?: Record<string, unknown> })
    .compilerOptions;
  if (compilerOptions === undefined || typeof compilerOptions !== "object") return [];

  const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : "";
  const paths = compilerOptions.paths;
  if (paths === undefined) return [];

  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
    notes.push('tsconfig.json: "compilerOptions.paths" is not an object; ignored');
    return [];
  }

  const aliases: AliasTarget[] = [];
  for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) continue;
    const targets = (value as string[]).map((target) => {
      // `baseUrl` is prepended by the compiler; matching that here is the
      // difference between an alias resolving and every aliased import
      // reporting as unresolvable in a project that set `baseUrl: "src"`.
      //
      // Both halves are normalised: `baseUrl: "."` plus `"src/*"` is the same
      // path as no baseUrl at all, and joining them naively produces `./src/*`,
      // which no file in the index will ever match.
      const joined = baseUrl.length === 0 ? target : `${baseUrl.replace(/\/+$/, "")}/${target}`;
      return normaliseRelative(joined);
    });
    aliases.push({ prefix: key, targets });
  }
  return aliases;
}

/** Drop a leading `./` and any `/./`, which no index key ever contains. */
function normaliseRelative(path: string): string {
  let out = path;
  while (out.startsWith("./")) out = out.slice(2);
  out = out.replace(/\/\.\//g, "/");
  return out;
}

/**
 * Every `module` line from every `go.mod` under the root, longest first.
 *
 * Bounded to a depth of 4 because a monorepo's modules are that deep in
 * practice and an unbounded walk for a `go.mod` is an unbounded walk.
 */
export function readGoModules(dir: string): string[] {
  const modules: string[] = [];

  const visit = (current: string, depth: number): void => {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name === "node_modules" || name === ".git" || name === "vendor") continue;
        visit(join(current, name), depth + 1);
        continue;
      }
      if (name !== "go.mod") continue;
      try {
        const text = readFileSync(join(current, name), "utf-8");
        const match = /^module\s+(\S+)/m.exec(text);
        if (match) modules.push(match[1]);
      } catch {
        // A go.mod we cannot read is already reported through the coverage
        // report; it is not a reason to abandon the rest of the scan.
      }
    }
  };

  visit(dir, 0);
  // Longest first, so `github.com/org/proj/internal` beats `github.com/org/proj`.
  return modules.sort((a, b) => b.length - a.length);
}

/** Strip `//` and `/* *\/` comments and trailing commas, preserving length. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const length = text.length;

  while (i < length) {
    const ch = text[i];
    const next = i + 1 < length ? text[i + 1] : "";

    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }

  // Trailing commas before a closing brace or bracket.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}