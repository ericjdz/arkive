#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { PACKAGE_VERSION } from "../version.js";
import { initProject } from "./commands/init.js";
import { exportArchitecture } from "./commands/export.js";
import { createLearnCommand } from "./commands/learn.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { describeOutcome, reconcileOnce, startWatch } from "../analysis/watch.js";
import { serveProject } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";
import { stopViewer } from "./commands/stop.js";
import { PLATFORMS, installMcp } from "./commands/install.js";
import { installSkills } from "./commands/install-skill.js";
import { installGitHooks, uninstallGitHooks, installClaudeHooks, uninstallClaudeHooks } from "./commands/hooks.js";
import { HOOK_EVENTS } from "../hooks/contract.js";
import type { PlatformName } from "./commands/install.js";

const program = new Command();

/**
 * Commander collapses a repeated option into a plain value when it is seen once
 * and into an array when it is seen twice. Every caller below wants a list, and
 * a caller that forgot this produced `include: "src"` typed as `string[]` —
 * which is a `TypeError` at runtime in `withinFilters`, thrown from a scan.
 */
function toList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * A positive integer flag, or a Commander usage error.
 *
 * `parseInt("abc")` is `NaN`, and `NaN` as a `setTimeout` delay is `0` — a
 * watcher that reconciles in a tight loop and never yields. Failing loudly at
 * parse time is the only outcome where the user learns why their watcher
 * melted the CPU.
 */
function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive number of milliseconds.");
  }
  return parsed;
}

program
  .name("arkive")
  .description("Architecture learning tool for AI-assisted development")
  .version(PACKAGE_VERSION);

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
  .option("--skip-hooks", "Skip git hook installation (hooks are not installed by default)")
  .option("--dry-run", "Print every path init would write, and write nothing")
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
      skipHooks: options.skipHooks ?? false,
      dryRun: options.dryRun ?? false,
    });
  });

