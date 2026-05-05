/* @jsxRuntime classic */
import * as React from "../../../../node_modules/react/index.js";
import { QuestionCard } from "./QuestionCard.js";
import type { Question } from "../../../learning/types.js";

interface QuizPanelProps {
  questions: Question[];
  currentQuestion: Question | null;
  onAnswer: (correct: boolean) => void;
  onNext: () => void;
  questionNumber: number;
  totalQuestions: number;
}

export function QuizPanel({
  questions,
  currentQuestion,
  onAnswer,
  onNext,
  questionNumber,
  totalQuestions,
}: QuizPanelProps) {
  const [answered, setAnswered] = React.useState(false);

  const handleAnswer = (correct: boolean) => {
    setAnswered(true);
    onAnswer(correct);
  };

  const handleNext = () => {
    setAnswered(false);
    onNext();
  };

  if (!currentQuestion) {
    return (
      <div className="quiz-panel quiz-panel--complete">
        <h2>🎉 All concepts mastered!</h2>
        <p>You've demonstrated understanding of all architectural concepts in this project.</p>
      </div>
    );
  }

  return (
    <div className="quiz-panel">
      <div className="quiz-panel__header">
        <span className="quiz-panel__counter">
          Question {questionNumber} of {totalQuestions}
        </span>
        <span className="quiz-panel__category">{currentQuestion.category}</span>
      </div>
      <QuestionCard
        key={currentQuestion.id}
        question={currentQuestion}
        onAnswer={handleAnswer}
      />
      {answered && (
        <button className="quiz-panel__next" onClick={handleNext}>
          Next
        </button>
      )}
    </div>
  );
}
