// tests/viewer/prompt-input.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PromptInput } from "../../src/viewer/src/components/PromptInput.js";

describe("PromptInput", () => {
  it("renders without crashing", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(PromptInput, {
          serviceId: "web",
          serviceName: "Web Client",
          onSubmit: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain("Add prompt for Web Client");
  });

  it("calls onSubmit with input text when button is clicked", () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        React.createElement(PromptInput, {
          serviceId: "web",
          serviceName: "Web Client",
          onSubmit,
        })
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const button = container.querySelector("button[data-testid='submit-prompt']") as HTMLButtonElement;

    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      nativeInputValueSetter?.call(textarea, "Add dark mode");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      button.click();
    });

    expect(onSubmit).toHaveBeenCalledWith("Add dark mode");
  });
});
