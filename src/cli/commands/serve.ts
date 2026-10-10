import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { architecturePath, readArchitecture } from "../../io/architecture-file.js";
import { readPromptQueue, addPrompt, writePromptQueue } from "../../io/prompt-queue.js";
import { readProgress, writeProgress } from "../../learning/progress.js";
import { startStdioServer } from "../../server/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The viewer server holds a developer's architecture document, a prompt queue
 * that a connected agent claims and executes, and a process-kill switch. It is
 * opened by the developer and left running while they browse the web in the
 * same browser. That makes "any page the developer visits" an untrusted caller
 * by default, so the server is treated as a trust boundary rather than a
 * convenience wrapper around local files.
 *
 * The five controls, and what each one stops:
 *
 * 1. Loopback-only bind      — LAN neighbours, and anything on a public net.
 * 2. Per-run bearer token    — hostile pages reaching the API over loopback.
 * 3. Exact-origin CORS       — a cross-origin caller reading a response body.
 * 4. Host header validation  — DNS rebinding, which outlives the token if an
 *                              attacker can observe it.
 * 5. Token on /api/shutdown  — a no-cors POST killing the developer's process.
 *
 * See docs/issues/0016-viewer-server-trust-boundary.md.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** Host header values that name this machine and nothing else. */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "[0:0:0:0:0:0:0:1]",
]);

/** Methods the viewer actually uses. Notably this includes PUT, which the
 *  previous policy omitted even though `/api/learning/progress` is a PUT. */
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

export interface ServeOptions {
  dir: string;
  port?: number;
  open?: boolean;
  stdio?: boolean;
}

export interface ViewerServer {
  app: express.Express;
  /** Bound to loopback even when the caller omits a host argument. */
  server: Server;
  /** Per-run bearer token. Required on every `/api/*` request. */
  token: string;
}

/**
 * True when a `Host` header names the local machine.
 *
 * This is the DNS-rebinding control. A rebound attacker keeps sending the
 * hostname it owns (`evil.example`), so rejecting anything that is not
 * `localhost` / `127.0.0.1` / `::1` stops the browser from treating an
 * attacker's page as same-origin with this server. A port suffix is optional
 * because Node omits it for default ports.
 */
export function isLocalHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  if (raw === "") return false;

  // Bracketed IPv6, e.g. `[::1]:4567`.
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return false;
    const host = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return false;
    return LOCAL_HOSTNAMES.has(host);
  }

  const colons = raw.split(":").length - 1;
  if (colons > 1) return LOCAL_HOSTNAMES.has(raw); // bare IPv6 literal
  if (colons === 1) {
    const idx = raw.lastIndexOf(":");
    if (!/^\d{1,5}$/.test(raw.slice(idx + 1))) return false;
    return LOCAL_HOSTNAMES.has(raw.slice(0, idx));
  }
  return LOCAL_HOSTNAMES.has(raw);
}

/** Constant-time comparison so a wrong token leaks no timing information. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The URL handed to the browser.
 *
 * The token rides in the **fragment**, never the query string. A fragment is
 * never transmitted to a server, so it cannot appear in an access log, a proxy
 * log, or a `Referer` header — which is exactly the exposure the issue calls
 * out. `query` carries non-secret viewer state only.
 */
export function viewerUrl(port: number, token: string, query?: string): string {
  const qs = query ? `?${query}` : "";
  return `http://localhost:${port}/${qs}#token=${token}`;
}

/**
 * Bootstrap script injected into the served HTML.
 *
 * The fragment arrives in `location.hash` and never reaches the server, so
 * something in the page has to move it into an `Authorization` header. Today
 * that something is this script: it is injected server-side, which keeps the
 * built viewer working unchanged and keeps the user flow to a single
 * `arkive serve` with nothing to copy.
 *
 * This is a bridge, not the destination. The proper fix is ~10 lines in the
 * viewer's own API module (see docs/issues/0016 for the follow-up); once that
 * lands this function and its injection point can be deleted outright.
 */
export function buildViewerBootstrapScript(token: string): string {
  return `(function () {
  var TOKEN = ${JSON.stringify(token)};
  var hash = window.location.hash || "";
  var match = /(?:^|[#&])token=([^&]+)/.exec(hash);
  if (!match) return;
  var token = decodeURIComponent(match[1]);
  // Drop the token from the address bar so it is not left in a copied URL or
  // a screenshot, and so a reload still authenticates from the server-injected
  // copy rather than the fragment.
  if (hash) {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (e) { /* replaceState is best-effort */ }
  }
  if (token !== TOKEN) return;
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var resolved = new URL(url, window.location.href);
      if (resolved.origin === window.location.origin) {
        var headers = new Headers(
          (init && init.headers) || (input && input.headers) || undefined
        );
        headers.set("Authorization", "Bearer " + token);
        init = Object.assign({}, init, { headers: headers });
      }
    } catch (e) { /* fall through to the native call unchanged */ }
    return nativeFetch(input, init);
  };
})();`;
}

