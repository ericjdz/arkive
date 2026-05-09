// src/viewer/src/hooks/usePromptQueue.ts
import { useState, useCallback } from "react";
import {
  fetchPromptQueue,
  submitPrompt,
  deletePrompt,
  formatPromptsForClipboard,
} from "../api/prompts.js";
import type { QueuedPrompt } from "../api/prompts.js";

export interface UsePromptQueueResult {
  prompts: QueuedPrompt[];
  loading: boolean;
  error: string | null;
  addPrompt: (targetServices: string[], prompt: string) => Promise<void>;
  removePrompt: (id: string) => Promise<void>;
  copyAllToClipboard: (projectName: string) => Promise<void>;
  refresh: () => Promise<void>;
  pendingCount: number;
}

export function usePromptQueue(): UsePromptQueueResult {
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queue = await fetchPromptQueue();
      setPrompts(queue.prompts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const addPrompt = useCallback(async (targetServices: string[], prompt: string) => {
    try {
      const newPrompt = await submitPrompt(targetServices, prompt);
      setPrompts((prev) => [...prev, newPrompt]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const removePrompt = useCallback(async (id: string) => {
    try {
      await deletePrompt(id);
      setPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const copyAllToClipboard = useCallback(async (projectName: string) => {
    const pending = prompts.filter((p) => p.status === "pending");
    const text = formatPromptsForClipboard(pending, projectName);
    await navigator.clipboard.writeText(text);
  }, [prompts]);

  const pendingCount = prompts.filter((p) => p.status === "pending").length;

  return {
    prompts,
    loading,
    error,
    addPrompt,
    removePrompt,
    copyAllToClipboard,
    refresh,
    pendingCount,
  };
}
