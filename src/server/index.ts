import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export interface CreateServerOptions {
  dir: string;
  name?: string;
  version?: string;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? "archlearn",
    version: options.version ?? "0.1.0",
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
    `archlearn MCP server connected via stdio (dir: ${options.dir})\n`
  );
}
