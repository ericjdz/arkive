import { describe, expect, it } from "vitest";
import { ARCHITECTURE_RESOURCES } from "../../src/server/resources.js";

describe("architecture resources", () => {
  it("includes hooks resource", () => {
    const hooks = ARCHITECTURE_RESOURCES.find((r) => r.uri === "architecture://hooks");
    expect(hooks).toBeDefined();
    expect(hooks!.name).toBe("architecture-hooks");
  });

  it("includes session context resource as markdown", () => {
    const sessionContext = ARCHITECTURE_RESOURCES.find((r) => r.uri === "architecture://session-context");
    expect(sessionContext).toBeDefined();
    expect(sessionContext!.name).toBe("architecture-session-context");
    expect(sessionContext!.mimeType).toBe("text/markdown");
  });
});
