// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "../../src/viewer/node_modules/react/index.js";
import { act } from "../../src/viewer/node_modules/react-dom/test-utils.js";
import { createRoot } from "../../src/viewer/node_modules/react-dom/client.js";
import { TopologyView } from "../../src/viewer/src/views/TopologyView.js";

// React Flow requires ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const MOCK_DATA = {
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
