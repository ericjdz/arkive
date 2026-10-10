import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createEmptyArchitecture } from "../../schema/validate.js";
import { renderTemplate } from "../../templates/render.js";
import { injectArkiveBlock } from "./inject.js";
import {
  ARKIVE_DIR,
  ARCHITECTURE_FILENAME,
  architecturePath,
  writeArchitecture,
} from "../../io/architecture-file.js";
import {
  describeProbeConflict,
  probeBlocksWrite,
  probeDocumentPaths,
  type DocumentProbe,
} from "../../io/legacy-paths.js";
import { writeFileAtomic } from "../../io/atomic-write.js";
import { installMcp, PLATFORMS, resolveConfigPath } from "./install.js";
import { installSkills, resolveSkillDir } from "./install-skill.js";
import { installGitHooks } from "./hooks.js";
import type { PlatformName } from "./install.js";

export interface InitOptions {
  name?: string;
  dir: string;
  description?: string;
  standalone?: boolean;
  platform?: string;
  skipMcp?: boolean;
  skipSkills?: boolean;
  /**
   * Git hooks are **not** installed by default. Writing to `.git/hooks` without
   * being asked is the same class of unconsented write as writing to `$HOME`,
   * and `README.md` has claimed for several versions that the hook is optional
   * while `init` installed it unconditionally.
   *
   * Opt in with `arkive hooks` after init, or pass `installHooks: true` here.
   */
  installHooks?: boolean;
  /** Explicitly suppress hooks. The default already does; this says so out loud. */
  skipHooks?: boolean;
  /** Print every path that would be written and write nothing at all. */
  dryRun?: boolean;
}

/**
 * Auto-detect which AI platform is running by checking for platform-specific
 * config files or environment variables in the project directory.
 *
 * Callers must run this **before** writing anything. Detection keys off the
 * presence of `.cursor/`, `.claude/`, and `AGENTS.md` — all of which `init`
 * itself creates — so a detect-after-write ordering reports whatever `init`
 * just made, not whatever the project actually is.
 */
export function detectPlatform(projectDir: string): PlatformName | null {
  // Check for existing platform config files (most specific first)
  if (existsSync(join(projectDir, "opencode.json")) || existsSync(join(projectDir, ".opencode"))) {
    return "opencode";
  }
  if (existsSync(join(projectDir, ".mcp.json")) || existsSync(join(projectDir, ".claude"))) {
    return "claude-code";
  }
  if (existsSync(join(projectDir, ".cursor"))) {
    return "cursor";
  }
  if (existsSync(join(projectDir, ".vscode"))) {
    return "vscode";
  }

  // Check environment variables that indicate the running platform
  if (process.env.OPENCODE_SESSION || process.env.OPENCODE) {
    return "opencode";
  }
  if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) {
    return "claude-code";
  }
  if (process.env.CURSOR_SESSION) {
    return "cursor";
  }

  // Check for AGENTS.md (suggests Codex/OpenCode/Copilot)
  if (existsSync(join(projectDir, "AGENTS.md"))) {
    return "opencode";
  }

  return null;
}

type StepAction = "create-dir" | "create" | "update" | "skip" | "register";

interface InitStep {
  action: StepAction;
  path: string;
  detail: string;
  /** True when the path is outside the project directory — usually `$HOME`. */
  outsideProject?: boolean;
  run: () => void;
}

function isOutsideProject(projectDir: string, path: string): boolean {
  return !path.startsWith(projectDir);
}

