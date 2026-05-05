#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { initProject } from "./commands/init.js";

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

program.parse();
