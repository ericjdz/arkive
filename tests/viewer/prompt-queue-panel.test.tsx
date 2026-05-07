// tests/viewer/prompt-queue-panel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "../../src/viewer/node_modules/react/index.js";
import { act } from "../../src/viewer/node_modules/react-dom/test-utils.js";
import { createRoot } from "../../src/viewer/node_modules/react-dom/client.js";
import { PromptQueuePanel } from "../../src/viewer/src/components/PromptQueuePanel.js";

describe("PromptQueuePanel", () => {
  it("renders toggle button when no prompts and panel is closed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(PromptQueuePanel, {
          prompts: [],
          isOpen: false,
          onToggle: vi.fn(),
          onRemove: vi.fn(),
          onCopyAll: vi.fn(),
        })
      );
    });
    expect(container.querySelector("[data-testid='queue-toggle']")).toBeDefined();
  });

  it("displays prompts when open", () => {
    const prompts = [
      { id: "p-001", targetServices: ["web"], prompt: "Add dark mode", status: "pending" as const, createdAt: "2026-05-07T00:00:00.000Z" },
      { id: "p-002", targetServices: ["api"], prompt: "Add caching", status: "pending" as const, createdAt: "2026-05-07T00:01:00.000Z" },
    ];
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(PromptQueuePanel, {
          prompts,
          isOpen: true,
          onToggle: vi.fn(),
          onRemove: vi.fn(),
          onCopyAll: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain("Add dark mode");
    expect(container.textContent).toContain("Add caching");
    expect(container.textContent).toContain("2 prompts");
  });

  it("calls onRemove when delete button is clicked", () => {
    const onRemove = vi.fn();
    const prompts = [
      { id: "p-001", targetServices: ["web"], prompt: "Test", status: "pending" as const, createdAt: "2026-05-07T00:00:00.000Z" },
    ];
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(PromptQueuePanel, {
          prompts,
          isOpen: true,
          onToggle: vi.fn(),
          onRemove,
          onCopyAll: vi.fn(),
        })
      );
    });

    const deleteBtn = container.querySelector("[data-testid='remove-p-001']") as HTMLButtonElement;
    act(() => deleteBtn.click());
    expect(onRemove).toHaveBeenCalledWith("p-001");
  });
});