function buildPlan(
  options: InitOptions,
  probe: DocumentProbe
): { steps: InitStep[]; platform: PlatformName | null } {
  const projectDir = options.dir;
  const projectName = options.name || basename(projectDir);
  const description = options.description || `Architecture for ${projectName}`;
  const architectureFile = `${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`;

  const arkiveDir = join(projectDir, ARKIVE_DIR);
  const archPath = architecturePath(projectDir);
  const steps: InitStep[] = [];

  const dirStep = (path: string, detail: string): void => {
    steps.push({
      action: "create-dir",
      path,
      detail,
      run: () => mkdirSync(path, { recursive: true }),
    });
  };

  const fileStep = (
    path: string,
    contents: string,
    action: StepAction,
    detail: string
  ): void => {
    steps.push({
      action,
      path,
      detail,
      run: () => writeFileAtomic(path, contents),
    });
  };

  dirStep(arkiveDir, `${ARKIVE_DIR}/`);
  dirStep(join(arkiveDir, "history"), `${ARKIVE_DIR}/history/`);
  dirStep(join(arkiveDir, "context", "sessions"), `${ARKIVE_DIR}/context/sessions/`);

  if (probe.status === "current" || existsSync(archPath)) {
    steps.push({
      action: "skip",
      path: archPath,
      detail: "architecture document already exists",
      run: () => {},
    });
  } else {
    const scaffold = createEmptyArchitecture(projectName, description);
    steps.push({
      action: "create",
      path: archPath,
      detail: "new architecture document (empty scaffold)",
      run: (): void => {
        // Same write path as every other update, so the scaffold gets the same
        // atomic-write and validation guarantees a later update does.
        const written = writeArchitecture(projectDir, scaffold);
        if (!written.success) throw new Error(written.error);
      },
    });
  }

  const templateContext = { projectName, architectureFile };

  if (options.standalone) {
    const claudePath = join(projectDir, "CLAUDE.md");
    if (existsSync(claudePath)) {
      steps.push({ action: "skip", path: claudePath, detail: "already exists", run: () => {} });
    } else {
      fileStep(
        claudePath,
        renderTemplate("CLAUDE.md.hbs", templateContext),
        "create",
        "full instruction file (--standalone)"
      );
    }

    const agentsPath = join(projectDir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      steps.push({ action: "skip", path: agentsPath, detail: "already exists", run: () => {} });
    } else {
      fileStep(
        agentsPath,
        renderTemplate("AGENTS.md.hbs", templateContext),
        "create",
        "full instruction file (--standalone)"
      );
    }
  } else {
    const block = renderTemplate("arkive-block.md.hbs", templateContext);

    for (const [name, existed] of [
      ["CLAUDE.md", existsSync(join(projectDir, "CLAUDE.md"))],
      ["AGENTS.md", existsSync(join(projectDir, "AGENTS.md"))],
    ] as const) {
      const path = join(projectDir, name);
      steps.push({
        action: existed ? "update" : "create",
        path,
        detail: existed
          ? `inject arkive block between markers, keeping existing content`
          : "create with an arkive block",
        run: () => injectArkiveBlock(path, block),
      });
    }
  }

  const cursorPath = join(projectDir, ".cursor", "rules", "architecture-tracker.mdc");
  if (existsSync(cursorPath)) {
    steps.push({
      action: "skip",
      path: cursorPath,
      detail: "cursor rule already exists",
      run: () => {},
    });
  } else {
    dirStep(join(projectDir, ".cursor", "rules"), ".cursor/rules/");
    fileStep(
      cursorPath,
      renderTemplate("cursor-rule.mdc.hbs", templateContext),
      "create",
      "cursor rule"
    );
  }

  // Detected here, before any step runs, so a directory arkive has just created
  // cannot be mistaken for the platform the project is actually built on.
  const platform = (options.platform || detectPlatform(projectDir)) as PlatformName | null;

  if (options.skipMcp || !platform || !PLATFORMS[platform]) {
    const reason = options.skipMcp
      ? "--skip-mcp"
      : platform
        ? `unsupported platform: ${platform}`
        : "no platform detected";
    steps.push({
      action: "skip",
      path: "(MCP config)",
      detail: `MCP registration skipped (${reason})`,
      run: () => {},
    });
  } else {
    let configPath: string;
    try {
      configPath = resolveConfigPath(platform, projectDir);
    } catch {
      configPath = "(unresolved)";
    }
    steps.push({
      action: "register",
      path: configPath,
      detail: `register the arkive MCP server for ${PLATFORMS[platform].label}`,
      outsideProject: isOutsideProject(projectDir, configPath),
      run: () => {
        const actual = installMcp({ platform, projectDir });
        console.log(`MCP server registered for ${platform} in ${actual}`);
      },
    });
  }

  if (options.skipSkills || !platform) {
    steps.push({
      action: "skip",
      path: "(skills)",
      detail: `skill installation skipped (${options.skipSkills ? "--skip-skills" : "no platform detected"})`,
      run: () => {},
    });
  } else {
    let skillDir: string;
    try {
      skillDir = resolveSkillDir(platform, projectDir, false);
    } catch {
      skillDir = join(projectDir, ".cursor", "rules");
    }
    steps.push({
      action: "register",
      path: skillDir,
      detail: "install the arkive skills for this platform",
      run: () => {
        const result = installSkills({ platform, targetDir: projectDir, global: false });
        console.log(
          `Installed ${result.skillsCopied} arkive skills (${result.method}) to ${result.skillDir}`
        );
      },
    });
  }

  if (options.skipHooks) {
    steps.push({
      action: "skip",
      path: join(projectDir, ".git", "hooks", "post-commit"),
      detail: "git hooks skipped (--skip-hooks)",
      run: () => {},
    });
  } else if (!options.installHooks) {
    steps.push({
      action: "skip",
      path: join(projectDir, ".git", "hooks", "post-commit"),
      detail: "git hooks NOT installed by default — run `arkive hooks` to opt in",
      run: () => {},
    });
  } else {
    steps.push({
      action: "register",
      path: join(projectDir, ".git", "hooks", "post-commit"),
      detail: "install the post-commit auto-reconcile hook",
      run: () => {
        const hookResult = installGitHooks(projectDir);
        if (hookResult.installed.length > 0) {
          console.log(`Installed git hooks: ${hookResult.installed.join(", ")}`);
        }
      },
    });
  }

  return { steps, platform };
}

