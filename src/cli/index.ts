#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { initProject } from "./commands/init.js";
import { exportArchitecture } from "./commands/export.js";
import { createLearnCommand } from "./commands/learn.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { serveProject } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";
import { PLATFORMS, installMcp } from "./commands/install.js";
import { installSkills } from "./commands/install-skill.js";
import type { PlatformName } from "./commands/install.js";

const program = new Command();

program
  .name("arkive")
  .description("Architecture learning tool for AI-assisted development")
  .version("0.1.6");

program
  .command("init")
  .description("Initialize architecture tracking in a project (auto-detects platform, registers MCP, installs skills)")
  .option("-n, --name <name>", "Project name (defaults to directory name)")
  .option("-d, --dir <path>", "Target directory (defaults to current directory)", ".")
  .option("--description <text>", "Project description")
  .option("--standalone", "Generate full AGENTS.md/CLAUDE.md files instead of injecting a block")
  .option("--platform <platform>", `AI platform (auto-detected if omitted): ${Object.keys(PLATFORMS).join(", ")}`)
  .option("--skip-mcp", "Skip MCP server registration")
  .option("--skip-skills", "Skip skill installation")
  .action((options) => {
    const dir = resolve(options.dir);
    if (options.platform && !PLATFORMS[options.platform as PlatformName]) {
      console.error(`Unknown platform: ${options.platform}`);
      console.error(`Supported: ${Object.keys(PLATFORMS).join(", ")}`);
      process.exit(1);
    }
    initProject({
      name: options.name,
      dir,
      description: options.description,
      standalone: options.standalone ?? false,
      platform: options.platform,
      skipMcp: options.skipMcp ?? false,
      skipSkills: options.skipSkills ?? false,
    });
  });

program
  .command("serve")
  .description("Start the MCP server + web viewer")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .option("-p, --port <port>", "HTTP port for the web viewer", "4567")
  .option("--stdio", "Run MCP server over stdio only (no HTTP viewer)")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await serveProject({ dir, port: parseInt(options.port, 10), stdio: options.stdio ?? false });
  });

program
  .command("status")
  .description("Show architecture health: counts, last updated, drift warnings")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await statusCommand({ dir });
  });

program
  .command("reconcile")
  .description("Detect drift between arkive/architecture.json and codebase")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await reconcileCommand({ dir });
  });

program
  .command("export")
  .description("Export architecture as markdown or Mermaid diagram")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .option("-f, --format <format>", "Output format: markdown or mermaid", "markdown")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .action((options) => {
    const dir = resolve(options.dir);
    exportArchitecture({
      dir,
      format: options.format as "markdown" | "mermaid",
      output: options.output ? resolve(options.output) : undefined,
    });
  });

program
  .command("install")
  .description("Register arkive MCP server in your AI platform config")
  .argument("<platform>", `Platform: ${Object.keys(PLATFORMS).join(", ")}`)
  .option("-d, --dir <path>", "Project directory (for project-scoped configs)", ".")
  .option("--config <path>", "Override config file path")
  .action((platform: string, options: { dir: string; config?: string }) => {
    if (!PLATFORMS[platform as PlatformName]) {
      console.error(`Unknown platform: ${platform}`);
      console.error(`Supported: ${Object.keys(PLATFORMS).join(", ")}`);
      process.exit(1);
    }
    const dir = resolve(options.dir);
    const configPath = installMcp({ platform, configPath: options.config, projectDir: dir });
    console.log(`arkive MCP server registered in ${configPath}`);
    console.log("Restart your AI agent to pick up the new MCP server.");
  });

program
  .command("install-skill")
  .description("Install arkive skills for your AI platform")
  .argument("<platform>", "Platform: opencode, claude-code, cursor, vscode, windsurf, cline, claude-desktop")
  .option("--global", "Install skills globally (available in all projects)")
  .option("-d, --dir <path>", "Target directory", ".")
  .action((platform: string, options: { global?: boolean; dir: string }) => {
    const dir = resolve(options.dir);
    const result = installSkills({
      platform,
      targetDir: dir,
      global: options.global ?? false,
    });
    console.log(`Installed ${result.skillsCopied} arkive skills (${result.method}) to ${result.skillDir}`);
    if (result.method === "copy") {
      console.log("Skills are now available as slash commands in your AI agent.");
    } else {
      console.log("Skills injected into instruction files. Your agent will discover them on next session.");
    }
  });

program.addCommand(createLearnCommand());

program.parse();
