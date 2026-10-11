import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installGitHooks, uninstallGitHooks } from "../../src/cli/commands/hooks.js";
import { readArchitecture, writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";

/**
 * The gate, against real `git`.
 *
 * Everything else in `tests/hooks/` drives the functions directly. This file
 * drives `git commit`, because the claim under test is not "the gate returns 1"
 * — it is "**the commit does not happen**", and only a real commit can say that.
 *
 * It is also the test that would have caught the `post-commit` hook. That hook
 * ran for months, on every commit, in every repository that installed it, and
 * never once did anything: it fired after the commit, passed a flag the CLI did
 * not declare, and piped the resulting failure into `/dev/null || true`. Only an
 * end-to-end test notices a hook that is present, runs, and is inert.
 */

const REPO_ROOT = process.cwd();
const HOOK_ENTRY = join(REPO_ROOT, "src", "hooks", "main.ts");

/**
 * `npx tsx` costs seconds on Windows and this suite spawns git, which spawns the
 * hook, which spawns tsx. Generous, because a flaky timeout here would be
 * indistinguishable from a broken gate.
 */
const GIT_TIMEOUT = 180_000;

let scratch: string;

function git(args: string[], cwd = scratch): { status: number; output: string } {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      // `npx` is a `.cmd` shim on Windows, so the hook has to go through a shell.
      // Git provides one, but the PATH has to reach it for the hook to find npx.
      env: { ...process.env, PATH: `${process.env.PATH};${join(REPO_ROOT, "node_modules", ".bin")}` },
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

beforeAll(() => {
  scratch = join(tmpdir(), `arkive-gate-e2e-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "src"), { recursive: true });
  mkdirSync(join(scratch, "arkive"), { recursive: true });

  git(["init", "-q", "."]);
  git(["config", "user.email", "gate-test@example.com"]);
  git(["config", "user.name", "Gate Test"]);

  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "gate", version: "1.0.0", dependencies: { express: "^4.0.0" } }, null, 2)}\n`
  );
  writeFileSync(
    join(scratch, "src", "app.ts"),
    `import express from "express";\nexport const app = express();\n`
  );

  const scaffold = createEmptyArchitectureV2("gate", "Pre-commit gate fixture");
  if (!writeArchitecture(scratch, scaffold).success) throw new Error("scaffold failed");

  // The gate is wired to the source entry point so the test exercises the code
  // under review rather than a stale build in `dist/`.
  const result = installGitHooks(scratch, { command: `npx tsx "${HOOK_ENTRY}"` });
  expect(result.installed).toEqual(["pre-commit"]);

  writeDanglingEdge();
  git(["add", "-A"]);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The record asserts `api -> payments`; `payments` does not exist. */
function writeDanglingEdge(): void {
  const read = readArchitecture(scratch);
  if (!read.success) throw new Error(read.error);
  read.data.services.push({
    id: "api",
    name: "API",
    type: "backend",
    technology: "express",
    description: "The HTTP API",
    dependencies: [],
  });
  read.data.edges.push({
    id: "calls:api->payments",
    from: "api",
    to: "payments",
    kind: "calls",
    label: "HTTP/REST",
    dangling: true,
    provenance: { derived: false, authoredBy: "agent" },
  });
  const written = writeArchitecture(scratch, read.data);
  if (!written.success) throw new Error(written.error);
}

/** The human fix: re-point or remove the relationship the code does not support. */
function removeDanglingEdge(): void {
  const read = readArchitecture(scratch);
  if (!read.success) throw new Error(read.error);
  read.data.edges = read.data.edges.filter((edge) => edge.dangling !== true);
  // The v1 `connections[]` view is folded back onto the graph on write, so it
  // has to lose the connection too or the write resurrects the dangling edge.
  read.data.connections = read.data.connections.filter(
    (connection) => !(connection.from === "api" && connection.to === "payments")
  );
  const written = writeArchitecture(scratch, read.data);
  if (!written.success) throw new Error(written.error);
}

describe("a real commit against real drift", () => {
  it("the commit does not happen, and the message says why", () => {
    const attempt = git(["commit", "-m", "add the API"]);

    expect(attempt.status).not.toBe(0);
    expect(attempt.output).toContain("dangling-edge");
    expect(attempt.output).toContain("calls:api->payments");
    expect(attempt.output).toContain("git commit --no-verify");
    // And nothing was committed.
    expect(git(["rev-parse", "HEAD"]).status).not.toBe(0);
  }, GIT_TIMEOUT);

  it("--no-verify is the documented way past it", () => {
    const attempt = git(["commit", "--no-verify", "-m", "add the API"]);
    expect(attempt.status).toBe(0);
    expect(git(["rev-parse", "HEAD"]).status).toBe(0);
  }, GIT_TIMEOUT);

  it("the same commit succeeds once the drift is fixed", () => {
    removeDanglingEdge();
    writeFileSync(join(scratch, "src", "app.ts"), 'import express from "express";\nexport const app = express();\n// touched\n');
    git(["add", "-A"]);

    const attempt = git(["commit", "-m", "reconcile the architecture record"]);
    expect(attempt.status).toBe(0);
    expect(attempt.output).not.toContain("dangling-edge");
  }, GIT_TIMEOUT);
});

describe("the gate is a gate, not a post-hoc note", () => {
  it("runs before the commit is created, not after", () => {
    // The old `post-commit` hook fired after the commit existed, so it could
    // never prevent anything. Asserting the hook file's name is the smallest
    // honest form of that claim.
    expect(existsSync(join(scratch, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(scratch, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("leaves the working tree exactly as it found it", () => {
    const status = git(["status", "--porcelain"]);
    expect(status.output.trim()).toBe("");
  });

  it("can be removed, and commits work afterwards with no gate at all", () => {
    const result = uninstallGitHooks(scratch);
    expect(result.removed).toEqual(["pre-commit"]);
    expect(existsSync(join(scratch, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(scratch, "package.json"), "utf-8")).toContain("express");
  });
});
