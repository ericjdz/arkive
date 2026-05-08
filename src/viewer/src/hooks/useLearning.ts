import { useState, useCallback, useMemo, useEffect } from "react";
import type { Architecture } from "../../../schema/types.js";
import type { Question } from "../../../learning/types.js";
import { generateAllQuestions } from "../../../learning/questions.js";
import { extractConcepts } from "../../../learning/concepts.js";
import { recordAnswer, mergeNewConcepts, createInitialProgress } from "../../../learning/progress.shared.js";
import { saveLearningProgress } from "../api/learning.js";
import type { LearningProgress } from "../api/learning.js";

interface UseLearningResult {
  questions: Question[];
  currentQuestion: Question | null;
  progress: LearningProgress;
  answerQuestion: (correct: boolean) => void;
  nextQuestion: () => void;
  masteredCount: number;
  totalConcepts: number;
}

export function useLearning(
  architecture: Architecture,
  initialProgress: LearningProgress | null,
): UseLearningResult {
  const questions = useMemo(() => generateAllQuestions(architecture), [architecture]);
  const concepts = useMemo(() => extractConcepts(architecture), [architecture]);

  const [progress, setProgress] = useState<LearningProgress>(() => {
    const base = initialProgress ?? createInitialProgress(architecture.project.name);
    return mergeNewConcepts(base, concepts);
  });

  const [currentIndex, setCurrentIndex] = useState(0);

  // Filter to questions for unmastered concepts
  const unmasteredQuestions = useMemo(() => {
    const masteredIds = new Set(
      progress.concepts.filter((c) => c.mastered).map((c) => c.conceptId)
    );
    return questions.filter((q) => !masteredIds.has(q.conceptId));
  }, [questions, progress]);

  const currentQuestion = unmasteredQuestions[currentIndex] ?? null;

  const answerQuestion = useCallback(
    (correct: boolean) => {
      if (!currentQuestion) return;
      const concept = progress.concepts.find((c) => c.conceptId === currentQuestion.conceptId);
      const updated = recordAnswer(
        progress,
        currentQuestion.conceptId,
        concept?.label ?? currentQuestion.conceptId,
        currentQuestion.category,
        correct,
      );
      setProgress(updated);
    },
    [currentQuestion, progress],
  );

  const nextQuestion = useCallback(() => {
    setCurrentIndex((prev) => prev + 1);
  }, []);

  // Auto-save progress to server
  useEffect(() => {
    if (progress.totalQuestions > 0) {
      saveLearningProgress(progress).catch(() => {
        // Silently fail — progress is still in-memory
      });
    }
  }, [progress]);

  const masteredCount = progress.concepts.filter((c) => c.mastered).length;
  const totalConcepts = progress.concepts.length;

  return {
    questions,
    currentQuestion,
    progress,
    answerQuestion,
    nextQuestion,
    masteredCount,
    totalConcepts,
  };
}
