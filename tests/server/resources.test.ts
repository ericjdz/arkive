import { describe, expect, it } from "vitest";
import { ARCHITECTURE_RESOURCES } from "../../src/server/resources.js";

describe("architecture resources", () => {
  it("includes hooks resource", () => {
    const hooks = ARCHITECTURE_RESOURCES.find((r) => r.uri === "architecture://hooks");
    expect(hooks).toBeDefined();
    expect(hooks!.name).toBe("architecture-hooks");
  });
});
