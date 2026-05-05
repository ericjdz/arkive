#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { initProject } from "./commands/init.js";
import { exportArchitecture } from "./commands/export.js";
import { createLearnCommand } from "./commands/learn.js";
import { serveProject } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("archlearn")
  .description("Architecture learning tool for AI-assisted development")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize architecture tracking in a project")
  .option("-n, --name <name>", "Project name (defaults to directory name)")
  .option("-d, --dir <path>", "Target directory (defaults to current directory)", ".")
  .option("--description <text>", "Project description")
  .action((options) => {
    const dir = resolve(options.dir);
    initProject({
      name: options.name,
      dir,
      description: options.description,
    });
  });

program
  .command("serve")
  .description("Start the MCP server + web viewer")
  .option("-d, --dir <path>", "Project directory containing architecture.json", ".")
  .option("-p, --port <port>", "HTTP port for the web viewer", "4567")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await serveProject({ dir, port: parseInt(options.port, 10) });
  });

program
  .command("status")
  .description("Show architecture health: counts, last updated, drift warnings")
  .option("-d, --dir <path>", "Project directory containing architecture.json", ".")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await statusCommand({ dir });
  });

program
  .command("export")
  .description("Export architecture as markdown or Mermaid diagram")
  .option("-d, --dir <path>", "Project directory containing architecture.json", ".")
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

program.addCommand(createLearnCommand());

program.parse();
