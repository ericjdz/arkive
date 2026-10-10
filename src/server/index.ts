import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PACKAGE_VERSION } from "../version.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export interface CreateServerOptions {
  dir: string;
  name?: string;
  version?: string;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? "arkive",
    version: options.version ?? PACKAGE_VERSION,
  });
  registerResources(server, options.dir);
  registerTools(server, options.dir);
  return server;
}

export async function startStdioServer(options: CreateServerOptions): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `arkive MCP server connected via stdio (dir: ${options.dir})\n`
  );
}
