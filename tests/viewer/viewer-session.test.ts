import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { handleOpenViewer } from "../../src/server/tools.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";
import { fetchArchitecture } from "../../src/viewer/src/api/architecture.js";
import { fetchPromptQueue, submitPrompt } from "../../src/viewer/src/api/prompts.js";
import { fetchLearningProgress, saveLearningProgress } from "../../src/viewer/src/api/learning.js";
import { apiFetch, viewerToken } from "../../src/viewer/src/api/auth.js";

/**
 * End-to-end: the URL the MCP `open_viewer` tool hands a user, driven by the
 * real viewer API modules against a real server.
 *
 * The browser is stood in for by three globals the viewer's `api/auth.ts` reads
 * (`location`, `history`, `sessionStorage`) plus a `fetch` that resolves
 * relative URLs against `location.href` — which is what a browser does. No
 * viewer code, server code or token is stubbed.
 */

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  clear(): void;
}

const realFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;

function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    clear: () => map.clear(),
  };
}

/**
 * Load the viewer the way a browser would for `url`: the fragment is in the
 * address bar, nothing has read it yet, and the tab has no memory of a token.
 *
 * `tab` models the tab's sessionStorage, which — unlike the page — survives a
 * reload. Pass the same one to `loadViewerAt` twice to model a reload.
 */
function loadViewerAt(
  url: string,
  tab: FakeStorage
): { sent: Array<Record<string, string>> } {
  const parsed = new URL(url);
  const sent: Array<Record<string, string>> = [];
  const storage = tab;
  const location = {
    href: `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
  const history = {
    replaceState(_state: unknown, _title: string, next?: string) {
      const target = new URL(next ?? "/", location.origin);
      location.pathname = target.pathname;
      location.search = target.search;
      location.hash = target.hash;
      location.href = `${location.origin}${target.pathname}${target.search}${target.hash}`;
    },
  };

  globals.location = location;
  globals.history = history;
  globals.sessionStorage = storage;
  globals.fetch = ((input: string, init?: RequestInit) => {
    if (init?.headers) sent.push(Object.fromEntries(new Headers(init.headers).entries()));
    return realFetch(new URL(String(input), location.href), init);
  }) as unknown as typeof fetch;

  return { sent };
}

/** Back to a browser that has never seen a token. */
function forgetViewer(): void {
  delete globals.location;
  delete globals.history;
  delete globals.sessionStorage;
  globals.fetch = realFetch;
}

describe("open_viewer URL drives a working authenticated viewer", () => {
  let tempDir: string;
  let port: number;
  let viewerUrl: string;
  let token: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-e2e-"));
    const arch = createEmptyArchitecture("e2e-project", "End to end");
    arch.services.push({
      id: "web",
      name: "Web",
      type: "frontend",
      technology: "React",
      description: "The viewer",
      dependencies: [],
    });
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
    writeFileSync(join(tempDir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2), "utf-8");

    port = 48000 + Math.floor(Math.random() * 1000);
    const result = await handleOpenViewer(tempDir, { port });
    if (result.isError) throw new Error(result.content[0].text);
    viewerUrl = (JSON.parse(result.content[0].text) as { url: string }).url;
    token = new URL(viewerUrl).hash.replace(/^#token=/, "");
  });

  afterEach(forgetViewer);

  afterAll(() => {
    forgetViewer();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("puts the run's token in the URL fragment, never the query string", () => {
    expect(viewerUrl).toBe(`http://localhost:${port}/#token=${token}`);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(viewerUrl.split("#")[0]).toBe(`http://localhost:${port}/`);
  });

  it("renders: the viewer loads the real architecture through the real API", async () => {
    const { sent } = loadViewerAt(viewerUrl, fakeStorage());

    const architecture = await fetchArchitecture();

    expect(architecture.project.name).toBe("e2e-project");
    expect(architecture.services.map((s) => s.id)).toContain("web");
    expect(sent).toHaveLength(1);
    expect(sent[0].authorization).toBe(`Bearer ${token}`);
    // The viewer strips the fragment as it reads it.
    expect((globals.location as { hash: string }).hash).toBe("");
  });

  it("round-trips a write and a read through the viewer, token attached to both", async () => {
    const { sent } = loadViewerAt(viewerUrl, fakeStorage());

    const queued = await submitPrompt(["web"], "split the viewer api module");
    const queue = await fetchPromptQueue();

    expect(queued.prompt).toBe("split the viewer api module");
    expect(queue.prompts.map((p) => p.id)).toContain(queued.id);
    expect(sent.map((h) => h.authorization)).toEqual([sent[0].authorization, sent[0].authorization]);
    expect(sent.every((h) => h.authorization === `Bearer ${token}`)).toBe(true);
  });

  it("survives a reload of the fragment-less URL", async () => {
    const tab = fakeStorage();
    loadViewerAt(viewerUrl, tab);
    await fetchArchitecture(); // reads the fragment, strips it, remembers it

    // Reload: same tab, address bar now has no token in it.
    const reloadUrl = viewerUrl.split("#")[0];
    const { sent } = loadViewerAt(reloadUrl, tab);

    const architecture = await fetchArchitecture();

    expect(architecture.project.name).toBe("e2e-project");
    expect(sent[0].authorization).toBe(`Bearer ${token}`);
  });

  it("has no browser dependency at import time: this file is a Node process", async () => {
    // Proves the viewer module does not need a DOM to load — it read globals at
    // call time, not import time — and that with no browser there is no token.
    expect(typeof globalThis.location).toBe("undefined");
    expect(viewerToken()).toBeNull();

    const seen: RequestInit[] = [];
    const stubbed = vi.fn((_input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("{}"));
    });
    globals.fetch = stubbed;
    await apiFetch("/api/architecture");
    expect(new Headers(seen[0].headers).get("Authorization")).toBeNull();
  });

  it("401s a viewer that never had the token, rather than quietly working", async () => {
    loadViewerAt(`http://localhost:${port}/`, fakeStorage());

    await expect(fetchArchitecture()).rejects.toThrow(/401/);
  });

  it("saves and reads learning progress with the token attached", async () => {
    const { sent } = loadViewerAt(viewerUrl, fakeStorage());

    expect(await fetchLearningProgress()).toBeNull();
    await saveLearningProgress({
      projectName: "e2e-project",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:01:00.000Z",
      concepts: [],
      totalQuestions: 1,
      correctAnswers: 1,
    });

    expect((await fetchLearningProgress())?.correctAnswers).toBe(1);
    expect(sent.every((h) => h.authorization === `Bearer ${token}`)).toBe(true);
  });

  it("is refused by the server when a hostile page sends the token cross-origin", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "localhost",
          port,
          path: "/api/architecture",
          headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(403);
  });
});