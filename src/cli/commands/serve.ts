import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import express from "express";
import { architecturePath, readArchitecture } from "../../io/architecture-file.js";
import { readPromptQueue, addPrompt, writePromptQueue } from "../../io/prompt-queue.js";
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.use(express.json());

  app.get("/api/prompts", (_req, res) => {
    const result = readPromptQueue(dir);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json(result.data);
  });

  app.post("/api/prompts", (req, res) => {
    const { targetServices, prompt } = req.body ?? {};
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      res.status(400).json({ error: "prompt is required and must be non-empty" });
      return;
    }
    const services = Array.isArray(targetServices) ? targetServices : [];
    const result = addPrompt(dir, services, prompt.trim());
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  });

  app.delete("/api/prompts/:id", (req, res) => {
    const read = readPromptQueue(dir);
    if (!read.success) {
      res.status(500).json({ error: read.error });
      return;
    }
    const queue = read.data;
    const idx = queue.prompts.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: `Prompt ${req.params.id} not found` });
      return;
    }
    queue.prompts.splice(idx, 1);
    const write = writePromptQueue(dir, queue);
    if (!write.success) {
      res.status(500).json({ error: write.error });
      return;
    }
    res.json({ ok: true });
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
      `arkive/architecture.json not found at ${archPath}. Run \`arkive init\` first.\n`
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