program
  .command("serve")
  .description("Start the MCP server + web viewer")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .option("-p, --port <port>", "HTTP port for the web viewer", "4567")
  .option("--stdio", "Run MCP server over stdio only (no HTTP viewer)")
  .option("--no-open", "Do not auto-open the browser")
  .action(async (options) => {
    const dir = resolve(options.dir);
    await serveProject({ dir, port: parseInt(options.port, 10), stdio: options.stdio ?? false, open: options.open ?? true });
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
  .option(
    "--quiet",
    "Print nothing on success. The exit code still reports critical findings. Used by the git hook (src/cli/commands/hooks.ts)."
  )
  .option(
    "--include <path>",
    "Restrict the scan to this path prefix. Repeatable. Overrides arkive.config.json."
  )
  .option(
    "--exclude <path>",
    "Never walk this path prefix. Repeatable. Overrides arkive.config.json."
  )
  .option(
    "--no-graph",
    "Suppress the derived-graph summary (node/edge counts, per-language coverage, unresolved imports)."
  )
  .option(
    "--apply",
    "Persist the derived half. Off by default: reconcile is a diagnostic (ADR-0002:113-114), and `arkive watch` is where continuous persistence belongs."
  )
  .action(async (options) => {
    const dir = resolve(options.dir);
    await reconcileCommand({
      dir,
      quiet: options.quiet ?? false,
      include: toList(options.include),
      exclude: toList(options.exclude),
      graph: options.graph ?? true,
      apply: options.apply ?? false,
    });
  });

/**
 * `arkive watch` — continuous reconciliation.
 *
 * Registered inline rather than in `src/cli/commands/watch.ts` because the
 * behaviour is entirely `startWatch`'s: there is no command-specific logic to
 * unit-test separately from the loop, and a file whose only content is an
 * argument object is a file that drifts from its options. When the loop grows
 * options of its own, this becomes a command module.
 *
 * Exits non-zero only on an initial failure. A watcher that ran for an hour and
 * then found something cannot retroactively set an exit code its shell already
 * consumed, so findings are reported as they happen and the exit code reflects
 * only what was true at startup — which is what CI reads.
 */
program
  .command("watch")
  .description("Reconcile the derived graph on every change and report the delta")
  .option("-d, --dir <path>", "Project directory containing arkive/architecture.json", ".")
  .option("--include <path>", "Restrict the scan to this path prefix. Repeatable.")
  .option("--exclude <path>", "Never walk this path prefix. Repeatable.")
  .option(
    "--interval <ms>",
    "Milliseconds between reconciliations (default 1000).",
    parseIntOption
  )
  .action(async (options) => {
    const dir = resolve(options.dir);
    const include = toList(options.include);
    const exclude = toList(options.exclude);

    // Fail fast and loudly if there is nothing to reconcile into. A watcher that
    // silently watches a directory with no document is a process that looks like
    // it is working and is not.
    const probe = reconcileOnce(dir, {
      ...(include !== undefined ? { include } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      apply: false,
    });
    if (probe.status === "absent") {
      process.stderr.write(
        `arkive/architecture.json not found in ${dir}. Run \`arkive init\` first.\n`
      );
      process.exit(1);
    }
    if (probe.status === "unreadable") {
      process.stderr.write(`Failed to read arkive/architecture.json: ${probe.error}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `arkive watch: reconciling ${dir} every ${options.interval ?? 1000}ms. ` +
        `Ctrl-C to stop.\n`
    );
    // The first cycle is the probe we already paid for; print it so the user
    // sees the state they are about to be responsible for. Not written — the
    // loop below writes on its first tick, and a probe that persisted would mean
    // two writes per change.
    process.stdout.write(describeOutcome(probe, false) + "\n");

    const handle = startWatch({
      dir,
      ...(include !== undefined ? { include } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      ...(options.interval !== undefined ? { intervalMs: options.interval } : {}),
      onCycle: (outcome) => {
        process.stdout.write(`\n${describeOutcome(outcome, true)}\n`);
        if (outcome.writeError !== null) process.exitCode = 1;
      },
      onError: (error) => {
        process.stderr.write(`arkive watch: ${(error as Error).message}\n`);
      },
    });

    // The loop is the process. Ctrl-C unwinds it; without this, the handle's
    // pending timer would keep the event loop alive after the signal.
    const stop = (): void => {
      handle.stop();
      process.stdout.write("\narkive watch: stopped.\n");
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
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

const hooksCommand = program
  .command("hooks")
  .description("Install or remove arkive git hooks and agent hook settings")
  .option("--remove", "Remove arkive git hooks")
  .option("--claude", "Install Claude Code hook settings (.claude/settings.json)")
  .option("--remove-claude", "Remove Claude Code hook settings")
  .option("--dry-run", "Print what would change without writing anything")
  .option("--dir <path>", "Project directory", process.cwd())
  .action((opts) => {
    if (opts.removeClaude) {
      const result = uninstallClaudeHooks(opts.dir);
      process.stdout.write(
        result.removed.length > 0
          ? `Removed Claude Code hooks: ${result.removed.join(", ")}\n`
          : "No Claude Code hooks found.\n"
      );
      return;
    }

    if (opts.claude) {
      const result = installClaudeHooks(opts.dir, { dryRun: opts.dryRun });
      if (result.installed.length > 0) {
        process.stdout.write(
          `Installed Claude Code hooks: ${result.installed.join(", ")}\n`
        );
      }
      if (result.skipped.length > 0) {
        process.stdout.write(
          `Already installed: ${result.skipped.join(", ")}\n`
        );
      }
      if (result.error) {
        process.stderr.write(`Warning: ${result.error}\n`);
      }
      return;
    }

    if (opts.remove) {
      const result = uninstallGitHooks(opts.dir);
      if (result.removed.length > 0) {
        process.stdout.write(`Removed arkive hooks: ${result.removed.join(", ")}\n`);
      } else {
        process.stdout.write("No arkive hooks found.\n");
      }
    } else {
      const result = installGitHooks(opts.dir, { dryRun: opts.dryRun });
      if (result.installed.length > 0) {
        process.stdout.write(`Installed hooks: ${result.installed.join(", ")}\n`);
      }
      if (result.skipped.length > 0) {
        process.stdout.write(`Already installed: ${result.skipped.join(", ")}\n`);
      }
      if (result.error) {
        process.stderr.write(`Warning: ${result.error}\n`);
      }
    }
  });

/**
 * `hooks run <event>` is what an installed hook actually invokes — both
 * `.git/hooks/pre-commit` and the generated `.claude/settings.json` shell out
 * to exactly this string. Without it every installed hook fails open and
 * enforces nothing, which is the precise failure mode ADR-0005 exists to
 * eliminate. It is registered here rather than left as a follow-up.
 *
 * `main()` is imported lazily so an ordinary CLI invocation does not pay for
 * the hook surface.
 */
hooksCommand
  .command("run")
  .description("Run one arkive hook. Called by installed hooks; rarely run by hand.")
  .argument("<event>", `One of: ${HOOK_EVENTS.join(", ")}`)
  .option("-d, --dir <path>", "Project directory", ".")
  .action(async (event: string, opts) => {
    const { main } = await import("../hooks/main.js");
    process.exitCode = main([event, "--dir", resolve(opts.dir)]);
  });

program
  .command("stop")
  .description("Stop the running arkive viewer")
  .option("--port <port>", "Port to stop (default: 4567)", "4567")
  .action((opts) => {
    stopViewer({ port: parseInt(opts.port, 10) });
  });

program.addCommand(createLearnCommand());

program.parse();
