export interface ConceptMastery {
  conceptId: string;
  label: string;
  category: "decision" | "topology" | "data-flow" | "connection" | "stack";
  mastered: boolean;
  attempts: number;
  lastAttemptAt: string;
}

export interface LearningProgress {
  projectName: string;
  startedAt: string;
  lastActivityAt: string;
  concepts: ConceptMastery[];
  totalQuestions: number;
  correctAnswers: number;
}

export async function fetchLearningProgress(): Promise<LearningProgress | null> {
  const response = await fetch("/api/learning/progress");
  if (!response.ok) {
    throw new Error(`Failed to fetch learning progress: ${response.status}`);
  }
  return response.json();
}

export async function saveLearningProgress(progress: LearningProgress): Promise<void> {
  const response = await fetch("/api/learning/progress", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(progress),
  });
  if (!response.ok) {
    throw new Error(`Failed to save learning progress: ${response.status}`);
  }
}
