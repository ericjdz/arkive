import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import express from "express";
import { architecturePath, readArchitecture } from "../../io/architecture-file.js";
import { startStdioServer } from "../../server/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServeOptions {
  dir: string;
  port?: number;
  open?: boolean;
  stdio?: boolean;
}

export function createViewerServer(dir: string): { app: express.Express; server: Server } {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.get("/api/architecture", (_req, res) => {
    const result = readArchitecture(dir);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json(result.data);
  });

  const viewerDir = resolve(__dirname, "../viewer");
  if (existsSync(viewerDir)) {
    app.use(express.static(viewerDir));
    app.use((_req, res) => {
      const indexPath = join(viewerDir, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Viewer not built. Run `npm run build:viewer` first.");
      }
    });
  }

  const server = createServer(app);
  return { app, server };
}

export async function serveProject(options: ServeOptions): Promise<void> {
  const archPath = architecturePath(options.dir);
  if (!existsSync(archPath)) {
    process.stderr.write(
      `architecture.json not found at ${archPath}. Run \`archlearn init\` first.\n`
    );
    process.exit(1);
  }

  if (options.stdio) {
    await startStdioServer({ dir: options.dir });
    return;
  }

  const port = options.port ?? 4567;

  const { server } = createViewerServer(options.dir);
  server.listen(port, () => {
    process.stderr.write(`Viewer running at http://localhost:${port}\n`);
  });

  await startStdioServer({ dir: options.dir });
}
