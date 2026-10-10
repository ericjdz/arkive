import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOpenViewer } from "../../src/server/tools.js";
import { createEmptyArchitecture } from "../../src/schema/validate.js";

/**
 * The tool's job is to hand back a URL a human can paste into a browser. Since
 * 0016 that URL must carry the run's bearer token or every panel 401s, so this
 * asserts the shape *and* that the token in the fragment is the one the live
 * server accepts. See docs/issues/0017-close-auth-followups.md.
 */
describe("open_viewer MCP tool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "arkive-viewer-test-"));
    const arch = createEmptyArchitecture("test", "test");
    mkdirSync(join(tempDir, "arkive"), { recursive: true });
    writeFileSync(join(tempDir, "arkive", "architecture.json"), JSON.stringify(arch, null, 2), "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error when architecture.json is missing", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "arkive-viewer-empty-"));
    const result = await handleOpenViewer(emptyDir, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("architecture.json");

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns a URL with specified port", async () => {
    // Use a random high port to avoid conflicts
    const port = 49000 + Math.floor(Math.random() * 1000);
    const result = await handleOpenViewer(tempDir, { port });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.url.startsWith(`http://localhost:${port}/#token=`)).toBe(true);
    expect(body.port).toBe(port);
    expect(body.alreadyRunning).toBe(false);

    // Cleanup: we need to close the server. Since activeViewerServer is module-level,
    // we import and use resetActiveViewer if available, or just let the process clean up
  });

  it("puts the token in the fragment, and that token opens the API", async () => {
    const port = 49500 + Math.floor(Math.random() * 400);
    const result = await handleOpenViewer(tempDir, { port });
    const { url } = JSON.parse(result.content[0].text) as { url: string };

    // The secret is after the `#`, which no browser transmits to a server.
    expect(url.split("#")[0]).toBe(`http://localhost:${port}/`);
    const token = new URL(url).hash.replace(/^#token=/, "");
    expect(token).toMatch(/^[0-9a-f]{48}$/);

    const authorized = await fetch(`http://localhost:${port}/api/architecture`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
    expect(((await authorized.json()) as { project: { name: string } }).project.name).toBe("test");

    // The regression 0017 closes: the bare URL that used to work now 401s.
    const bare = await fetch(`http://localhost:${port}/api/architecture`);
    expect(bare.status).toBe(401);
  });

  it("returns the same authenticated URL when the viewer is already running", async () => {
    const port = 49800 + Math.floor(Math.random() * 150);
    const first = JSON.parse((await handleOpenViewer(tempDir, { port })).content[0].text);
    const second = JSON.parse((await handleOpenViewer(tempDir, { port })).content[0].text);

    expect(second.alreadyRunning).toBe(true);
    // Same URL, so a second caller does not 401 on a URL with no token in it.
    expect(second.url).toBe(first.url);

    const { status } = await fetch(`http://localhost:${port}/api/architecture`, {
      headers: { Authorization: `Bearer ${new URL(second.url).hash.replace(/^#token=/, "")}` },
    });
    expect(status).toBe(200);
  });
});