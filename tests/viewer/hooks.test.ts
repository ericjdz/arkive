// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useArchitecture } from "../../src/viewer/src/hooks/useArchitecture.js";

const MOCK_ARCHITECTURE = {
  version: "1.0.0",
  project: {
    name: "my-chat-app",
    description: "Real-time chat application",
    created: "2026-05-05T00:00:00Z",
    lastUpdated: "2026-05-05T12:00:00Z",
  },
  stack: {
    language: ["TypeScript"],
    runtime: ["Node.js", "Browser"],
    framework: ["Next.js"],
    database: ["PostgreSQL"],
    infrastructure: ["Vercel", "Supabase"],
  },
  services: [
    {
      id: "web-client",
      name: "Web Client",
      type: "frontend",
      technology: "Next.js",
      description: "Server-rendered React app with real-time chat UI",
      ports: ["3000"],
      dependencies: ["api-server", "websocket-server"],
    },
    {
      id: "api-server",
      name: "REST API",
      type: "backend",
      technology: "Next.js API Routes",
      description: "Handles auth, CRUD, business logic",
      dependencies: ["database"],
    },
    {
      id: "database",
      name: "PostgreSQL",
      type: "database",
      technology: "PostgreSQL via Supabase",
      description: "Persistent storage for users, messages, channels",
      dependencies: [],
    },
  ],
  connections: [
    {
      from: "web-client",
      to: "api-server",
      protocol: "HTTP/REST",
      description: "Auth, channel management, message history",
    },
  ],
  decisions: [
    {
      id: "dec-001",
      topic: "Database Choice",
      decision: "PostgreSQL over MongoDB",
      rationale: "Relational data model fits chat",
      alternatives: [{ name: "MongoDB", whyNot: "Document model adds complexity" }],
      timestamp: "2026-05-05T01:00:00Z",
      relatedServices: ["database"],
    },
  ],
  dataFlows: [
    {
      name: "User sends a message",
      steps: [
        { actor: "web-client", action: "User types message, hits send" },
        { actor: "api-server", action: "Validates and persists" },
      ],
    },
  ],
  history: [
    {
      timestamp: "2026-05-05T00:30:00Z",
      action: "initial_scaffold",
      summary: "Project initialized",
    },
  ],
};

describe("useArchitecture", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_ARCHITECTURE),
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches architecture data on mount", async () => {
    const { result } = renderHook(() => useArchitecture());
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeDefined();
    expect(result.current.data!.project.name).toBe("my-chat-app");
    expect(result.current.data!.services).toHaveLength(3);
  });

  it("sets error when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    const { result } = renderHook(() => useArchitecture());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeDefined();
    expect(result.current.data).toBeNull();
  });

  it("search filters services by name or description", async () => {
    const { result } = renderHook(() => useArchitecture());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setSearchQuery("REST");
    });

    expect(result.current.searchResults.services).toHaveLength(1);
    expect(result.current.searchResults.services[0].id).toBe("api-server");
  });

  it("search filters decisions by topic or decision text", async () => {
    const { result } = renderHook(() => useArchitecture());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setSearchQuery("Database");
    });

    expect(result.current.searchResults.decisions).toHaveLength(1);
    expect(result.current.searchResults.decisions[0].id).toBe("dec-001");
  });
});
