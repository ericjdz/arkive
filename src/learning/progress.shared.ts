import type { LearningProgress, ConceptMastery, QuestionCategory } from "./types.js";
import type { ExtractedConcept } from "./concepts.js";

export function createInitialProgress(projectName: string): LearningProgress {
  const now = new Date().toISOString();
  return {
    projectName,
    startedAt: now,
    lastActivityAt: now,
    concepts: [],
    totalQuestions: 0,
    correctAnswers: 0,
  };
}

export function recordAnswer(
  progress: LearningProgress,
  conceptId: string,
  label: string,
  category: QuestionCategory,
  correct: boolean,
): LearningProgress {
  const now = new Date().toISOString();
  const existing = progress.concepts.find((c) => c.conceptId === conceptId);

  if (existing) {
    existing.attempts += 1;
    existing.lastAttemptAt = now;
    if (correct) {
      existing.mastered = true;
    }
  } else {
    progress.concepts.push({
      conceptId,
      label,
      category,
      mastered: correct,
      attempts: 1,
      lastAttemptAt: now,
    });
  }

  progress.totalQuestions += 1;
  if (correct) {
    progress.correctAnswers += 1;
  }
  progress.lastActivityAt = now;

  return { ...progress, concepts: [...progress.concepts] };
}

export function mergeNewConcepts(
  progress: LearningProgress,
  currentConcepts: ExtractedConcept[],
): LearningProgress {
  const existingMap = new Map(progress.concepts.map((c) => [c.conceptId, c]));

  const merged: ConceptMastery[] = [];

  for (const concept of currentConcepts) {
    const existing = existingMap.get(concept.id);
    if (existing) {
      merged.push(existing);
    } else {
      merged.push({
        conceptId: concept.id,
        label: concept.label,
        category: concept.category,
        mastered: false,
        attempts: 0,
        lastAttemptAt: "",
      });
    }
  }

  return {
    ...progress,
    concepts: merged,
    lastActivityAt: new Date().toISOString(),
  };
}
