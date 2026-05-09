import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createEmptyArchitecture } from "../../schema/validate.js";
import { renderTemplate } from "../../templates/render.js";
import { injectArkiveBlock } from "./inject.js";
import { ARKIVE_DIR, ARCHITECTURE_FILENAME } from "../../io/architecture-file.js";
import { installMcp, PLATFORMS } from "./install.js";
import { installSkills } from "./install-skill.js";
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
}

/**
 * Auto-detect which AI platform is running by checking for platform-specific
 * config files or environment variables in the project directory.
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

export function initProject(options: InitOptions): void {
  const projectDir = options.dir;
  mkdirSync(projectDir, { recursive: true });

  const projectName = options.name || basename(projectDir);
  const description = options.description || `Architecture for ${projectName}`;
  const architectureFile = `${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`;

  // Create arkive directory structure
  const arkiveDir = join(projectDir, ARKIVE_DIR);
  mkdirSync(arkiveDir, { recursive: true });
  mkdirSync(join(arkiveDir, "history"), { recursive: true });
  mkdirSync(join(arkiveDir, "context", "sessions"), { recursive: true });

  const archPath = join(arkiveDir, ARCHITECTURE_FILENAME);
  if (!existsSync(archPath)) {
    const architecture = createEmptyArchitecture(projectName, description);
    writeFileSync(archPath, JSON.stringify(architecture, null, 2) + "\n", "utf-8");
    console.log(`Created ${architectureFile}`);
  } else {
    console.log(`${architectureFile} already exists, skipping`);
  }

  const templateContext = { projectName, architectureFile };

  if (options.standalone) {
    const claudePath = join(projectDir, "CLAUDE.md");
    if (!existsSync(claudePath)) {
      const claudeContent = renderTemplate("CLAUDE.md.hbs", templateContext);
      writeFileSync(claudePath, claudeContent, "utf-8");
      console.log("Created CLAUDE.md (standalone)");
    } else {
      console.log("CLAUDE.md already exists, skipping");
    }

    const agentsPath = join(projectDir, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      const agentsContent = renderTemplate("AGENTS.md.hbs", templateContext);
      writeFileSync(agentsPath, agentsContent, "utf-8");
      console.log("Created AGENTS.md (standalone)");
    } else {
      console.log("AGENTS.md already exists, skipping");
    }
  } else {
    const block = renderTemplate("arkive-block.md.hbs", templateContext);

    const claudePath = join(projectDir, "CLAUDE.md");
    const claudeExisted = existsSync(claudePath);
    injectArkiveBlock(claudePath, block);
    console.log(claudeExisted ? "Updated CLAUDE.md (injected arkive block)" : "Created CLAUDE.md");

    const agentsPath = join(projectDir, "AGENTS.md");
    const agentsExisted = existsSync(agentsPath);
    injectArkiveBlock(agentsPath, block);
    console.log(agentsExisted ? "Updated AGENTS.md (injected arkive block)" : "Created AGENTS.md");
  }

  const cursorDir = join(projectDir, ".cursor", "rules");
  mkdirSync(cursorDir, { recursive: true });
  const cursorPath = join(cursorDir, "architecture-tracker.mdc");
  if (!existsSync(cursorPath)) {
    const cursorContent = renderTemplate("cursor-rule.mdc.hbs", templateContext);
    writeFileSync(cursorPath, cursorContent, "utf-8");
    console.log("Created .cursor/rules/architecture-tracker.mdc");
  } else {
    console.log("Cursor rule already exists, skipping");
  }

  // Auto-detect or use provided platform
  const platform = options.platform || detectPlatform(projectDir);

  // Auto-register MCP server
  if (!options.skipMcp && platform && PLATFORMS[platform as PlatformName]) {
    try {
      const configPath = installMcp({ platform, projectDir });
      console.log(`MCP server registered for ${platform} in ${configPath}`);
    } catch (err) {
      console.error(`Warning: Could not register MCP for ${platform}: ${(err as Error).message}`);
    }
  }

  // Auto-install skills
  if (!options.skipSkills && platform) {
    try {
      const result = installSkills({
        platform,
        targetDir: projectDir,
        global: false,
      });
      console.log(`Installed ${result.skillsCopied} arkive skills (${result.method}) to ${result.skillDir}`);
    } catch (err) {
      console.error(`Warning: Could not install skills: ${(err as Error).message}`);
    }
  }

  // Install git hooks for auto-reconcile
  const hookResult = installGitHooks(projectDir);
  if (hookResult.installed.length > 0) {
    console.log(`Installed git hooks: ${hookResult.installed.join(", ")}`);
  }

  console.log(`\nDone! Architecture tracking initialized for "${projectName}".`);
  if (platform) {
    console.log(`Platform detected: ${platform}. MCP and skills configured.`);
  } else {
    console.log("No platform detected. Run `arkive install <platform>` and `arkive install-skill <platform>` manually.");
  }
  console.log("Your AI agent will now maintain arkive/architecture.json as it builds.");
}
