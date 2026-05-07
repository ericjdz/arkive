import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ARKIVE_DIR } from "./architecture-file.js";
import { PromptQueueSchema } from "../schema/prompt-queue.js";
import type { PromptQueue, QueuedPrompt } from "../schema/prompt-queue.js";

export const PROMPT_QUEUE_FILENAME = "prompt-queue.json";

export type QueueReadResult =
  | { success: true; data: PromptQueue }
  | { success: false; error: string };

export type PromptResult =
  | { success: true; data: QueuedPrompt }
  | { success: false; error: string };

export type ClaimResult =
  | { success: true; data: QueuedPrompt | null }
  | { success: false; error: string };

export function promptQueuePath(dir: string): string {
  return join(dir, ARKIVE_DIR, PROMPT_QUEUE_FILENAME);
}

export function createEmptyQueue(): PromptQueue {
  return { version: "1.0.0", prompts: [] };
}

export function readPromptQueue(dir: string): QueueReadResult {
  const path = promptQueuePath(dir);
  if (!existsSync(path)) {
    return { success: true, data: createEmptyQueue() };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { success: false, error: `Failed to read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { success: false, error: `Failed to parse ${path}: ${(err as Error).message}` };
  }

  const validation = PromptQueueSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      success: false,
      error: `prompt-queue.json validation failed: ${validation.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  return { success: true, data: validation.data };
}

export function writePromptQueue(
  dir: string,
  queue: PromptQueue
): { success: true; data: PromptQueue } | { success: false; error: string } {
  const validation = PromptQueueSchema.safeParse(queue);
  if (!validation.success) {
    return {
      success: false,
      error: `Invalid queue data: ${validation.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  const path = promptQueuePath(dir);
  mkdirSync(join(dir, ARKIVE_DIR), { recursive: true });

  try {
    writeFileSync(path, JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
  } catch (err) {
    return { success: false, error: `Failed to write ${path}: ${(err as Error).message}` };
  }

  return { success: true, data: validation.data };
}

function nextPromptId(prompts: QueuedPrompt[]): string {
  let max = 0;
  for (const p of prompts) {
    const m = /^p-(\d+)$/.exec(p.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `p-${String(max + 1).padStart(3, "0")}`;
}

export function addPrompt(
  dir: string,
  targetServices: string[],
  prompt: string
): PromptResult {
  const read = readPromptQueue(dir);
  if (!read.success) return read;

  const queue = read.data;
  const now = new Date().toISOString();
  const newPrompt: QueuedPrompt = {
    id: nextPromptId(queue.prompts),
    targetServices,
    prompt,
    status: "pending",
    createdAt: now,
  };

  queue.prompts.push(newPrompt);
  const write = writePromptQueue(dir, queue);
  if (!write.success) return write;

  return { success: true, data: newPrompt };
}

export function claimNextPrompt(
  dir: string,
  agent?: string
): ClaimResult {
  const read = readPromptQueue(dir);
  if (!read.success) return read;

  const queue = read.data;
  const pending = queue.prompts.find((p) => p.status === "pending");
  if (!pending) return { success: true, data: null };

  pending.status = "claimed";
  pending.claimedAt = new Date().toISOString();
  if (agent) pending.agent = agent;

  const write = writePromptQueue(dir, queue);
  if (!write.success) return write;

  return { success: true, data: pending };
}

export function ackPrompt(
  dir: string,
  promptId: string
): { success: true } | { success: false; error: string } {
  const read = readPromptQueue(dir);
  if (!read.success) return read;

  const queue = read.data;
  const prompt = queue.prompts.find((p) => p.id === promptId);
  if (!prompt) return { success: false, error: `Prompt ${promptId} not found` };
  if (prompt.status !== "claimed") return { success: false, error: `Prompt ${promptId} is ${prompt.status}, expected claimed` };

  prompt.status = "done";
  prompt.completedAt = new Date().toISOString();

  const write = writePromptQueue(dir, queue);
  if (!write.success) return write;

  return { success: true };
}

export function failPrompt(
  dir: string,
  promptId: string
): { success: true } | { success: false; error: string } {
  const read = readPromptQueue(dir);
  if (!read.success) return read;

  const queue = read.data;
  const prompt = queue.prompts.find((p) => p.id === promptId);
  if (!prompt) return { success: false, error: `Prompt ${promptId} not found` };
  if (prompt.status !== "claimed") return { success: false, error: `Prompt ${promptId} is ${prompt.status}, expected claimed` };

  prompt.status = "failed";
  prompt.completedAt = new Date().toISOString();

  const write = writePromptQueue(dir, queue);
  if (!write.success) return write;

  return { success: true };
}

export function listPendingPrompts(dir: string): QueuedPrompt[] {
  const read = readPromptQueue(dir);
  if (!read.success) return [];
  return read.data.prompts.filter((p) => p.status === "pending");
}
