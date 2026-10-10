// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TreeView } from "../../src/viewer/src/views/TreeView.js";
import type { Service } from "../../src/viewer/src/api/architecture.js";

const SERVICES: Service[] = [
  { id: "web", name: "Web Client", type: "frontend", technology: "Next.js", description: "UI", dependencies: ["api"] },
  { id: "api", name: "API Server", type: "backend", technology: "Express", description: "REST API", dependencies: ["db"] },
  { id: "ws", name: "WebSocket", type: "backend", technology: "Socket.io", description: "Real-time", dependencies: ["db"] },
  { id: "db", name: "PostgreSQL", type: "database", technology: "Supabase", description: "Storage", dependencies: [] },
];

function renderTree(services: typeof SERVICES) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(React.createElement(TreeView, { services }));
  });
  return container;
}

describe("TreeView", () => {
  it("groups services by type", () => {
    const container = renderTree(SERVICES);
    expect(container.textContent).toContain("frontend");
    expect(container.textContent).toContain("backend");
    expect(container.textContent).toContain("database");
  });

  it("shows service names", () => {
    const container = renderTree(SERVICES);
    expect(container.textContent).toContain("Web Client");
    expect(container.textContent).toContain("API Server");
  });

  it("shows technology for each service", () => {
    const container = renderTree(SERVICES);
    expect(container.textContent).toContain("Next.js");
    expect(container.textContent).toContain("Express");
  });

  it("renders empty state when no services", () => {
    const container = renderTree([] as typeof SERVICES);
    expect(container.textContent).toMatch(/no services/i);
  });
});
