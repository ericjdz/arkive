import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLearnCommand } from "../../src/cli/commands/learn.js";
import { Command } from "commander";

// Mock the open module
vi.mock("open", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

describe("learn command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.addCommand(createLearnCommand());
  });

  it("registers as 'learn' command", () => {
    const cmd = program.commands.find((c) => c.name() === "learn");
    expect(cmd).toBeDefined();
  });

  it("has a description", () => {
    const cmd = program.commands.find((c) => c.name() === "learn");
    expect(cmd!.description()).toContain("Learning Mode");
  });

  it("accepts --port option", () => {
    const cmd = program.commands.find((c) => c.name() === "learn");
    const portOption = cmd!.options.find((o) => o.long === "--port");
    expect(portOption).toBeDefined();
  });

  it("accepts --no-open option", () => {
    const cmd = program.commands.find((c) => c.name() === "learn");
    const noOpenOption = cmd!.options.find((o) => o.long === "--no-open");
    expect(noOpenOption).toBeDefined();
  });
});
