// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TopologyView } from "../../src/viewer/src/views/TopologyView.js";
import type { Connection, Decision, Service } from "../../src/viewer/src/api/architecture.js";

// React Flow requires ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const MOCK_DATA: {
  services: Service[];
  connections: Connection[];
  decisions: Decision[];
} = {
  services: [
    { id: "web", name: "Web Client", type: "frontend", technology: "Next.js", description: "UI", dependencies: ["api"] },
    { id: "api", name: "API Server", type: "backend", technology: "Express", description: "REST API", dependencies: [] },
  ],
  connections: [
    { from: "web", to: "api", protocol: "HTTP/REST", description: "API calls" },
  ],
  decisions: [],
};

describe("TopologyView", () => {
  it("renders without crashing", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(TopologyView, {
          services: MOCK_DATA.services,
          connections: MOCK_DATA.connections,
          decisions: MOCK_DATA.decisions,
        })
      );
    });
    expect(container.querySelector(".react-flow")).toBeDefined();
  });

  it("creates nodes for each service", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(TopologyView, {
          services: MOCK_DATA.services,
          connections: MOCK_DATA.connections,
          decisions: MOCK_DATA.decisions,
        })
      );
    });
    expect(container.textContent).toContain("Web Client");
  });
});