/** Injects the bootstrap script into a built `index.html`. */
export function injectBootstrap(html: string, token: string): string {
  const tag = `<script>${buildViewerBootstrapScript(token)}</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${tag}</head>`);
  if (html.includes("<body")) return html.replace("<body", `${tag}<body`);
  return tag + html;
}

/**
 * Force a loopback bind onto a server we hand out.
 *
 * `listen(port)` with no host argument binds `0.0.0.0` / `::`. Callers in this
 * file pass `"127.0.0.1"` explicitly, but `createViewerServer` is also called
 * from the MCP `open_viewer` tool, which is outside this module's ownership.
 * Enforcing the bind here means a future caller cannot reintroduce a
 * network-exposed viewer by forgetting an argument.
 */
function enforceLoopbackBind(server: Server): Server {
  const originalListen = server.listen.bind(server);
  server.listen = ((...listenArgs: unknown[]) => {
    const args = listenArgs.slice();
    // Covers listen(port), listen(port, cb) and listen(port, backlog, cb).
    // A string in position 1 is already an explicit host, so leave it alone.
    if (typeof args[1] !== "string") args.splice(1, 0, LOOPBACK_HOST);
    return (originalListen as (...a: unknown[]) => Server)(...args);
  }) as Server["listen"];
  return server;
}

export function createViewerServer(dir: string): ViewerServer {
  const app = express();
  const token = randomBytes(24).toString("hex");

  app.disable("x-powered-by");

  // 4. Host header validation, ahead of every route and every body parse.
  app.use((req, res, next) => {
    if (!isLocalHostHeader(req.headers.host)) {
      res.status(403).json({ error: "Forbidden: unexpected Host header" });
      return;
    }
    next();
  });

  // 3. Exact-origin CORS. The viewer is served by this same server, so the only
  // origin that may read a response is our own. A missing Origin means a
  // non-browser client (curl, the MCP server, the stdio bridge) and is allowed
  // through to the token check; an Origin that is not ours is refused outright.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const own = `${req.protocol}://${req.headers.host}`;
      res.setHeader("Vary", "Origin");
      if (origin !== own) {
        if (req.path.startsWith("/api/")) {
          res.status(403).json({ error: "Forbidden: cross-origin request" });
          return;
        }
        next();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    next();
  });

  // 2. Bearer token on every /api route, including /api/shutdown (5).
  app.use("/api", (req, res, next) => {
    const header = req.headers.authorization;
    // Require the `Bearer ` scheme explicitly. A bare token with no scheme is
    // not a valid credential and must not authenticate.
    const scheme = typeof header === "string" ? /^Bearer[ ]+(.+)$/i.exec(header) : null;
    if (!scheme || !tokenMatches(scheme[1].trim(), token)) {
      res.status(401).json({ error: "Unauthorized: missing or invalid bearer token" });
      return;
    }
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

  app.get("/api/learning/progress", (_req, res) => {
    const progress = readProgress(dir);
    if (!progress) {
      res.json(null);
      return;
    }
    res.json(progress);
  });

  app.put("/api/learning/progress", (req, res) => {
    const progress = req.body;
    if (!progress || typeof progress !== "object") {
      res.status(400).json({ error: "Invalid progress data" });
      return;
    }
    try {
      writeProgress(dir, progress);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/architecture", (_req, res) => {
    const result = readArchitecture(dir);
    if (!result.success) {
      // Fallback: return raw JSON so the viewer still renders even if schema is slightly off
      const archPath = architecturePath(dir);
      try {
        const raw = JSON.parse(readFileSync(archPath, "utf-8"));
        res.json(raw);
      } catch {
        res.status(500).json({ error: result.error });
      }
      return;
    }
    res.json(result.data);
  });

  const httpServer = createServer(app);

  // Registered before the static/SPA handlers so it cannot be swallowed by the
  // catch-all that serves index.html for unmatched paths.
  app.post("/api/shutdown", (_req, res) => {
    res.json({ message: "Shutting down..." });
    setTimeout(() => {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    }, 100);
  });

  const viewerDir = resolve(__dirname, "../viewer");
  if (existsSync(viewerDir)) {
    const indexPath = join(viewerDir, "index.html");
    const sendIndex = (_req: express.Request, res: express.Response) => {
      if (!existsSync(indexPath)) {
        res.status(404).send("Viewer not built. Run `npm run build:viewer` first.");
        return;
      }
      res.type("html").send(injectBootstrap(readFileSync(indexPath, "utf-8"), token));
    };
    app.use(express.static(viewerDir, { index: false }));
    app.get("/index.html", sendIndex);
    app.get("/", sendIndex);
    app.use((_req, res) => {
      sendIndex(_req, res);
    });
  }

  return { app, server: enforceLoopbackBind(httpServer), token };
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

  const { server, token } = createViewerServer(options.dir);
  server.listen(port, LOOPBACK_HOST, () => {
    const url = viewerUrl(port, token);
    process.stderr.write(`Viewer running at ${url}\n`);
    if (options.open !== false) {
      const openCmd =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      import("node:child_process").then(({ exec }) => exec(openCmd));
    }
  });

  await startStdioServer({ dir: options.dir });
}