function displayPath(projectDir: string, path: string): string {
  const relative = path.startsWith(projectDir)
    ? path.slice(projectDir.length).replace(/^[\\/]/, "")
    : path;
  // Forward slashes regardless of platform: these lines exist to be read and
  // copied into a shell, and every path in arkive's own docs is written that way.
  return (relative || path).replace(/\\/g, "/");
}

const LABELS: Record<StepAction, string> = {
  "create-dir": "mkdir",
  create: "create",
  update: "update",
  register: "register",
  skip: "skip",
};

function printPlan(projectDir: string, steps: InitStep[]): void {
  let wrote = 0;

  for (const step of steps) {
    if (step.action === "skip") {
      console.log(`  ${LABELS.skip.padEnd(9)} ${displayPath(projectDir, step.path).padEnd(40)} ${step.detail}`);
      continue;
    }

    wrote += 1;
    const outside = step.outsideProject ? "  (outside the project directory)" : "";
    console.log(
      `  ${LABELS[step.action].padEnd(9)} ${displayPath(projectDir, step.path).padEnd(40)} ${step.detail}${outside}`
    );
  }

  const skipped = steps.filter((s) => s.action === "skip").length;
  console.log("");
  console.log(`  ${wrote} path(s) would be written, ${skipped} skipped.`);

  const outside = steps.filter((s) => s.outsideProject && s.action !== "skip");
  if (outside.length > 0) {
    console.log("");
    console.log("  These are OUTSIDE your project directory:");
    for (const step of outside) console.log(`    ${displayPath(projectDir, step.path)}`);
  }

  console.log("");
  console.log("  Re-run without --dry-run to apply this plan.");
  console.log("");
}

/** What init chose not to do, after it has done what it did. */
function printSkipped(projectDir: string, steps: InitStep[]): void {
  const skipped = steps.filter((s) => s.action === "skip");
  if (skipped.length === 0) return;

  console.log("");
  console.log("Not done:");
  for (const step of skipped) {
    console.log(`  ${displayPath(projectDir, step.path).padEnd(40)} ${step.detail}`);
  }
}

export function initProject(options: InitOptions): void {
  const projectDir = options.dir;

  // ADR-0006 §1. Runs before anything exists on disk, because a document at a
  // previous path must never be scaffolded over. Commit 62066bc created an
  // empty document beside the real one and destroyed four recorded decisions
  // while doing it.
  const probe = probeDocumentPaths(projectDir);
  if (probeBlocksWrite(probe)) {
    console.error(describeProbeConflict(probe));
    process.exit(1);
  }

  const { steps, platform } = buildPlan(options, probe);

  if (options.dryRun) {
    console.log(`\nDry run for "${basename(projectDir)}" — nothing will be written.\n`);
    printPlan(projectDir, steps);
    return;
  }

  mkdirSync(projectDir, { recursive: true });

  const projectName = options.name || basename(projectDir);

  for (const step of steps) {
    if (step.action === "skip") continue;
    try {
      step.run();
    } catch (err) {
      // Instruction files and platform configs are best-effort; the
      // architecture document is not, and that one throws above.
      console.error(`Warning: could not ${step.action} ${step.path}: ${(err as Error).message}`);
    }
  }

  // Every write that did not happen is reported, so "not installed by default"
  // is a statement the user can act on rather than a silent omission.
  printSkipped(projectDir, steps);

  console.log(`\nDone! Architecture tracking initialized for "${projectName}".`);
  if (platform) {
    console.log(`Platform detected: ${platform}. MCP and skills configured.`);
  } else {
    console.log("No platform detected. Run `arkive install <platform>` and `arkive install-skill <platform>` manually.");
  }
  console.log("Your AI agent will now maintain arkive/architecture.json as it builds.");
}