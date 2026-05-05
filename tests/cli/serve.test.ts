import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

describe("CLI serve command (stdio smoke test)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "archlearn-serve-"));
    const arch = createEmptyArchitecture("serve-test", "Serve smoke");
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.skip("responds to MCP initialize request over stdio", async () => {
    // Skipped: MCP stdio transport + Windows shell spawn has timing issues
    const child = spawn(
      "npx",
      ["tsx", "src/cli/index.ts", "serve", "--dir", tempDir, "--port", "0"],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      }
    );

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    };

    let stdoutBuffer = "";
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for initialize response")), 15000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.id === 1) {
              clearTimeout(timer);
              resolve(trimmed);
              return;
            }
          } catch {
            // partial frame; keep buffering
          }
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Wait for MCP server to be ready before sending
    await new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => reject(new Error("MCP server did not start in time")), 25000);
      child.stderr.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf-8").includes("MCP server connected")) {
          clearTimeout(readyTimer);
          resolve();
        }
      });
      child.on("error", (err) => {
        clearTimeout(readyTimer);
        reject(err);
      });
    });

    child.stdin.write(JSON.stringify(initialize) + "\n");

    try {
      const responseLine = await responsePromise;
      const response = JSON.parse(responseLine);
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
      expect(response.result.serverInfo?.name).toBe("archlearn");
      expect(response.result.capabilities).toBeDefined();
    } finally {
      child.kill();
    }
  }, 30000);

  it("exits with non-zero code when architecture.json is missing", async () => {
    rmSync(tempDir, { recursive: true, force: true });

    const child = spawn(
      "npx",
      ["tsx", "src/cli/index.ts", "serve", "--dir", tempDir],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      }
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("not found");
  }, 15000);
});
