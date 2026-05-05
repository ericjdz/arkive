import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLATFORMS, installMcp, resolveConfigPath } from "../../src/cli/commands/install.js";

describe("install MCP command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-install-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists all 7 supported platforms", () => {
    expect(Object.keys(PLATFORMS).sort()).toEqual([
      "claude-code",
      "claude-desktop",
      "cline",
      "cursor",
      "opencode",
      "vscode",
      "windsurf",
    ]);
  });

  it("creates config file if it does not exist", () => {
    const configPath = join(tempDir, "new-config.json");

    const writtenPath = installMcp({ platform: "claude-code", configPath, projectDir: tempDir });

    expect(writtenPath).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({
      mcpServers: {
        arkive: {
          command: "npx",
          args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
        },
      },
    });
  });

  it("preserves existing MCP entries when adding arkive", () => {
    const configPath = join(tempDir, "preserve.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            existing: {
              command: "node",
              args: ["server.js"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    installMcp({ platform: "claude-desktop", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.existing).toEqual({
      command: "node",
      args: ["server.js"],
    });
    expect(config.mcpServers.arkive).toEqual({
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    });
  });

  it("writes the correct shape for cursor", () => {
    const configPath = join(tempDir, "cursor.json");

    installMcp({ platform: "cursor", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({
      mcpServers: {
        arkive: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
        },
      },
    });
  });

  it("writes the correct shape for opencode", () => {
    const configPath = join(tempDir, "opencode.json");

    installMcp({ platform: "opencode", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({
      mcp: {
        arkive: {
          type: "local",
          command: ["npx", "-y", "@ericjdz/arkive", "serve", "--stdio"],
          enabled: true,
        },
      },
    });
  });

  it("writes the correct shape for vscode", () => {
    const configPath = join(tempDir, "vscode.json");

    installMcp({ platform: "vscode", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({
      servers: {
        arkive: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
        },
      },
    });
  });

  it("writes the correct shape for cline", () => {
    const configPath = join(tempDir, "cline.json");

    installMcp({ platform: "cline", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toEqual({
      mcpServers: {
        arkive: {
          command: "npx",
          args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
          disabled: false,
          autoApprove: [],
        },
      },
    });
  });

  it("overwrites existing arkive entry without affecting others", () => {
    const configPath = join(tempDir, "overwrite.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            arkive: {
              command: "old",
              args: ["value"],
            },
            existing: {
              command: "node",
              args: ["other.js"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    installMcp({ platform: "windsurf", configPath, projectDir: tempDir });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.existing).toEqual({
      command: "node",
      args: ["other.js"],
    });
    expect(config.mcpServers.arkive).toEqual({
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    });
  });

  it("creates parent directories if they do not exist", () => {
    const configPath = join(tempDir, "nested", "deeper", "config.json");

    installMcp({ platform: "claude-code", configPath, projectDir: tempDir });

    expect(existsSync(configPath)).toBe(true);
  });

  it("resolveConfigPath returns a string for each platform", () => {
    for (const platform of Object.keys(PLATFORMS)) {
      expect(typeof resolveConfigPath(platform, tempDir)).toBe("string");
    }
  });
});
