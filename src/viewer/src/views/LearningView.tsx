import { QuizPanel } from "../components/QuizPanel.js";
import { ProgressTracker } from "../components/ProgressTracker.js";
import { ConceptMap } from "../components/ConceptMap.js";
import { useLearning } from "../hooks/useLearning.js";
import type { Architecture } from "../../../schema/types.js";
import type { LearningProgress } from "../../../learning/types.js";

interface LearningViewProps {
  architecture: Architecture;
  initialProgress: LearningProgress | null;
  onProgressUpdate?: (progress: LearningProgress) => void;
}

export function LearningView({
  architecture,
  initialProgress,
  onProgressUpdate,
}: LearningViewProps) {
  const {
    questions,
    currentQuestion,
    progress,
    answerQuestion,
    nextQuestion,
    masteredCount,
    totalConcepts,
  } = useLearning(architecture, initialProgress);

  const handleAnswer = (correct: boolean) => {
    answerQuestion(correct);
    onProgressUpdate?.(progress);
  };

  // Find the index of the current question among unmastered ones
  const masteredIds = new Set(
    progress.concepts.filter((c) => c.mastered).map((c) => c.conceptId)
  );
  const unmasteredQuestions = questions.filter((q) => !masteredIds.has(q.conceptId));
  const currentIndex = currentQuestion
    ? unmasteredQuestions.indexOf(currentQuestion) + 1
    : unmasteredQuestions.length + 1;

  return (
    <div className="learning-view">
      <div className="learning-view__sidebar">
        <ProgressTracker progress={progress} />
        <ConceptMap concepts={progress.concepts} />
      </div>
      <div className="learning-view__main">
        <QuizPanel
          questions={questions}
          currentQuestion={currentQuestion}
          onAnswer={handleAnswer}
          onNext={nextQuestion}
          questionNumber={currentIndex}
          totalQuestions={unmasteredQuestions.length}
        />
      </div>
    </div>
  );
}
