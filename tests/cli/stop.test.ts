import { describe, it, expect } from "vitest";
import { stopViewer } from "../../src/cli/commands/stop.js";

describe("stopViewer", () => {
  it("does not throw when no process is running", () => {
    expect(() => stopViewer({ port: 59999 })).not.toThrow();
  });
});
