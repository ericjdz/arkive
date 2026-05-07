import { z } from "zod";

export const PromptStatus = z.enum(["pending", "claimed", "done", "failed"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const QueuedPromptSchema = z.object({
  id: z.string().min(1),
  targetServices: z.array(z.string()),
  prompt: z.string().min(1),
  status: PromptStatus,
  createdAt: z.string().datetime(),
  claimedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  agent: z.string().optional(),
});
export type QueuedPrompt = z.infer<typeof QueuedPromptSchema>;

export const PromptQueueSchema = z.object({
  version: z.string(),
  prompts: z.array(QueuedPromptSchema),
});
export type PromptQueue = z.infer<typeof PromptQueueSchema>;
