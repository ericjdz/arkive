// src/viewer/src/api/prompts.ts

import { apiFetch } from "./auth.js";

export interface QueuedPrompt {
  id: string;
  targetServices: string[];
  prompt: string;
  status: "pending" | "claimed" | "done" | "failed";
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  agent?: string;
}

export interface PromptQueue {
  version: string;
  prompts: QueuedPrompt[];
}

export async function fetchPromptQueue(): Promise<PromptQueue> {
  const response = await apiFetch("/api/prompts");
  if (!response.ok) {
    throw new Error(`Failed to fetch prompts: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function submitPrompt(
  targetServices: string[],
  prompt: string
): Promise<QueuedPrompt> {
  const response = await apiFetch("/api/prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetServices, prompt }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to submit prompt: ${response.status}`);
  }
  return response.json();
}

export async function deletePrompt(id: string): Promise<void> {
  const response = await apiFetch(`/api/prompts/${id}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Failed to delete prompt: ${response.status}`);
  }
}

export function formatPromptsForClipboard(
  prompts: QueuedPrompt[],
  projectName: string
): string {
  if (prompts.length === 0) return "";

  const lines = [
    `# Architecture Change Prompts — ${projectName}`,
    `Generated from arkive viewer on ${new Date().toISOString()}`,
    "",
  ];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const scope = p.targetServices.length > 0
      ? `[${p.targetServices.join(", ")}]`
      : "[global]";
    lines.push(`## ${i + 1}. ${scope}`);
    lines.push(p.prompt);
    lines.push("");
  }

  lines.push("---");
  lines.push("Execute these prompts in order. After each, update arkive/architecture.json.");

  return lines.join("\n");
}
