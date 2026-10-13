import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_NAMES = [
  // Core skills
  "architecture-tracker",
  "arkive-init",
  "arkive-import",
  "arkive-view",
  "process-prompts",
  // Learning skills
  "learning-mode",
  "explain-decisions",
  // Maintenance skills
  "reconciliation",
  // Walkthrough (issue 0009). Lives at skills/walkthrough/ rather than under
  // a layer directory, so findSkillDir falls back to the skills root.
  // A shipped skill that is never installed is the process-prompts omission
  // c4df919 had to repair after the fact; the registry is the install list.
  "walkthrough",
];

type SkillPlatform = "claude-code" | "opencode" | "cursor" | "vscode" | "windsurf" | "cline" | "claude-desktop";

interface SkillInstallResult {
  skillDir: string;
  skillsCopied: number;
  method: "copy" | "inject";
}

const COPY_PLATFORMS: SkillPlatform[] = ["opencode", "claude-code"];
const RULE_PLATFORMS: SkillPlatform[] = ["cursor"];
const INJECT_PLATFORMS: SkillPlatform[] = ["vscode", "windsurf", "cline", "claude-desktop"];

export function resolveSkillDir(platform: string, projectDir: string, global: boolean): string {
  const home = homedir();

  switch (platform) {
    case "opencode":
      return global ? join(home, ".opencode", "skills") : join(projectDir, ".opencode", "skills");
    case "claude-code":
      return global ? join(home, ".claude", "skills") : join(projectDir, ".claude", "skills");
    case "cursor":
      return global ? join(home, ".cursor", "rules") : join(projectDir, ".cursor", "rules");
    case "vscode":
    case "windsurf":
    case "cline":
    case "claude-desktop":
      return projectDir;
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

function getSkillsRootDir(): string {
  const candidates = [resolve(__dirname, "../../../skills"), resolve(__dirname, "../../skills")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find arkive skills directory. Is the package installed correctly?");
}

/** Search the layer subdirectories (core/, learning/, maintenance/) for a skill by name, then the skills root itself. */
function findSkillDir(skillName: string): string | null {
  const root = getSkillsRootDir();
  const subdirs = ["core", "learning", "maintenance"];

  for (const sub of subdirs) {
    const candidate = join(root, sub, skillName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Top-level skills (e.g. skills/walkthrough/) sit outside any layer
  // taxonomy. Subdirectories win on collision so existing lookups cannot
  // change meaning.
  const topLevel = join(root, skillName);
  if (existsSync(topLevel)) {
    return topLevel;
  }

  return null;
}

function readSkillContent(skillName: string): string {
  const skillDir = findSkillDir(skillName);

  if (!skillDir) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`SKILL.md not found in: ${skillDir}`);
  }

  return readFileSync(skillPath, "utf-8");
}

function copySkills(targetDir: string): number {
  let count = 0;

  for (const skillName of SKILL_NAMES) {
    const srcPath = findSkillDir(skillName);
    if (!srcPath) {
      continue;
    }

    cpSync(srcPath, join(targetDir, skillName), { recursive: true });
    count += 1;
  }

  return count;
}

function injectAsRules(targetDir: string): number {
  const rulesDir = join(targetDir, ".cursor", "rules");
  mkdirSync(rulesDir, { recursive: true });
  let count = 0;

  for (const skillName of SKILL_NAMES) {
    try {
      const dest = join(rulesDir, `${skillName}.mdc`);
      if (!existsSync(dest)) {
        writeFileSync(dest, readSkillContent(skillName), "utf-8");
      }
      count += 1;
    } catch {
      // Ignore missing optional skills.
    }
  }

  return count;
}

function injectIntoInstructionFile(targetDir: string): number {
  const agentsPath = join(targetDir, "AGENTS.md");
  const blocks: string[] = [];

  for (const skillName of SKILL_NAMES) {
    try {
      blocks.push(`<!-- arkive:skill:${skillName}:start -->\n${readSkillContent(skillName)}\n<!-- arkive:skill:${skillName}:end -->`);
    } catch {
      // Ignore missing optional skills.
    }
  }

  if (blocks.length === 0) {
    return 0;
  }

  mkdirSync(dirname(agentsPath), { recursive: true });

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `${blocks.join("\n\n")}\n`, "utf-8");
    return blocks.length;
  }

  const existing = readFileSync(agentsPath, "utf-8");
  const hasAnyMarker = SKILL_NAMES.some((skillName) => existing.includes(`<!-- arkive:skill:${skillName}:start -->`));

  if (!hasAnyMarker) {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(agentsPath, `${existing}${separator}${blocks.join("\n\n")}\n`, "utf-8");
    return blocks.length;
  }

  let updated = existing;
  for (const skillName of SKILL_NAMES) {
    const startMarker = `<!-- arkive:skill:${skillName}:start -->`;
    const endMarker = `<!-- arkive:skill:${skillName}:end -->`;
    const startIndex = updated.indexOf(startMarker);
    const endIndex = updated.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      continue;
    }

    const replacement = `${startMarker}\n${readSkillContent(skillName)}\n${endMarker}`;
    updated = `${updated.slice(0, startIndex)}${replacement}${updated.slice(endIndex + endMarker.length)}`;
  }

  writeFileSync(agentsPath, updated, "utf-8");
  return blocks.length;
}

export interface InstallSkillsOptions {
  platform: string;
  targetDir: string;
  global?: boolean;
}

export function installSkills(options: InstallSkillsOptions): SkillInstallResult {
  const platform = options.platform as SkillPlatform;
  const global = options.global ?? false;

  if (COPY_PLATFORMS.includes(platform)) {
    const skillDir = resolveSkillDir(platform, options.targetDir, global);
    mkdirSync(skillDir, { recursive: true });
    return {
      skillDir,
      skillsCopied: copySkills(skillDir),
      method: "copy",
    };
  }

  if (RULE_PLATFORMS.includes(platform)) {
    const targetDir = global ? homedir() : options.targetDir;
    return {
      skillDir: join(targetDir, ".cursor", "rules"),
      skillsCopied: injectAsRules(targetDir),
      method: "inject",
    };
  }

  if (INJECT_PLATFORMS.includes(platform)) {
    const targetDir = global ? homedir() : options.targetDir;
    return {
      skillDir: targetDir,
      skillsCopied: injectIntoInstructionFile(targetDir),
      method: "inject",
    };
  }

  throw new Error(`Unknown platform: ${options.platform}`);
}
