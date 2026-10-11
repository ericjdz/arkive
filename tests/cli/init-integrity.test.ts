import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { initProject, detectPlatform } from "../../src/cli/commands/init.js";
import { installGitHooks } from "../../src/cli/commands/hooks.js";
import { ARKIVE_DIR, ARCHITECTURE_FILENAME } from "../../src/io/architecture-file.js";

const REPO_ROOT = process.cwd();
const CLI = join(REPO_ROOT, "src", "cli", "index.ts");
const CLI_TIMEOUT = 60_000;

function runCli(args: string[]): { status: number; output: string } {
  const command = `npx tsx "${CLI}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;
  try {
    return { status: 0, output: execSync(command, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Recursive content hash of a whole tree. Used to assert "wrote nothing". */
function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${full}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  if (existsSync(root)) walk(root);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
}

describe("regression G — init --dry-run writes nothing, anywhere", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-dryrun-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves an empty directory completely empty", () => {
    const before = hashTree(tempDir);
    const listing = readdirSync(tempDir);

    const exit = runCli(["init", "--dir", tempDir, "--dry-run", "--skip-mcp", "--skip-skills"]);

    expect(exit.status).toBe(0);
    expect(readdirSync(tempDir)).toEqual(listing);
    expect(hashTree(tempDir)).toBe(before);
  }, CLI_TIMEOUT);

  it("leaves a directory that already has files byte-identical", () => {
    // The dirty-repo case: files the user cares about, plus an architecture
    // document, plus a git directory with hooks in it.
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(tempDir, "AGENTS.md"), "# My notes\n\nPrecious.\n", "utf-8");
    writeFileSync(join(tempDir, "CLAUDE.md"), "# My notes\n\nAlso precious.\n", "utf-8");
    writeFileSync(join(tempDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho keep me\n");
    writeFileSync(
      join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME),
      JSON.stringify({
        version: "1.0.0",
        project: { name: "dirty", description: "d", created: "2026-05-07T00:00:00.000Z", lastUpdated: "2026-05-07T00:00:00.000Z" },
        services: [],
        connections: [],
        decisions: [],
        dataFlows: [],
        history: [],
      }),
      "utf-8"
    );

    const before = hashTree(tempDir);

    const exit = runCli(["init", "--dir", tempDir, "--dry-run", "--skip-mcp", "--skip-skills"]);

    expect(exit.status).toBe(0);
    expect(hashTree(tempDir)).toBe(before);
  }, CLI_TIMEOUT);

  it("prints the complete plan: every path it would touch", () => {
    const exit = runCli(["init", "--dir", tempDir, "--dry-run", "--skip-mcp", "--skip-skills"]);

    expect(exit.output).toContain("Dry run");
    expect(exit.output).toContain(`${ARKIVE_DIR}/${ARCHITECTURE_FILENAME}`);
    expect(exit.output).toContain("CLAUDE.md");
    expect(exit.output).toContain("AGENTS.md");
    expect(exit.output).toContain(`.cursor/rules/${"architecture-tracker.mdc"}`);
    expect(exit.output).toMatch(/path\(s\) would be written/);
  }, CLI_TIMEOUT);

  it("calls out writes that land outside the project directory", () => {
    // An MCP registration for claude-desktop writes into $HOME. The user has to
    // be able to see that before it happens, not discover it afterwards.
    const exit = runCli([
      "init",
      "--dir",
      tempDir,
      "--dry-run",
      "--platform",
      "claude-desktop",
      "--skip-skills",
    ]);

    expect(exit.status).toBe(0);
    expect(exit.output).toContain("OUTSIDE your project directory");
    expect(exit.output).toMatch(/claude_desktop_config\.json/);
    expect(hashTree(tempDir)).toBe(hashTree(tempDir));
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(false);
  }, CLI_TIMEOUT);

  it("initProject({dryRun}) is a no-op in-process too", () => {
    const before = hashTree(tempDir);
    const lines = captureLog(() => {
      initProject({ dir: tempDir, name: "dry", dryRun: true, skipMcp: true, skipSkills: true });
    });

    expect(lines.join("\n")).toContain("Dry run");
    expect(hashTree(tempDir)).toBe(before);
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(false);
  });
});

describe("regression — init installs no git hook unless asked", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-hooks-consent-"));
    mkdirSync(join(tempDir, ".git", "hooks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ADR-0005 replaced `post-commit` with `pre-commit`: `post-commit` fires after
  // the commit exists and therefore can never gate anything. These assertions
  // follow the decision. What they are *for* — that `init` writes nothing into
  // `.git/hooks` without being asked (ADR-0006 §4) — is unchanged, and the
  // last two cases still prove the opt-in path works.
  const hookPath = (): string => join(tempDir, ".git", "hooks", "pre-commit");

  it("does not create .git/hooks/pre-commit", () => {
    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.status).toBe(0);
    expect(existsSync(hookPath())).toBe(false);
    // And it does not resurrect the hook ADR-0005 deleted.
    expect(existsSync(join(tempDir, ".git", "hooks", "post-commit"))).toBe(false);
  }, CLI_TIMEOUT);

  it("says so, rather than silently omitting it", () => {
    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(exit.output).toMatch(/not installed by default/i);
    expect(exit.output).toContain("arkive hooks");
  }, CLI_TIMEOUT);

  it("--skip-hooks is accepted and reported explicitly", () => {
    const exit = runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills", "--skip-hooks"]);

    expect(exit.status).toBe(0);
    expect(exit.output).toContain("--skip-hooks");
    expect(existsSync(hookPath())).toBe(false);
  }, CLI_TIMEOUT);

  it("leaves an existing git hook exactly as it found it", () => {
    const existing = "#!/bin/sh\necho 'do not touch'\n";
    writeFileSync(hookPath(), existing, "utf-8");

    runCli(["init", "--dir", tempDir, "--skip-mcp", "--skip-skills"]);

    expect(readFileSync(hookPath(), "utf-8")).toBe(existing);
  }, CLI_TIMEOUT);

  it("the opt-in path still works: `arkive hooks` installs it", () => {
    // init stopped doing it; the dedicated command is how you ask for it.
    const result = installGitHooks(tempDir);
    expect(result.installed).toContain("pre-commit");
    expect(existsSync(hookPath())).toBe(true);
  });

  it("initProject({installHooks: true}) opts back in for programmatic callers", () => {
    captureLog(() => {
      initProject({ dir: tempDir, name: "hooked", installHooks: true, skipMcp: true, skipSkills: true });
    });
    expect(existsSync(hookPath())).toBe(true);
  });

  it("--skip-hooks overrides an installHooks request", () => {
    captureLog(() => {
      initProject({ dir: tempDir, name: "hooked", installHooks: true, skipHooks: true, skipMcp: true, skipSkills: true });
    });
    expect(existsSync(hookPath())).toBe(false);
  });
});

describe("init consent scope — the only file written without a flag is the document", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-consent-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes the document, the instruction files, and nothing outside the project", () => {
    const exit = runCli([
      "init",
      "--dir",
      tempDir,
      "--skip-mcp",
      "--skip-skills",
      "--platform",
      "claude-code",
    ]);

    expect(exit.status).toBe(0);
    expect(existsSync(join(tempDir, ARKIVE_DIR, ARCHITECTURE_FILENAME))).toBe(true);
    expect(existsSync(join(tempDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(tempDir, "AGENTS.md"))).toBe(true);
    // --skip-mcp means no MCP config anywhere, in the project or in $HOME.
    expect(existsSync(join(tempDir, ".mcp.json"))).toBe(false);
  }, CLI_TIMEOUT);

  it("detects the platform before writing, not after", () => {
    // Detection keys off `.cursor/`, `.claude/` and `AGENTS.md` — all of which
    // init itself creates. Detecting after the first write reports whatever
    // init just made instead of what the project actually is.
    const envKeys = ["OPENCODE_SESSION", "OPENCODE", "CLAUDE_CODE", "ANTHROPIC_API_KEY", "CURSOR_SESSION"];
    const saved = envKeys.map((k) => [k, process.env[k]] as const);
    for (const key of envKeys) delete process.env[key];

    try {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      expect(detectPlatform(tempDir)).toBe("claude-code");

      const fresh = mkdtempSync(join(tmpdir(), "arkive-detect-"));
      try {
        expect(detectPlatform(fresh)).toBeNull();
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
