import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { writeArchitecture } from "../../src/io/architecture-file.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import {
  createViewerServer,
  isLocalHostHeader,
  viewerUrl,
  LOOPBACK_HOST,
} from "../../src/cli/commands/serve.js";
import type { Server } from "node:http";

/**
 * The five controls required by docs/issues/0016-viewer-server-trust-boundary.md.
 * Each test names the attack it stops so a regression reads as a reopened hole
 * rather than an incidental failure.
 */
describe("viewer server trust boundary", () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let token: string;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-sec-"));
    const arch = createEmptyArchitecture("sec-test", "Security test");
    arch.services.push({
      id: "web",
      name: "Web",
      type: "frontend",
      technology: "Next.js",
      description: "UI",
      dependencies: [],
    });
    const r = writeArchitecture(tempDir, arch);
    if (!r.success) throw new Error(r.error);

    const result = createViewerServer(tempDir);
    server = result.server;
    token = result.token;
    // No host argument: the server must still refuse to leave loopback.
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Raw request, so headers Node's fetch client refuses to set can be sent. */
  const raw = (
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "localhost", port, path, method: opts.method ?? "GET", headers: opts.headers },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
          );
        }
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });

  // 1. Loopback-only bind
  it("binds to loopback even when listen() is given no host", () => {
    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr).toBe("object");
    if (typeof addr === "object" && addr) {
      expect(addr.address).toBe(LOOPBACK_HOST);
    }
  });

  // 2. Bearer token
  it("401s an unauthenticated GET /api/architecture", async () => {
    const res = await raw("/api/architecture");
    expect(res.status).toBe(401);
  });

  it("401s a wrong bearer token", async () => {
    const res = await raw("/api/architecture", {
      headers: { Authorization: `Bearer ${"0".repeat(48)}` },
    });
    expect(res.status).toBe(401);
  });

  it("401s a non-bearer Authorization header", async () => {
    const res = await raw("/api/architecture", { headers: { Authorization: token } });
    expect(res.status).toBe(401);
  });

  it("serves /api/architecture to a caller holding the token", async () => {
    const res = await raw("/api/architecture", { headers: auth() });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).project.name).toBe("sec-test");
  });

  it("issues a fresh token per server instance", async () => {
    const second = createViewerServer(tempDir);
    expect(second.token).not.toBe(token);
    expect(second.token).toMatch(/^[0-9a-f]{48}$/);
  });

  // 3. Exact-origin CORS
  it("rejects a cross-origin POST /api/prompts from an arbitrary origin", async () => {
    const res = await raw("/api/prompts", {
      method: "POST",
      headers: {
        ...auth(),
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ targetServices: ["web"], prompt: "exfiltrate secrets" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin GET /api/architecture even with a valid token", async () => {
    const res = await raw("/api/architecture", {
      headers: { ...auth(), Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a preflight OPTIONS from an arbitrary origin", async () => {
    const res = await raw("/api/prompts", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
  });

  it("echoes the exact own origin and never a wildcard", async () => {
    const res = await raw("/api/architecture", {
      headers: { ...auth(), Origin: baseUrl },
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(baseUrl);
    expect(String(res.headers["access-control-allow-origin"])).not.toBe("*");
  });

  it("sets no CORS headers at all for a caller with no Origin", async () => {
    const res = await raw("/api/architecture", { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // 4. Host header / DNS rebinding
  it("rejects a request whose Host header names another machine", async () => {
    const res = await raw("/api/architecture", {
      headers: { ...auth(), Host: `evil.example:${port}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a rebound Host even when the token is valid", async () => {
    const res = await raw("/api/architecture", {
      headers: { ...auth(), Host: "attacker-controlled.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("Host");
  });

  it("accepts loopback Host values", () => {
    expect(isLocalHostHeader("localhost")).toBe(true);
    expect(isLocalHostHeader("localhost:4567")).toBe(true);
    expect(isLocalHostHeader("127.0.0.1")).toBe(true);
    expect(isLocalHostHeader("127.0.0.1:4567")).toBe(true);
    expect(isLocalHostHeader("[::1]:4567")).toBe(true);
    expect(isLocalHostHeader("LOCALHOST:4567")).toBe(true);
  });

  it("rejects non-loopback and malformed Host values", () => {
    expect(isLocalHostHeader("evil.example")).toBe(false);
    expect(isLocalHostHeader("evil.example:4567")).toBe(false);
    expect(isLocalHostHeader("localhost.evil.example")).toBe(false);
    expect(isLocalHostHeader("127.0.0.1.evil.example")).toBe(false);
    expect(isLocalHostHeader("127.0.0.2")).toBe(false);
    expect(isLocalHostHeader("192.168.1.10:4567")).toBe(false);
    expect(isLocalHostHeader("")).toBe(false);
    expect(isLocalHostHeader(undefined)).toBe(false);
  });

  // 5. Shutdown
  it("rejects POST /api/shutdown without a token", async () => {
    const res = await raw("/api/shutdown", { method: "POST" });
    expect(res.status).toBe(401);
    // Still listening: the process was not asked to exit.
    expect(server.listening).toBe(true);
  });

  it("rejects POST /api/shutdown from a hostile origin even with the token", async () => {
    const res = await raw("/api/shutdown", {
      method: "POST",
      headers: { ...auth(), Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(server.listening).toBe(true);
  });

  it("rejects DELETE /api/prompts/:id without a token", async () => {
    const added = await fetch(`${baseUrl}/api/prompts`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ targetServices: ["web"], prompt: "keep me" }),
    });
    const { id } = (await added.json()) as { id: string };

    const res = await raw(`/api/prompts/${id}`, { method: "DELETE" });
    expect(res.status).toBe(401);

    const list = await fetch(`${baseUrl}/api/prompts`, { headers: auth() });
    const { prompts } = (await list.json()) as { prompts: unknown[] };
    expect(prompts).toHaveLength(1);
  });

  it("401s every /api route when unauthenticated", async () => {
    const routes: Array<[string, string]> = [
      ["/api/architecture", "GET"],
      ["/api/prompts", "GET"],
      ["/api/prompts", "POST"],
      ["/api/prompts/p-001", "DELETE"],
      ["/api/shutdown", "POST"],
    ];
    for (const [path, method] of routes) {
      const res = await raw(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("token handoff", () => {
  it("puts the token in the fragment, never the query string", () => {
    const url = viewerUrl(4567, "abc123");
    expect(url).toBe("http://localhost:4567/#token=abc123");
    expect(url).not.toContain("?token=");
  });

  it("keeps non-secret viewer state in the query string", () => {
    const url = viewerUrl(4567, "abc123", "node=service:api");
    expect(url).toBe("http://localhost:4567/?node=service:api#token=abc123");
    // The fragment is after the query, and the query carries no secret.
    expect(url.split("#")[0]).toBe("http://localhost:4567/?node=service:api");
  });

  // NOTE (0017): two cases that used to live here are gone, and the rest of
  // this file is unchanged.
  //
  // "injects the bootstrap script into the viewer document" tested
  // `injectBootstrap`, and "attaches the bearer header to same-origin API
  // calls, and only those" executed that injected script in a fake `window`.
  // Both asserted the *mechanism* 0017 deletes: a server-side rewrite of the
  // HTML that monkey-patched `window.fetch`. The server no longer injects
  // anything, so there is nothing here to execute.
  //
  // The behaviour they asserted — same-origin API calls carry the bearer
  // header, cross-origin calls do not — did not weaken, it moved to where the
  // code moved. `tests/viewer/api-auth.test.ts` now asserts it against the
  // viewer's own `api/auth.ts`: same-origin gets `Bearer <token from the
  // fragment>`, cross-origin gets no header at all. The boundary cases in this
  // file that matter most are untouched: the bare-URL 401, the cross-origin
  // 403, and the loopback bind.
});
