import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type TopLevelKey = "mcpServers" | "mcp" | "servers";

export type PlatformName =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "vscode"
  | "windsurf"
  | "cline";

interface PlatformConfig {
  topKey: TopLevelKey;
  entry: Record<string, unknown>;
  resolvePath: (projectDir?: string) => string;
  label: string;
}

export const PLATFORMS: Record<PlatformName, PlatformConfig> = {
  "claude-desktop": {
    topKey: "mcpServers",
    entry: {
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    },
    resolvePath: () => {
      if (process.platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }

      if (process.platform === "win32") {
        return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      }

      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    },
    label: "Claude Desktop",
  },
  "claude-code": {
    topKey: "mcpServers",
    entry: {
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    },
    resolvePath: (projectDir) => join(projectDir || process.cwd(), ".mcp.json"),
    label: "Claude Code",
  },
  cursor: {
    topKey: "mcpServers",
    entry: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    },
    resolvePath: (projectDir) => join(projectDir || process.cwd(), ".cursor", "mcp.json"),
    label: "Cursor",
  },
  opencode: {
    topKey: "mcp",
    entry: {
      type: "local",
      command: ["npx", "-y", "@ericjdz/arkive", "serve", "--stdio"],
      enabled: true,
    },
    resolvePath: (projectDir) => join(projectDir || process.cwd(), "opencode.json"),
    label: "OpenCode",
  },
  vscode: {
    topKey: "servers",
    entry: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    },
    resolvePath: (projectDir) => join(projectDir || process.cwd(), ".vscode", "mcp.json"),
    label: "VS Code",
  },
  windsurf: {
    topKey: "mcpServers",
    entry: {
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
    },
    resolvePath: () => {
      if (process.platform === "win32") {
        return join(process.env.USERPROFILE || homedir(), ".codeium", "mcp_config.json");
      }

      return join(homedir(), ".codeium", "mcp_config.json");
    },
    label: "Windsurf",
  },
  cline: {
    topKey: "mcpServers",
    entry: {
      command: "npx",
      args: ["-y", "@ericjdz/arkive", "serve", "--stdio"],
      disabled: false,
      autoApprove: [],
    },
    resolvePath: () => join(homedir(), ".cline", "data", "settings", "cline_mcp_settings.json"),
    label: "Cline",
  },
};

export function resolveConfigPath(platformName: string, projectDir?: string): string {
  const platform = PLATFORMS[platformName as PlatformName];
  if (!platform) {
    throw new Error(`Unsupported platform: ${platformName}`);
  }

  return platform.resolvePath(projectDir);
}

export interface InstallMcpOptions {
  platform: string;
  configPath?: string;
  projectDir?: string;
}

export function installMcp(options: InstallMcpOptions): string {
  const platform = PLATFORMS[options.platform as PlatformName];
  if (!platform) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }

  const configPath = options.configPath || platform.resolvePath(options.projectDir);
  const config = readConfig(configPath);
  const existingEntries = asObject(config[platform.topKey]);

  config[platform.topKey] = {
    ...existingEntries,
    arkive: cloneEntry(platform.entry),
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  return asObject(JSON.parse(readFileSync(configPath, "utf-8")));
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function cloneEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
}
