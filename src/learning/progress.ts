import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LearningProgress, ConceptMastery, QuestionCategory } from "./types.js";
import type { ExtractedConcept } from "./concepts.js";

export const PROGRESS_DIR = ".arkive";
export const PROGRESS_FILENAME = "learning-progress.json";

export function readProgress(projectRoot: string): LearningProgress | null {
  const filePath = join(projectRoot, PROGRESS_DIR, PROGRESS_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as LearningProgress;
}

export function writeProgress(projectRoot: string, progress: LearningProgress): void {
  const dir = join(projectRoot, PROGRESS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, PROGRESS_FILENAME);
  writeFileSync(filePath, JSON.stringify(progress, null, 2));
}

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
  const currentIds = new Set(currentConcepts.map((c) => c.id));
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
