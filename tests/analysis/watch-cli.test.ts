import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawn } from "node:child_process";
import {
  architecturePath,
  readArchitecture,
  writeArchitecture,
} from "../../src/io/architecture-file.js";
import { createEmptyArchitectureV2 } from "../../src/schema/validate-graph.js";

/**
 * Continuous reconciliation, as the CLI delivers it.
 *
 * Issue 0007's acceptance criteria are written about what a user sees, and
 * `src/cli/index.ts` plus `src/cli/commands/reconcile.ts` are the only places
 * those claims are made to a human. Testing the functions behind them would
 * leave the claims untested — the previous generation of this test file proves
 * the point, since it exists only because `reconcile` once printed "in sync" on
 * a document it had never opened.
 *
 * `watch` is a long-running process, so it is exercised the way a user runs it:
 * spawned, given a moment, then asked to stop. Nothing here reaches into the
 * loop's internals, which is the point — a watcher that only works when driven
 * by a test harness is not a watcher.
 */

const CLI = join(process.cwd(), "src", "cli", "index.ts");
const CLI_TIMEOUT = 120_000;

function runCli(args: string[]): { status: number; output: string } {
  const command = `npx tsx "${CLI}" ${args
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ")}`;
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * `node node_modules/tsx/dist/cli.mjs`, rather than `npx tsx`.
 *
 * `npx` on Windows is a `.cmd` shim, and spawning it needs `shell: true` — which
 * inserts a `cmd.exe` between the test and node. `child.kill("SIGINT")` then
 * signals `cmd.exe`, which dies without forwarding, and the watcher under test
 * never receives the signal at all. That is not a test of the watcher; it is a
 * test of Windows process spawning, and it cannot assert what it looks like it
 * is asserting.
 *
 * Going through node directly gives the test the process it thinks it has, and
 * it is also ~1s faster per invocation because `npx` is skipped entirely.
 */
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

/**
 * How long to wait for `arkive watch` to do something, before failing.
 *
 * Generous, because these tests run in parallel with the rest of the suite and
 * `tsx` startup alone is ~2.2s on an idle machine. The old fixed `sleep(3500)`
 * was tuned against a quiet box and lost races under load — a test that passes
 * alone and fails in the suite is worse than no test, because it trains the
 * reader to re-run things.
 */
const WAIT_MS = 60_000;

/**
 * Resolve when the watcher's stdout contains `marker`.
 *
 * Event-driven rather than `sleep(ms)`: the watcher reports as soon as it has
 * something to say, and a test that waits for the thing it is asserting on is
 * both faster when the machine is idle and correct when it is not.
 */
function waitForOutput(
  read: () => string,
  marker: RegExp,
  what: string,
  timeoutMs = WAIT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const text = read();
      if (marker.test(text)) return resolve(text);
      if (Date.now() - started > timeoutMs) {
        return reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${what}.\n--- watcher output ---\n${text}`
          )
        );
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/**
 * Spawn `arkive watch`, collect stdout, and stop it on SIGINT.
 */
function runWatch(
  dir: string,
  args: string[],
  marker: RegExp
): Promise<{ code: number | null; output: string; signal: string | null }> {
  const child = spawn(process.execPath, [TSX, CLI, "watch", "--dir", dir, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let settled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });

  return new Promise((resolve, reject) => {
    const failsafe = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`watcher never produced output.\n--- stdout ---\n${output}`));
      }
    }, WAIT_MS);

    // Stop as soon as it has said the thing being asserted on, so a passing test
    // costs one startup rather than one startup plus a fixed delay.
    const stopWhenSeen = setInterval(() => {
      if (!marker.test(output)) return;
      clearInterval(stopWhenSeen);
      setTimeout(() => child.kill("SIGINT"), 150);
    }, 100);

    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(failsafe);
      clearInterval(stopWhenSeen);
      resolve({ code, output, signal });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(failsafe);
      clearInterval(stopWhenSeen);
      reject(error);
    });
  });
}

/** Spawn `watch` in the background, for tests that change the tree mid-run. */
function startWatchProcess(dir: string, args: string[]): {
  waitFor: (marker: RegExp, what: string) => Promise<string>;
  stop: () => Promise<void>;
  output: () => string;
} {
  const child = spawn(process.execPath, [TSX, CLI, "watch", "--dir", dir, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  return {
    waitFor: (marker, what) => waitForOutput(() => output, marker, what),
    output: () => output,
    stop: async () => {
      child.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(undefined);
        }, 10_000);
        child.on("close", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    },
  };
}

function write(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/**
 * Add an authored node to a document, persisting it as a **pure v2 graph**.
 *
 * The projection `readArchitecture` attaches (`services` / `connections`) is a
 * set of *edits* that `writeArchitecture` folds back onto the graph. Hand it back
 * alongside a mutated `nodes` array and the fold overwrites the new values with
 * the stale projected ones — a `summary` edit comes back empty. Stripping the
 * view is how a v2-native edit is meant to be written, and it is exactly what
 * `reconcileOnce` does before persisting a derivation.
 */
function addAuthoredNode(
  dir: string,
  node: {
    id: string;
    kind: "service";
    name: string;
    summary: string;
    tech: string;
    provenance: { derived: false; authoredBy: "human"; reviewedAt?: string };
  }
): void {
  const read = readArchitecture(dir);
  if (!read.success) throw new Error(read.error);
  read.data.nodes.push(node);

  const payload: Record<string, unknown> = {
    ...(read.data as unknown as Record<string, unknown>),
    schemaVersion: 2,
  };
  delete payload.services;
  delete payload.connections;
  delete payload.version;
  delete payload.warnings;
  if (!writeArchitecture(dir, payload as never).success) throw new Error("write failed");
}

describe("arkive watch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-watch-cli-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);

    const arch = createEmptyArchitectureV2("watch-cli", "Watch CLI");
    arch.nodes.push({
      id: "svc:api",
      kind: "service",
      name: "API",
      summary: "A human wrote this and no derivation is going to replace it.",
      tech: "express",
      provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
    });
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is registered with --dir and --interval", () => {
    const help = runCli(["watch", "--help"]);
    expect(help.output).toContain("--dir");
    expect(help.output).toContain("--interval");
    expect(help.output).toContain("Reconcile");
  }, CLI_TIMEOUT);

  it("persists the derived graph to arkive/architecture.json", async () => {
    const before = readArchitecture(tempDir);
    if (!before.success) throw new Error(before.error);
    expect(before.data.nodes.length).toBe(1);

    // Wait for the cycle that persists, not for a fixed interval.
    const run = await runWatch(tempDir, ["--interval", "200"], /^\d+ nodes? added/m);

    expect(run.output).toMatch(/arkive watch: reconciling/);
    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    // The whole point of the issue: 231 module nodes this repository derives were
    // never written anywhere before this.
    expect(after.data.nodes.some((n) => n.id === "module:src/a.ts")).toBe(true);
    expect(after.data.nodes.some((n) => n.id === "external:npm:express")).toBe(true);
    expect(after.data.edges.some((e) => e.kind === "imports")).toBe(true);
  }, CLI_TIMEOUT);

  it("adds a node when a file is added while it runs", async () => {
    // Start the watcher on a project with one file, wait for it to report the
    // first write, then change the tree and wait for the second. The report has
    // to name what appeared.
    const watcher = startWatchProcess(tempDir, ["--interval", "200"]);

    await watcher.waitFor(/^\d+ nodes? added/m, "the first persisted cycle");
    write(tempDir, "src/added.ts", `export const added = 1;\n`);
    await watcher.waitFor(/module:src\/added\.ts/, "the node for the file added mid-run");
    await watcher.stop();

    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    expect(after.data.nodes.some((n) => n.id === "module:src/added.ts")).toBe(true);
    // ...and the authored node is still exactly as written.
    const authored = after.data.nodes.find((n) => n.id === "svc:api");
    expect(authored?.summary).toBe("A human wrote this and no derivation is going to replace it.");
    expect(authored?.provenance).toEqual({
      derived: false,
      authoredBy: "human",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });
  }, CLI_TIMEOUT);

  it("terminates on Ctrl-C without leaving the document mid-write", async () => {
    // Cross-platform assertion: the process goes away, and the document it left
    // is complete and parseable. `writeArchitecture` is atomic, so a watcher
    // killed mid-cycle leaves either the old document or the new one — never a
    // truncated one. That is the property worth a test.
    const run = await runWatch(tempDir, ["--interval", "200"], /^\d+ nodes? added/m);
    expect(run.signal === "SIGINT" || run.code !== null).toBe(true);

    const raw = JSON.parse(readFileSync(architecturePath(tempDir), "utf-8"));
    expect(raw.schemaVersion).toBe(2);
    expect(Array.isArray(raw.nodes)).toBe(true);
    expect(raw.nodes.some((n: { id: string }) => n.id === "module:src/a.ts")).toBe(true);
  }, CLI_TIMEOUT);

  // Windows has no POSIX signal disposition, so `child.kill("SIGINT")` there is a
  // `TerminateProcess` and the handler never runs — see the test below.
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)("prints a shutdown line when it receives SIGINT", async () => {
    // Skipped on Windows, and the reason is worth stating rather than hiding
    // behind a platform check.
    //
    // Node on Windows implements `child.kill("SIGINT")` as a call to
    // `TerminateProcess`. The handler registered by `process.on("SIGINT", …)`
    // is not run — there is no signal delivery to intercept, because Windows has
    // no equivalent of POSIX signal disposition for a process without a console.
    // Verified directly against this platform: killing a child that logs from
    // its own SIGINT handler produces the pre-signal output and nothing else.
    //
    // So the handler's behaviour cannot be observed through this mechanism on
    // Windows, and asserting it here would be asserting something the test
    // environment cannot produce. What the handler *does* — stop the loop, stop
    // the timers — is covered in-process by `tests/analysis/watch.test.ts`
    // ("honours maxCycles and can be stopped before any cycle runs"), which
    // tests the code rather than the platform.
    const run = await runWatch(tempDir, ["--interval", "200"], /^\d+ nodes? added/m);
    expect(run.output).toMatch(/stopped/i);
  }, CLI_TIMEOUT);

  it("refuses to start on a project with no document, rather than watching nothing", () => {
    const bare = mkdtempSync(join(tmpdir(), "arkive-watch-cli-bare-"));
    try {
      write(bare, "package.json", "{}");
      const run = runCli(["watch", "--dir", bare]);
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/not found/i);
      expect(run.output).toMatch(/arkive init/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, CLI_TIMEOUT);

  it("rejects an interval that is not a positive number", () => {
    // `parseInt("abc")` is NaN and `NaN` as a timer delay is 0 — a watcher that
    // reconciles in a tight loop and never yields. Failing at parse time is the
    // only outcome where the user learns why their machine is hot.
    const run = runCli(["watch", "--dir", tempDir, "--interval", "abc"]);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/positive number/);
  }, CLI_TIMEOUT);

  it("reports what changed rather than dumping the graph", async () => {
    const run = await runWatch(tempDir, ["--interval", "200"], /^\d+ nodes? added/m);
    // The first cycle is the one that persists; it is a delta line, and the
    // samples are capped.
    const lines = run.output.split("\n");
    expect(lines[0]).toMatch(/arkive watch: reconciling/);
    expect(lines.some((line) => /nodes added/.test(line))).toBe(true);
  }, CLI_TIMEOUT);
});

describe("reconcile --apply is the one-shot escape from watch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-apply-cli-"));
    write(tempDir, "package.json", JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    write(tempDir, "src/a.ts", `import express from "express";\nexport const a = 1;\n`);
    const arch = createEmptyArchitectureV2("apply", "Apply");
    if (!writeArchitecture(tempDir, arch).success) throw new Error("scaffold failed");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is declared in help", () => {
    const help = runCli(["reconcile", "--help"]);
    expect(help.output).toContain("--apply");
  }, CLI_TIMEOUT);

  it("does not write by default and says the delta prospectively", () => {
    const before = readFileSync(architecturePath(tempDir), "utf-8");
    const run = runCli(["reconcile", "--dir", tempDir]);
    expect(run.output).toMatch(/^Would \d+ nodes added/m);
    expect(readFileSync(architecturePath(tempDir), "utf-8")).toBe(before);
  }, CLI_TIMEOUT);

  it("writes with --apply", () => {
    const run = runCli(["reconcile", "--dir", tempDir, "--apply"]);
    expect(run.output).toMatch(/^\d+ nodes added/m);
    const after = readArchitecture(tempDir);
    if (!after.success) throw new Error(after.error);
    expect(after.data.nodes.some((n) => n.id === "module:src/a.ts")).toBe(true);
  }, CLI_TIMEOUT);

  it("exits non-zero when a human-verified claim is unsupported", () => {
    // Same exit-code contract as a critical drift finding: the document asserts
    // something the system contradicts, and CI is entitled to know.
    addAuthoredNode(tempDir, {
      id: "svc:legacy",
      kind: "service",
      name: "Legacy",
      summary: "A service that used to exist.",
      tech: "redis",
      provenance: { derived: false, authoredBy: "human", reviewedAt: "2026-01-01T00:00:00.000Z" },
    });

    const run = runCli(["reconcile", "--dir", tempDir]);
    expect(run.output).toMatch(/authored-unsupported/);
    expect(run.output).toMatch(/svc:legacy/);
    expect(run.output).toMatch(/\[critical\]/);
    expect(run.status).not.toBe(0);
  }, CLI_TIMEOUT);

  it("does not claim 'in sync' over an unsupported human claim", () => {
    // The false-assurance rule, one layer up. An empty drift list over a document
    // that asserts a service the manifest does not declare is not agreement.
    addAuthoredNode(tempDir, {
      id: "svc:legacy",
      kind: "service",
      name: "Legacy",
      summary: "A service that used to exist.",
      tech: "redis",
      provenance: { derived: false, authoredBy: "human" },
    });

    const run = runCli(["reconcile", "--dir", tempDir]);
    expect(run.output).not.toMatch(/is in sync/i);
  }, CLI_TIMEOUT);
});